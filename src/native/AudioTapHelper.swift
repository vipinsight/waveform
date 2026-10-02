// Waveform system-audio tap.
//
// Records what the Mac is playing -- the other side of a call -- through a
// Core Audio process tap, and streams it to the app as raw PCM. A sidecar
// rather than a library for the same reason as the hotkey helper: the tap is
// a macOS 14.2 API reached most plainly from Swift, and a crash in it should
// end a recording's remote track, not the app.
//
// Protocol
//   stdout   raw little-endian Float32 mono samples, at the rate announced
//            in the ready line, from the moment the tap starts until exit
//   stderr   newline-delimited JSON:
//            {"type":"ready","sampleRate":48000}
//            {"type":"error","reason":"unsupported"|"denied"|"…"}
//   stdin    closed by the parent to stop; the helper also stops on SIGTERM
//
// The samples are mixed down to mono here. The tap hands over stereo at the
// output device's rate; the app resamples for the engine, as it already does
// for the microphone, so no rate conversion happens in this process.

import AVFoundation
import CoreAudio
import Foundation

private func status(_ payload: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: payload),
    let line = String(data: data, encoding: .utf8)
  else { return }
  FileHandle.standardError.write((line + "\n").data(using: .utf8)!)
}

private func fail(_ reason: String) -> Never {
  status(["type": "error", "reason": reason])
  exit(1)
}

/// Samples wait here between the realtime callback and the pipe. Writing to
/// a pipe from the IO thread would stall the audio device whenever the
/// parent was slow to read.
private final class Outbox {
  private let lock = NSLock()
  private var pending = Data()

  func push(_ data: Data) {
    lock.lock()
    pending.append(data)
    lock.unlock()
  }

  func drain() -> Data {
    lock.lock()
    defer { lock.unlock() }
    let out = pending
    pending = Data()
    return out
  }
}

@available(macOS 14.2, *)
private final class SystemTap {
  private var tapID = AudioObjectID(kAudioObjectUnknown)
  private var aggregateID = AudioObjectID(kAudioObjectUnknown)
  private var procID: AudioDeviceIOProcID?
  private let outbox = Outbox()
  private let debug = Debug()
  private var format = AudioStreamBasicDescription()

  func start() throws -> Double {
    // Everything the Mac plays, from every process. Private so it is not
    // listed as a device anyone else could pick up.
    let description = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
    description.name = "Waveform meeting tap"
    description.uuid = UUID()
    description.muteBehavior = .unmuted
    description.isPrivate = true
    description.isExclusive = false

    var tap = AudioObjectID(kAudioObjectUnknown)
    var err = AudioHardwareCreateProcessTap(description, &tap)
    guard err == noErr else { throw TapError("tap: \(err)") }
    tapID = tap

    var formatAddress = AudioObjectPropertyAddress(
      mSelector: kAudioTapPropertyFormat,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain)
    var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
    err = AudioObjectGetPropertyData(tapID, &formatAddress, 0, nil, &size, &format)
    guard err == noErr else { throw TapError("tap format: \(err)") }

    let outputUID = try defaultOutputUID()
    let aggregate: [String: Any] = [
      kAudioAggregateDeviceNameKey as String: "Waveform meeting",
      kAudioAggregateDeviceUIDKey as String: UUID().uuidString,
      kAudioAggregateDeviceMainSubDeviceKey as String: outputUID,
      kAudioAggregateDeviceIsPrivateKey as String: true,
      kAudioAggregateDeviceIsStackedKey as String: false,
      kAudioAggregateDeviceTapAutoStartKey as String: true,
      kAudioAggregateDeviceSubDeviceListKey as String: [
        [kAudioSubDeviceUIDKey as String: outputUID]
      ],
      kAudioAggregateDeviceTapListKey as String: [
        [
          kAudioSubTapDriftCompensationKey as String: true,
          kAudioSubTapUIDKey as String: description.uuid.uuidString,
        ]
      ],
    ]
    err = AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &aggregateID)
    guard err == noErr else { throw TapError("aggregate: \(err)") }

