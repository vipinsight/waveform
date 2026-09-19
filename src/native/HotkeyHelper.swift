// Waveform hotkey helper.
//
// Speaks newline-delimited JSON over stdin/stdout so the Electron main process can
// observe modifier keys that Electron's accelerators cannot express (Fn, and the
// left/right halves of ⌘ ⌥ ⌃ ⇧), and can paste transcribed text into whichever app
// is frontmost.
//
// Commands (stdin)   {"type":"watch","keyCode":63} | {"type":"unwatch"}
//                    {"type":"paste","text":"…"} | {"type":"read-selection"}
//                    {"type":"permissions"}
//                    {"type":"request","scope":"accessibility"|"input-monitoring"}
// Events (stdout)    {"type":"ready"} | {"type":"key","phase":"down"|"up","keyCode":63}
//                    {"type":"tap","active":true} | {"type":"permissions",…}
//                    {"type":"paste","ok":true} | {"type":"selection","ok":…}

import AVFoundation
import AppKit
import CoreGraphics
import Foundation
import IOKit.hid

// Device-dependent modifier bits from IOKit/hidsystem/IOLLEvent.h. The public
// CGEventFlags only say "a shift is down", never which shift, so a left/right
// binding has to read these.
private let deviceFlagForKeyCode: [Int64: UInt64] = [
  63: 0x0080_0000, // Fn / globe (kCGEventFlagMaskSecondaryFn)
  57: 0x0001_0000, // Caps Lock (kCGEventFlagMaskAlphaShift)
  54: 0x0000_0010, // Right Command
  55: 0x0000_0008, // Left Command
  58: 0x0000_0020, // Left Option
  61: 0x0000_0040, // Right Option
  59: 0x0000_0001, // Left Control
  62: 0x0000_2000, // Right Control
  56: 0x0000_0002, // Left Shift
  60: 0x0000_0004, // Right Shift
]

private let virtualKeyV: CGKeyCode = 0x09
private let virtualKeyC: CGKeyCode = 0x08
private let virtualKeyA: CGKeyCode = 0x00
private let selectionCopyDelay = 0.16
/// Between ⌘A and the copy that follows it. The two are separate events, and an
/// app that updates its selection asynchronously would otherwise copy what was
/// selected before the select-all -- which is nothing, the case we are in.
private let selectAllSettleDelay = 0.06
private let pasteboardRestoreDelay = 0.25

private let outputLock = NSLock()

private func emit(_ payload: [String: Any]) {
  guard let data = try? JSONSerialization.data(withJSONObject: payload) else { return }
  outputLock.lock()
  defer { outputLock.unlock() }
  FileHandle.standardOutput.write(data)
  FileHandle.standardOutput.write(Data([0x0A]))
}

// MARK: - Permissions

private func hasAccessibility(prompt: Bool) -> Bool {
  let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
  return AXIsProcessTrustedWithOptions([key: prompt] as CFDictionary)
}

private func hasInputMonitoring() -> Bool {
  IOHIDCheckAccess(kIOHIDRequestTypeListenEvent) == kIOHIDAccessTypeGranted
}

/// Microphone authorisation, reported so the app can show one honest checklist
/// rather than discovering the problem when recording produces silence.
private func microphoneStatus() -> String {
  switch AVCaptureDevice.authorizationStatus(for: .audio) {
  case .authorized: return "granted"
  case .denied: return "denied"
  case .restricted: return "restricted"
  case .notDetermined: return "not-determined"
  @unknown default: return "unknown"
  }
}

private var lastPermissions: [String: String] = [:]
private let permissionLock = NSLock()

private func currentPermissions() -> [String: String] {
  [
    "accessibility": hasAccessibility(prompt: false) ? "yes" : "no",
    "inputMonitoring": hasInputMonitoring() ? "yes" : "no",
    "microphone": microphoneStatus(),
  ]
}

