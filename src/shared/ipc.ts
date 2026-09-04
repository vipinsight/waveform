export const IPC_CHANNELS = {
  selectModel: "model:select",
  startModel: "model:start",
  modelEvent: "model:event",
  requestMicrophone: "microphone:request",
  transcribeAudio: "audio:transcribe",

  getSettings: "settings:get",
  updateSettings: "settings:update",
  settingsChanged: "settings:changed",

  getHotkeyStatus: "hotkey:status",
  hotkeyStatusChanged: "hotkey:status-changed",
  requestHotkeyPermission: "hotkey:request-permission",
  openPrivacySettings: "hotkey:open-privacy-settings",

  /** main → overlay: begin, end, or abandon a capture. */
  dictationCommand: "dictation:command",
  /** overlay → main: capture state changed, so the UI can follow along. */
  dictationState: "dictation:state",
  /** overlay → main: a finished phrase, ready to paste and to log. */
  dictationPhrase: "dictation:phrase",
  /** main → main window: mirrors HUD state and phrases into the app UI. */
  dictationUpdate: "dictation:update",
  /** main window → main: the in-app Start/Stop button. */
  toggleDictation: "dictation:toggle",
  /** main window → main: show the HUD briefly so the user can find it. */
  previewIndicator: "dictation:preview",

  /** overlay → main: drag the HUD to a new screen position. */
  overlayDragBegin: "overlay:drag-begin",
  overlayDragMove: "overlay:drag-move",
  overlayDragEnd: "overlay:drag-end",

  /** main → main window: periodic CPU and memory sample. */
  resourceUsage: "resources:usage",
} as const;
