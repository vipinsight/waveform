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
  func startDraining() {
    let stdout = FileHandle.standardOutput
    let verbose = ProcessInfo.processInfo.environment["WAVEFORM_TAP_DEBUG"] != nil
    Thread.detachNewThread { [outbox, debug] in
      var ticks = 0
      while true {
        let data = outbox.drain()
        if !data.isEmpty { stdout.write(data) }
        usleep(20_000)
        ticks += 1
        if verbose && ticks % 50 == 0 {
          status(["type": "debug", "callbacks": debug.callbacks, "buffers": debug.buffers, "bytes": debug.bytes])
        }
      }
    }
  }

  /// How many times the IO proc has run.
  var callbacks: Int { debug.callbacks }

  /// Tears the tap down and builds it again. A grant given in the dialog
  /// applies to the next tap, not the one that was waiting on it, so the
  /// first tap after "Allow" runs silent and has to be replaced.
  func restart() throws -> Double {
    teardown()
    debug.callbacks = 0
    debug.bytes = 0
    return try start()
  }

  func stop() {
    status([
      "type": "stats", "callbacks": debug.callbacks, "bytes": debug.bytes,
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
}

private struct TapError: Error {
  let reason: String
  init(_ reason: String) { self.reason = reason }
}

/// `--probe`: starts the tap, which is what makes macOS ask for permission
/// the first time, waits a moment, and reports whether audio IO ran at all.
/// With permission the IO proc fires whether or not anything is playing;
/// without it, nothing fires. A tap that was waiting on the dialog stays
/// silent even after "Allow", so a silent first try is rebuilt once before
/// the answer is final. Exit codes: 0 heard, 2 silent, 1 failed.
@available(macOS 14.2, *)
private func probe() -> Never {
  let tap = SystemTap()
  var heard = false
  do {
    _ = try tap.start()
    for attempt in 1...2 {
      Thread.sleep(forTimeInterval: 1.5)
      heard = tap.callbacks > 0
      if heard || attempt == 2 { break }
      _ = try tap.restart()
    }
  } catch let error as TapError {
    fail(error.reason)
  } catch {
    fail("\(error)")
  }
  status(["type": "probe", "heard": heard, "callbacks": tap.callbacks])
  tap.stop()
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
  tap.startDraining()
  status(["type": "ready", "sampleRate": rate])

  // The first tap after the user clicks "Allow" in the dialog runs silent;
  // the grant reaches the next one. Rebuilt once if nothing has arrived.
  Thread.detachNewThread {
    Thread.sleep(forTimeInterval: 2.0)
    guard tap.callbacks == 0 else { return }
    do {
      _ = try tap.restart()
      status(["type": "restarted"])
    } catch {
      status(["type": "error", "reason": "restart: \(error)"])
    }
  }

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