private func emitPermissions() {
  let snapshot = currentPermissions()
  permissionLock.lock()
  lastPermissions = snapshot
  permissionLock.unlock()

  emit([
    "type": "permissions",
    "accessibility": snapshot["accessibility"] == "yes",
    "inputMonitoring": snapshot["inputMonitoring"] == "yes",
    "microphone": snapshot["microphone"] ?? "unknown",
  ])
}

/// Emits only when something actually changed.
///
/// Permissions are granted in System Settings, in another window, so the app
/// has to notice on its own; polling is the only way macOS offers. Reporting
/// only on change keeps that quiet.
private func emitPermissionsIfChanged() {
  let snapshot = currentPermissions()
  permissionLock.lock()
  let changed = snapshot != lastPermissions
  permissionLock.unlock()
  if changed { emitPermissions() }
}

// MARK: - Pasting

private func pasteIntoFrontmostApp(_ text: String) {
  guard hasAccessibility(prompt: false) else {
    emit(["type": "paste", "ok": false, "reason": "accessibility"])
    return
  }

  let pasteboard = NSPasteboard.general
  let restored = pasteboard.string(forType: .string)
  pasteboard.clearContents()
  pasteboard.setString(text, forType: .string)

  // Local input keeps flowing during the post. Suppressing it would swallow the
  // release of the very key the user is holding, stranding the gesture machine
  // mid-press. Overriding `flags` in postCommandKey is what actually keeps a
  // held modifier from leaking into the synthetic keystroke.
  postCommandKey(virtualKeyV)

  emit(["type": "paste", "ok": true])

  DispatchQueue.main.asyncAfter(deadline: .now() + pasteboardRestoreDelay) {
    pasteboard.clearContents()
    if let restored { pasteboard.setString(restored, forType: .string) }
  }
}

/// Posts a synthetic ⌘C and returns whatever the focused app put on the
/// pasteboard, restoring the previous contents afterwards.
///
/// There is no supported way to read another app's selection directly, so the
/// selection has to be copied. The pasteboard's change count tells us whether
/// the app actually responded, which distinguishes "nothing was selected" from
/// "the user's existing clipboard".
///
/// Nothing selected is the ordinary case rather than a mistake: someone
/// finishes typing a message and reaches for polish without going back to
/// select what they just wrote. So a copy that comes back empty is followed by
/// ⌘A and a second copy, which takes the field they are in. The selection that
/// leaves behind is the point -- the polished text is pasted over it.
private func readSelection() {
  guard hasAccessibility(prompt: false) else {
    emit(["type": "selection", "ok": false, "reason": "accessibility"])
    return
  }

  let pasteboard = NSPasteboard.general
  let restored = pasteboard.string(forType: .string)
  let changeCountBefore = pasteboard.changeCount

  postCommandKey(virtualKeyC)

  DispatchQueue.main.asyncAfter(deadline: .now() + selectionCopyDelay) {
    if let copied = copiedText(pasteboard, since: changeCountBefore) {
      finishSelection(pasteboard, text: copied, restoring: restored)
      return
    }

    // Only where the focus is somewhere text is typed. ⌘A in a file list
    // selects every file in it, and what follows would be a copy of those
    // rather than of anything anybody wanted rewritten.
    guard focusIsTextInput() else {
      finishSelection(pasteboard, text: nil, restoring: restored)
      return
    }

    postCommandKey(virtualKeyA)

    DispatchQueue.main.asyncAfter(deadline: .now() + selectAllSettleDelay) {
      postCommandKey(virtualKeyC)

      DispatchQueue.main.asyncAfter(deadline: .now() + selectionCopyDelay) {
        let copied = copiedText(pasteboard, since: changeCountBefore)
        finishSelection(pasteboard, text: copied, restoring: restored)
      }
    }
  }
}

