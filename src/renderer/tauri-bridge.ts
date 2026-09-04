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
  DesktopApi,
  DictationCommand,
  DictationPhrase,
  DictationStatus,
  DictationUpdate,
  HotkeyStatus,
  MicrophonePermissionResult,
  ModelEvent,
  ResourceUsage,
  TranscriptionResult,
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

/** State the Rust side does not own yet; reported honestly rather than faked. */
const UNSUPPORTED_HOTKEY_STATUS: HotkeyStatus = {
  supported: false,
  running: false,
  tapActive: false,
  accessibility: false,
  inputMonitoring: false,
  binding: "none",
};

const api: DesktopApi = {
  startModel: () => invoke<void>("start_model"),
  selectModel: (modelId) => invoke<void>("select_model", { modelId }),
  requestMicrophoneAccess: () =>
    invoke<MicrophonePermissionResult>("request_microphone"),
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
  onSettingsChanged: (listener) =>
    subscribe<AppSettings>("settings-changed", listener),

  getStats: () => invoke<AppStats>("get_stats"),
  onStatsChanged: (listener) => subscribe<AppStats>("stats-changed", listener),

  getHotkeyStatus: () => Promise.resolve(UNSUPPORTED_HOTKEY_STATUS),
  onHotkeyStatusChanged: () => () => undefined,
  requestHotkeyPermission: () => Promise.resolve(),
  openPrivacySettings: () => Promise.resolve(),

  getAiStatus: () => Promise.resolve<AiStatus>({ hasApiKey: false, memoryOnly: false }),
  setOpenRouterKey: () =>
    Promise.reject(new Error("OpenRouter is not wired up in the Tauri build yet.")),
  clearOpenRouterKey: () =>
    Promise.resolve<AiStatus>({ hasApiKey: false, memoryOnly: false }),
  polishSelection: () =>
    Promise.reject(new Error("Polishing is not wired up in the Tauri build yet.")),

  toggleDictation: () => toggleDictation(),
  previewIndicator: () => sendOverlayCommand({ action: "preview", sink: "transcript", mode: "hold" }),
  onDictationCommand: (listener) => {
    dictationCommandListeners.add(listener);
    return () => dictationCommandListeners.delete(listener);
  },
  onDictationUpdate: (listener) => {
    dictationUpdateListeners.add(listener);
    return () => dictationUpdateListeners.delete(listener);
  },
  reportDictationState: (status) => handleDictationState(status),
  reportDictationPhrase: (phrase) => handleDictationPhrase(phrase),

  beginOverlayDrag: () => void invoke("begin_overlay_drag"),
  moveOverlay: (deltaX, deltaY) => void invoke("drag_overlay", { deltaX, deltaY }),
  endOverlayDrag: () => void invoke("end_overlay_drag"),

  onResourceUsage: () => () => undefined,
};

/*
 * Dictation coordination.
 *
 * Under Electron the main process brokers between the two windows. Tauri has no
 * equivalent broker yet, so the windows coordinate over Tauri's own event bus:
 * the main window asks for a session, the overlay performs it and reports back.
 */
const dictationCommandListeners = new Set<(command: DictationCommand) => void>();
const dictationUpdateListeners = new Set<(update: DictationUpdate) => void>();
let sessionActive = false;

async function toggleDictation(): Promise<void> {
  if (sessionActive) {
    await sendOverlayCommand({ action: "stop", sink: "transcript", mode: "latched" });
    return;
  }
  await invoke("record_session");
  await sendOverlayCommand({ action: "start", sink: "transcript", mode: "latched" });
}

async function sendOverlayCommand(command: DictationCommand): Promise<void> {
  if (command.action === "start" || command.action === "preview") {
    await invoke("show_overlay");
  }
  sessionActive = command.action === "start";
  for (const listener of dictationCommandListeners) listener(command);
  emitLocal("dictation-command", command);
}

function handleDictationState(status: DictationStatus): void {
  if (status.state === "idle") {
    sessionActive = false;
    void invoke("hide_overlay");
  }
  for (const listener of dictationUpdateListeners) listener({ status });
  emitLocal("dictation-update", { status });
}

function handleDictationPhrase(phrase: DictationPhrase): void {
  void invoke("record_phrase", { text: phrase.text });
  const update: DictationUpdate = {
    status: { state: "listening", sink: phrase.sink, mode: "hold" },
    phrase,
  };
  for (const listener of dictationUpdateListeners) listener(update);
  emitLocal("dictation-update", update);
}

/** Relays a message to the other window, which has its own copy of this bridge. */
function emitLocal(event: string, payload: unknown): void {
  const global = window as unknown as {
    __TAURI__?: { event: { emit(name: string, payload: unknown): Promise<void> } };
  };
  void global.__TAURI__?.event.emit(event, payload).catch(() => undefined);
}

/**
 * Installs the bridge, or does nothing when the host is not Tauri.
 *
 * Both entry points call this unconditionally so a single bundle can serve
 * either shell; under Electron the preload script has already supplied
 * `window.waveform` and this returns immediately.
 */
export function installTauriBridge(): void {
  if (!maybeTauri()) return;

  // Cross-window relay: whichever window did not originate a message still
  // needs to act on it.
  void tauri()
    .event.listen<DictationCommand>("dictation-command", (message) => {
      for (const listener of dictationCommandListeners) listener(message.payload);
    })
    .catch(() => undefined);
  void tauri()
    .event.listen<DictationUpdate>("dictation-update", (message) => {
      for (const listener of dictationUpdateListeners) listener(message.payload);
    })
    .catch(() => undefined);

  window.waveform = api;
}