    let channels = Int(format.mChannelsPerFrame)
    let interleaved = (format.mFormatFlags & kAudioFormatFlagIsNonInterleaved) == 0
    let outbox = self.outbox
    let debug = self.debug
    // A queue of our own rather than the device's realtime thread: Core
    // Audio delivers tap input through it, and it keeps the mixdown off the
    // thread the output device is being driven from.
    let queue = DispatchQueue(label: "waveform.audiotap.io", qos: .userInteractive)
    err = AudioDeviceCreateIOProcIDWithBlock(&procID, aggregateID, queue) {
      _, inputData, _, _, _ in
      let buffers = UnsafeMutableAudioBufferListPointer(
        UnsafeMutablePointer(mutating: inputData))
      debug.callbacks += 1
      debug.buffers = buffers.count
      guard let first = buffers.first, let base = first.mData else { return }
      debug.bytes += Int(first.mDataByteSize)
      var mono: [Float]
      if interleaved {
        let frames = Int(first.mDataByteSize) / MemoryLayout<Float>.size / max(channels, 1)
        let samples = base.assumingMemoryBound(to: Float.self)
        mono = [Float](repeating: 0, count: frames)
        for frame in 0..<frames {
          var sum: Float = 0
          for channel in 0..<channels { sum += samples[frame * channels + channel] }
          mono[frame] = sum / Float(max(channels, 1))
        }
      } else {
        let frames = Int(first.mDataByteSize) / MemoryLayout<Float>.size
        mono = [Float](repeating: 0, count: frames)
        var counted = 0
        for buffer in buffers {
          guard let data = buffer.mData else { continue }
          let samples = data.assumingMemoryBound(to: Float.self)
          for frame in 0..<frames { mono[frame] += samples[frame] }
          counted += 1
        }
        if counted > 1 {
          for frame in 0..<frames { mono[frame] /= Float(counted) }
        }
      }
      mono.withUnsafeBytes { outbox.push(Data($0)) }
    }
    guard err == noErr, procID != nil else { throw TapError("io proc: \(err)") }

    // macOS asks for permission inside this call, the first time, and holds
    // it until the user answers.
    err = AudioDeviceStart(aggregateID, procID)
    guard err == noErr else { throw TapError("start: \(err)") }
    return format.mSampleRate
  }

  /// Streams what the IO proc has mixed down to stdout, off the realtime
  /// thread, for the rest of the process's life.
  ///
  /// The tap only runs while some process is playing sound; between calls,
  /// or while the other side is quiet, nothing arrives at all. The stream
  /// is kept on the wall clock by writing silence for the missing stretch,
  /// so the recording lines up with the microphone's track, which never
  /// stops.
  func startDraining(rate: Double) {
    let stdout = FileHandle.standardOutput
    let verbose = ProcessInfo.processInfo.environment["WAVEFORM_TAP_DEBUG"] != nil
    Thread.detachNewThread { [outbox, debug] in
      let started = Date()
      var sent = 0
      var ticks = 0
      // Pad only once the stream is this far behind, and leave half of it
      // as room for the device's own jitter, so real audio arriving a
      // moment later is not pushed ahead of the clock.
      let slack = Int(rate * 0.1)
      while true {
        let data = outbox.drain()
        if !data.isEmpty {
          stdout.write(data)
          sent += data.count / MemoryLayout<Float>.size
        }
        let expected = Int(Date().timeIntervalSince(started) * rate)
        if expected - sent > slack {
          let missing = expected - sent - slack / 2
          stdout.write(Data(count: missing * MemoryLayout<Float>.size))
          sent += missing
          debug.padded += missing
        }
        usleep(20_000)
        ticks += 1
        if verbose && ticks % 50 == 0 {
          status([
            "type": "debug", "callbacks": debug.callbacks, "buffers": debug.buffers,
            "bytes": debug.bytes, "padded": debug.padded,
          ])
        }
      }
    }
  }

  /// How many times the IO proc has run.
  var callbacks: Int { debug.callbacks }

  func stop() {
    status([
      "type": "stats", "callbacks": debug.callbacks, "bytes": debug.bytes, "padded": debug.padded,
      "channels": Int(format.mChannelsPerFrame),
    ])
    teardown()
  }

  private func teardown() {
    if let procID {
      AudioDeviceStop(aggregateID, procID)
      AudioDeviceDestroyIOProcID(aggregateID, procID)
      self.procID = nil
    }
    if aggregateID != kAudioObjectUnknown {
      AudioHardwareDestroyAggregateDevice(aggregateID)
      aggregateID = AudioObjectID(kAudioObjectUnknown)
    }
    if tapID != kAudioObjectUnknown {
      AudioHardwareDestroyProcessTap(tapID)
      tapID = AudioObjectID(kAudioObjectUnknown)
    }
  }

  private func defaultOutputUID() throws -> String {
    var deviceID = AudioObjectID(kAudioObjectUnknown)
    var size = UInt32(MemoryLayout<AudioObjectID>.size)
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioHardwarePropertyDefaultOutputDevice,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain)
    var err = AudioObjectGetPropertyData(
      AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &deviceID)
    guard err == noErr, deviceID != kAudioObjectUnknown else { throw TapError("no output device") }

    var uid: CFString = "" as CFString
    size = UInt32(MemoryLayout<CFString>.size)
    address.mSelector = kAudioDevicePropertyDeviceUID
    err = withUnsafeMutablePointer(to: &uid) {
      AudioObjectGetPropertyData(deviceID, &address, 0, nil, &size, $0)
    }
    guard err == noErr else { throw TapError("output uid: \(err)") }
    return uid as String
  }
}