/// Whether the keyboard focus is on something text is typed into.
///
/// Asked through the accessibility API, which is the only thing that can answer
/// it, and answered conservatively: an element that will not say what it is
/// does not get ⌘A posted at it.
private func focusIsTextInput() -> Bool {
  var focused: CFTypeRef?
  let system = AXUIElementCreateSystemWide()
  guard
    AXUIElementCopyAttributeValue(system, kAXFocusedUIElementAttribute as CFString, &focused)
      == .success,
    let element = focused,
    CFGetTypeID(element) == AXUIElementGetTypeID()
  else { return false }

  let target = element as! AXUIElement
  var role: CFTypeRef?
  AXUIElementCopyAttributeValue(target, kAXRoleAttribute as CFString, &role)
  switch role as? String {
  case kAXTextFieldRole, kAXTextAreaRole, kAXComboBoxRole:
    return true
  default:
    break
  }

  // A web view or an Electron app reports a role of its own making, and still
  // answers for the text it holds. That answer is the test.
  var value: CFTypeRef?
  guard
    AXUIElementCopyAttributeValue(target, kAXValueAttribute as CFString, &value) == .success
  else { return false }
  return value as? String != nil
}

/// What the focused app put on the pasteboard, or nil if it put nothing there.
private func copiedText(_ pasteboard: NSPasteboard, since changeCount: Int) -> String? {
  guard pasteboard.changeCount != changeCount else { return nil }
  guard let copied = pasteboard.string(forType: .string), !copied.isEmpty else { return nil }
  return copied
}

private func finishSelection(
  _ pasteboard: NSPasteboard,
  text: String?,
  restoring restored: String?
) {
  if let text {
    emit(["type": "selection", "ok": true, "text": text])
  } else {
    emit(["type": "selection", "ok": false, "reason": "empty"])
  }

  // Put the user's clipboard back; the copy was only a means of reading. The
  // change count is not consulted again: a copy that produced nothing readable
  // can still have emptied the pasteboard.
  pasteboard.clearContents()
  if let restored { pasteboard.setString(restored, forType: .string) }
}

private func postCommandKey(_ key: CGKeyCode) {
  let source = CGEventSource(stateID: .combinedSessionState)
  source?.setLocalEventsFilterDuringSuppressionState(
    [.permitLocalMouseEvents, .permitLocalKeyboardEvents],
    state: .eventSuppressionStateSuppressionInterval
  )

  let down = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: true)
  let up = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: false)
  down?.flags = .maskCommand
  up?.flags = .maskCommand
  down?.post(tap: .cgAnnotatedSessionEventTap)
  up?.post(tap: .cgAnnotatedSessionEventTap)
}

// MARK: - Modifier watch

private final class ModifierWatcher {
  private var tap: CFMachPort?
  private var runLoopSource: CFRunLoopSource?
  private var retryTimer: Timer?
  private var accessTimer: Timer?
  /// Input Monitoring state at the moment the current tap was created.
  private var hadAccess = false
  private(set) var watchedKeyCode: Int64?
  private var isDown = false

  func watch(keyCode: Int64) {
    watchedKeyCode = keyCode
    isDown = false
    if tap == nil { install() }
    startAccessWatch()
  }

  /// Begins polling without binding a key, so the setup checklist still
  /// updates while the shortcut is switched off.
  func observePermissions() {
    startAccessWatch()
  }

  func unwatch() {
    watchedKeyCode = nil
    isDown = false
  }

  /// Re-broadcasts a flagsChanged event as an unambiguous down/up for the bound key.
  func handle(event: CGEvent) {
    guard let watched = watchedKeyCode,
          let mask = deviceFlagForKeyCode[watched],
          event.getIntegerValueField(.keyboardEventKeycode) == watched
    else { return }

    let down = (event.flags.rawValue & mask) != 0
    guard down != isDown else { return }
    isDown = down
    emit(["type": "key", "phase": down ? "down" : "up", "keyCode": watched])
  }

  func reenable() {
    guard let tap else { return }
    CGEvent.tapEnable(tap: tap, enable: true)
  }

