/**
 * Installs `window.waveform` when running under Tauri.
 *
 * Presents exactly the surface the Electron preload script exposes, so every
 * module above the host boundary is unaware of which shell it is in. Commands
 * map to `invoke`; pushed events map to `listen`.
 */
import type {
  AiStatus,
  AppStats,
  CaptureBlock,
  DesktopApi,
  DictationCommand,
  DictationUpdate,
  HotkeyStatus,
  MicrophoneDevice,
  MicrophonePermissionResult,
  ModelEvent,
  ModelStatus,
  OverlayPoint,
  PolishModelStatus,
  ResourceUsage,
  LogLine,
  SavedDictation,
  TranscriptionResult,
  UpdateEvent,
  UpdateInfo,
} from "../shared/contracts";
import type { AppSettings } from "../shared/settings";

interface TauriGlobal {
  core: { invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> };
  event: {
    listen<T>(
      event: string,
      handler: (message: { payload: T }) => void,
    ): Promise<() => void>;
  };
}

function maybeTauri(): TauriGlobal | null {
  return (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__ ?? null;
}

function tauri(): TauriGlobal {
  const global = maybeTauri();
  if (!global) throw new Error("Tauri bridge is unavailable.");
  return global;
}

function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return tauri().core.invoke<T>(command, args);
}

/**
 * Subscribes to a Rust-side event.
 *
 * `listen` resolves asynchronously, so the unsubscribe function is not known
 * yet when the caller needs one; this returns a stub that cancels the
 * subscription once it lands.
 */
function subscribe<T>(event: string, handler: (payload: T) => void): () => void {
  let unlisten: (() => void) | null = null;
  let cancelled = false;

  void tauri()
    .event.listen<T>(event, (message) => handler(message.payload))
    .then((stop) => {
      if (cancelled) stop();
      else unlisten = stop;
    });

  return () => {
    cancelled = true;
    unlisten?.();
  };
}