/// Counters for `WAVEFORM_TAP_DEBUG=1`, when a silent tap has to be explained.
private final class Debug {
  var callbacks = 0
  var buffers = 0
  var bytes = 0
  var padded = 0
}

/// Plays a tone far too quiet to hear for as long as it lives. The tap only
/// runs while some process is playing, so the permission check plays
/// something itself: with permission the tap then hears this process;
/// without it, nothing arrives whatever is playing.
private final class QuietTone {
  private let engine = AVAudioEngine()
  private let player = AVAudioPlayerNode()

  func start() throws {
    let rate = 48_000.0
    guard let format = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 1),
      let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(rate))
    else { throw TapError("tone format") }
    buffer.frameLength = AVAudioFrameCount(rate)
    if let samples = buffer.floatChannelData?[0] {
      for frame in 0..<Int(rate) {
        samples[frame] = sin(Float(frame) * 2 * .pi * 440 / Float(rate)) * 0.0005
      }
    }
    engine.attach(player)
    engine.connect(player, to: engine.mainMixerNode, format: format)
    try engine.start()
    player.scheduleBuffer(buffer, at: nil, options: .loops)
    player.play()
  }

  func stop() {
    player.stop()
    engine.stop()
  }
}

private struct TapError: Error {
  let reason: String
  init(_ reason: String) { self.reason = reason }
}

/// `--probe`: starts the tap, which is what makes macOS ask for permission
/// the first time, plays a tone too quiet to hear, and reports whether the
/// tap heard it. The tap only runs while something is playing, and only
/// with permission; so a tone of our own plus a running tap means allowed,
/// and a tone with nothing arriving means denied. Exit codes: 0 heard,
/// 2 silent, 1 failed.
///
/// The tap is not torn down: destroying its IO proc while the tone's
/// engine shares the HAL connection has been seen to hang, and the system
/// reclaims a private tap and aggregate when the process ends.
@available(macOS 14.2, *)
private func probe() -> Never {
  let tap = SystemTap()
  let tone = QuietTone()
  do {
    try tone.start()
    _ = try tap.start()
  } catch let error as TapError {
    fail(error.reason)
  } catch {
    fail("\(error)")
  }
  Thread.sleep(forTimeInterval: 2.5)
  let heard = tap.callbacks > 0
  status(["type": "probe", "heard": heard, "callbacks": tap.callbacks])
  tone.stop()
  exit(heard ? 0 : 2)
}

/// Runs the tap until the parent lets go. Wrapped so the 14.2 types stay
/// behind the availability check on older systems.
@available(macOS 14.2, *)
private func run() -> Never {
  let tap = SystemTap()
  let rate: Double
  do {
    rate = try tap.start()
  } catch let error as TapError {
    fail(error.reason)
  } catch {
    fail("\(error)")
  }
  tap.startDraining(rate: rate)
  status(["type": "ready", "sampleRate": rate])

  // Stop when the parent closes stdin or asks politely.
  signal(SIGTERM) { _ in exit(0) }
  signal(SIGINT) { _ in exit(0) }
  Thread.detachNewThread {
    while readLine() != nil {}
    exit(0)
  }
  atexit_b { tap.stop() }
  RunLoop.main.run()
  exit(0)
}

if #available(macOS 14.2, *) {
  if CommandLine.arguments.contains("--probe") {
    probe()
  }
  run()
} else {
  fail("unsupported")
}