  /// Watches for Input Monitoring being granted while we are already running.
  ///
  /// `CGEvent.tapCreate` succeeds even when access is denied; the tap simply
  /// never delivers anything. Granting the permission does not revive it, so
  /// the tap has to be rebuilt once access appears -- otherwise the shortcut
  /// stays dead until the app is relaunched, which is what makes permissions
  /// look like they were granted but did not take.
  private func startAccessWatch() {
    guard accessTimer == nil else { return }
    hadAccess = hasInputMonitoring()
    accessTimer = Timer.scheduledTimer(withTimeInterval: 1.5, repeats: true) { [weak self] _ in
      guard let self else { return }
      emitPermissionsIfChanged()

      guard self.watchedKeyCode != nil else { return }
      let access = hasInputMonitoring()
      defer { self.hadAccess = access }
      guard access, !self.hadAccess else { return }
      self.reinstall()
    }
  }

  private func reinstall() {
    if let source = runLoopSource {
      CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes)
    }
    if let tap {
      CGEvent.tapEnable(tap: tap, enable: false)
      CFMachPortInvalidate(tap)
    }
    tap = nil
    runLoopSource = nil
    isDown = false
    install()
    emitPermissions()
  }

  private func install() {
    let mask = CGEventMask(1 << CGEventType.flagsChanged.rawValue)
    let callback: CGEventTapCallBack = { _, type, event, _ in
      switch type {
      case .flagsChanged:
        watcher.handle(event: event)
      case .tapDisabledByTimeout, .tapDisabledByUserInput:
        watcher.reenable()
      default:
        break
      }
      return Unmanaged.passUnretained(event)
    }

    // The HID tap sees Fn before the window server claims it for globe-key actions;
    // the session tap is the fallback for locked-down configurations.
    let created = [CGEventTapLocation.cghidEventTap, .cgSessionEventTap].lazy.compactMap {
      CGEvent.tapCreate(
        tap: $0,
        place: .headInsertEventTap,
        options: .listenOnly,
        eventsOfInterest: mask,
        callback: callback,
        userInfo: nil
      )
    }.first

    guard let created else {
      emit(["type": "tap", "active": false, "reason": "permission"])
      scheduleRetry()
      return
    }

    let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, created, 0)
    CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
    CGEvent.tapEnable(tap: created, enable: true)
    tap = created
    runLoopSource = source
    hadAccess = hasInputMonitoring()
    retryTimer?.invalidate()
    retryTimer = nil
    // A tap can exist without permission, so report whether it can actually
    // receive anything rather than merely that it was created.
    emit(["type": "tap", "active": true, "listening": hadAccess])
  }

  private func scheduleRetry() {
    guard retryTimer == nil else { return }
    retryTimer = Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { [weak self] _ in
      guard let self, self.watchedKeyCode != nil, self.tap == nil else { return }
      self.install()
    }
  }
}

private let watcher = ModifierWatcher()

// MARK: - Command loop

private func handle(command line: String) {
  guard let data = line.data(using: .utf8),
        let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let type = payload["type"] as? String
  else { return }

  switch type {
  case "watch":
    if let keyCode = payload["keyCode"] as? Int64 ?? (payload["keyCode"] as? Int).map(Int64.init) {
      watcher.watch(keyCode: keyCode)
    }
  case "unwatch":
    watcher.unwatch()
    watcher.observePermissions()
  case "paste":
    if let text = payload["text"] as? String, !text.isEmpty { pasteIntoFrontmostApp(text) }
  case "read-selection":
    readSelection()
  case "permissions":
    emitPermissions()
  case "request":
    let scope = payload["scope"] as? String
    if scope == "accessibility" { _ = hasAccessibility(prompt: true) }
    if scope == "input-monitoring" { _ = IOHIDRequestAccess(kIOHIDRequestTypeListenEvent) }
    emitPermissions()
  default:
    break
  }
}

DispatchQueue.global(qos: .userInitiated).async {
  while let line = readLine(strippingNewline: true) {
    DispatchQueue.main.async { handle(command: line) }
  }
  // Parent closed the pipe; nothing left to serve.
  exit(0)
}

emit(["type": "ready"])
emitPermissions()
watcher.observePermissions()
CFRunLoopRun()