const api: DesktopApi = {
  startModel: () => invoke<void>("start_model"),
  selectModel: (modelId) => invoke<void>("select_model", { modelId }),
  downloadModel: (modelId) => invoke<void>("download_model", { modelId }),
  deleteModel: (modelId) => invoke<void>("delete_model", { modelId }),
  cancelModelDownload: () => invoke<void>("cancel_model_download"),
  checkForUpdate: () => invoke<UpdateInfo | null>("check_for_update"),
  installUpdate: () => invoke<void>("install_update"),
  getUpdateAvailable: () => invoke<string | null>("update_available"),
  onUpdateEvent: (listener) => subscribe<UpdateEvent>("update-event", listener),
  getLogs: () => invoke<LogLine[]>("get_logs"),
  clearLogs: () => invoke<void>("clear_logs"),
  onLogLine: (listener) => subscribe<LogLine>("log-line", listener),
  log: (level, source, message) => invoke<void>("append_log", { level, source, message }),
  requestMicrophoneAccess: () =>
    invoke<MicrophonePermissionResult>("request_microphone"),
  startNativeCapture: () => invoke<string>("start_native_capture"),
  stopNativeCapture: () => invoke<void>("stop_native_capture"),
  onCaptureBlock: (listener) => subscribe<CaptureBlock>("capture-block", listener),
  transcribe: async (wavBytes) => {
    // Tauri's IPC carries JSON, so the buffer crosses as a number array.
    const text = await invoke<string>("transcribe", {
      wavBytes: Array.from(wavBytes),
    });
    return { text } satisfies TranscriptionResult;
  },
  onModelEvent: (listener) => subscribe<ModelEvent>("model-event", listener),
  getModelState: () => invoke<ModelEvent>("get_model_state"),

  getSettings: () => invoke<AppSettings>("get_settings"),
  updateSettings: (patch) =>
    invoke<AppSettings>("update_settings", { patch }),
  setAvailableMicrophones: (devices) =>
    invoke<void>("set_available_microphones", { devices }),
  onSettingsChanged: (listener) =>
    subscribe<AppSettings>("settings-changed", listener),

  getHistory: () => invoke<SavedDictation[]>("get_history"),
  deleteDictation: (id) => invoke<SavedDictation[]>("delete_dictation", { id }),
  clearHistory: () => invoke<SavedDictation[]>("clear_history"),
  getDictationAudio: async (id) => {
    const bytes = await invoke<number[]>("get_dictation_audio", { id });
    return Uint8Array.from(bytes);
  },
  saveDictationAudio: (id, fileName) =>
    invoke<string>("save_dictation_audio", { id, fileName }),
  saveDictation: async (text, wavBytes) =>
    invoke<SavedDictation[]>("save_dictation", {
      text,
      wavBytes: wavBytes ? Array.from(wavBytes) : null,
    }),
  updateDictation: (id, text) =>
    invoke<SavedDictation[]>("update_dictation", { id, text }),
  onHistoryChanged: (listener) =>
    subscribe<SavedDictation[]>("history-changed", listener),
  getStats: () => invoke<AppStats>("get_stats"),
  onStatsChanged: (listener) => subscribe<AppStats>("stats-changed", listener),

  getHotkeyStatus: () => invoke<HotkeyStatus>("get_hotkey_status"),
  onHotkeyStatusChanged: (listener) =>
    subscribe<HotkeyStatus>("hotkey-status-changed", listener),
  requestHotkeyPermission: (scope) =>
    invoke<void>("request_hotkey_permission", { scope }),
  openPrivacySettings: (pane) => invoke<void>("open_privacy_settings", { pane }),

  getAiStatus: () => invoke<AiStatus>("get_ai_status"),
  setOpenRouterKey: (key) => invoke<AiStatus>("set_openrouter_key", { key }),
  clearOpenRouterKey: () => invoke<AiStatus>("clear_openrouter_key"),
  getPolishModelCatalog: () => invoke<PolishModelStatus[]>("polish_model_catalog"),
  downloadPolishModel: (modelId) => invoke<void>("download_polish_model", { modelId }),
  deletePolishModel: (modelId) => invoke<void>("delete_polish_model", { modelId }),
  cancelPolishModelDownload: () => invoke<void>("cancel_polish_model_download"),
  onPolishModelEvent: (listener) => subscribe<ModelEvent>("polish-model-event", listener),
  polishSelection: () => invoke<void>("polish_selection"),

  toggleDictation: () => invoke<void>("toggle_dictation"),
  startOverlayDictation: () => invoke<void>("start_overlay_dictation"),
  acceptDictation: () => invoke<void>("accept_dictation"),
  polishDictation: () => invoke<void>("polish_dictation"),
  cancelDictation: () => invoke<void>("cancel_dictation"),
  retryDictation: () => invoke<void>("retry_dictation"),
  dismissDictationRetry: () => invoke<void>("dismiss_dictation_retry"),
  previewIndicator: () => invoke<void>("preview_indicator"),
  getModelCatalog: () => invoke<ModelStatus[]>("model_catalog"),
  onDictationCommand: (listener) =>
    subscribe<DictationCommand>("dictation-command", listener),
  onOverlayCursor: (listener) =>
    subscribe<OverlayPoint | null>("overlay-cursor", listener),
  setOverlayHitRegion: (region) => void invoke("set_overlay_hit_region", { ...region }),
  onDictationUpdate: (listener) =>
    subscribe<DictationUpdate>("dictation-update", listener),
  reportDictationState: (status) => invoke<void>("report_dictation_state", { status }),
  reportDictationClip: (clip) => invoke<void>("report_dictation_clip", { clip }),
  reportDictationPhrase: (phrase) => invoke<void>("report_dictation_phrase", { phrase }),

  beginOverlayDrag: () => void invoke("begin_overlay_drag"),
  moveOverlay: (deltaX, deltaY) => void invoke("drag_overlay", { deltaX, deltaY }),
  endOverlayDrag: (deltaX, deltaY) => void invoke("end_overlay_drag", { deltaX, deltaY }),

  onResourceUsage: (listener) =>
    subscribe<ResourceUsage>("resource-usage", listener),
  onOpenSettings: (listener) => subscribe<void>("open-settings", listener),
  onOpenMicrophoneSettings: (listener) =>
    subscribe<void>("open-microphone-settings", listener),
  onOpenModelSettings: (listener) => subscribe<void>("open-model-settings", listener),
  onOpenShortcutSettings: (listener) =>
    subscribe<void>("open-shortcut-settings", listener),
  getAppVersion: () => invoke<string>("app_version"),
  getAppName: () => invoke<string>("app_name"),
  openUrl: (url) => invoke<void>("open_url", { url }),
};

/**
 * Installs the bridge.
 *
 * Called by both entry points before anything reaches for the host. Silence
 * here would surface much later as an unrelated failure, so a missing Tauri
 * global throws immediately.
 */
export function installTauriBridge(): void {
  if (!maybeTauri()) {
    throw new Error("Tauri global is unavailable; the window cannot reach its host.");
  }
  window.waveform = api;
}
