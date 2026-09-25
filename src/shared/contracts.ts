import type { HotkeyBindingId } from "./hotkeys";
import type { SpeechModelId } from "./models";
import type { AppSettings } from "./settings";

export type ModelStage =
  | "idle"
  | "starting"
  | "downloading"
  | "loading"
  | "ready"
  | "error";

export type UiStage = ModelStage | "transcribing";

export interface ModelEvent {
  stage: ModelStage;
  message: string;
  modelId: SpeechModelId;
  /** How much of a download is done, 0 to 1. Only sent while downloading. */
  progress?: number;
}

/** A release newer than the running one. */
export interface UpdateInfo {
  version: string;
  notes: string;
}

export type UpdateStage =
  | "checking"
  | "available"
  | "current"
  | "downloading"
  | "installing"
  | "installed"
  | "error";

export interface UpdateEvent {
  stage: UpdateStage;
  message: string;
  /** How much of the download is done, 0 to 1. Only sent while downloading. */
  progress?: number;
  /** The version being offered or installed. */
  version?: string;
}

/** One line of what the app is doing. */
export interface LogLine {
  /** Milliseconds since the epoch. */
  at: number;
  level: "info" | "warn" | "error";
  /** Which part is speaking: engine, capture, dictation, update. */
  source: string;
  message: string;
}

export interface TranscriptionResult {
  text: string;
}

export type MicrophonePermissionStatus =
  | "not-determined"
  | "granted"
  | "denied"
  | "restricted"
  | "unknown";

export interface MicrophonePermissionResult {
  granted: boolean;
  status: MicrophonePermissionStatus;
}

export interface MicrophoneDevice {
  id: string;
  label: string;
  displayLabel: string;
}

/** One block of mono PCM from the native input. */
export interface CaptureBlock {
  samples: number[];
  sampleRate: number;
}

/** Where a dictation session's text should end up. */
export type DictationSink = "insert" | "transcript";

/** How the session was started, which decides how it can end. */
export type DictationMode = "hold" | "latched";

export type DictationState =
  | "idle"
  | "listening"
  | "transcribing"
  /** Waiting on a rewrite, here or through OpenRouter. */
  | "rewriting"
  | "error";

export interface DictationCommand {
  /** "preview" shows the HUD with synthetic levels, so it can be checked
      without a microphone, a loaded model, or granted permissions. */
  action:
    | "start"
    | "stop"
    | "cancel"
    | "preview"
    | "idle"
    | "busy"
    | "fail"
    | "retry"
    | "dismiss-retry";
  sink: DictationSink;
  mode: DictationMode;
  /** Why it failed, for the actions where something did. */
  message?: string;
}

/**
 * What a model needs before it can be used, reported separately.
 *
 * A runtime without weights and weights without a runtime are both half
 * installed, and they are fixed by different halves of the same command, so
 * saying only "not ready" would not tell anyone what to do.
 */
export interface ModelStatus {
  id: string;
  label: string;
  selected: boolean;
  runtimeInstalled: boolean;
  weightsInstalled: boolean;
  /** Empty when the app fetches these weights itself. */
  setupCommand: string;
  /**
   * Size of the download, when the app can perform it. `null` means the
   * weights arrive some other way and only a terminal can bring them.
   */
  downloadBytes: number | null;
  /** The heading this model is listed under. */
  group: string;
  /**
   * The one thing worth saying beyond the numbers, or empty when the name and
   * the figures already say it.
   */
  detail: string;
  /** The model's own page on Hugging Face. */
  cardUrl: string;
  /**
   * Word error rate on LibriSpeech test-clean, in percent, as Hugging Face
   * publishes it. A quantization carries the figure from the model it is a
   * quantization of: nobody publishes a separate number for the q5 file.
   */
  wer: number | null;
  /** Roughly what it adds to resident memory once loaded, in MB. */
  memoryMb: number;
  /**
   * How that memory sits on this Mac: an eighth of it or less is comfortable,
   * up to a quarter is tight, more than that is too large. `null` when the
   * installed memory could not be read, so nothing is claimed about it.
   */
  fit: ModelFit | null;
}

export type ModelFit = "comfortable" | "tight" | "too-large";

/** A pointer position in the HUD's own coordinates. */
export interface OverlayPoint {
  x: number;
  y: number;
}

/** A rectangle in the HUD's own coordinates. */
export interface OverlayRect extends OverlayPoint {
  width: number;
  height: number;
}

export interface DictationStatus {
  state: DictationState;
  sink: DictationSink;
  mode: DictationMode;
  message?: string;
  /** Held audio can be transcribed again without speaking. */
  canRetry?: boolean;
}

export interface DictationPhrase {
  text: string;
  sink: DictationSink;
}

/** A phrase cut from the mic, stashed before the engine returns words. */
export interface DictationClip {
  wavBytes: number[];
}

export interface DictationUpdate {
  status: DictationStatus;
  phrase?: DictationPhrase;
}

export interface ResourceUsage {
  /** Percent of one CPU core, summed across Electron and the speech engine. */
  cpuPercent: number;
  /** Resident memory in megabytes, summed the same way. */
  memoryMb: number;
  /** Resident memory of the speech engine alone, or null when it is not running. */
  engineMemoryMb: number | null;
}

export interface AiStatus {
  /** Whether an API key is saved. The key itself never reaches a renderer. */
  hasApiKey: boolean;
  /** True when the key could not be encrypted and lives only in memory. */
  memoryOnly: boolean;
  /** Which engine rewrites: a hosted model, or one on this Mac. */
  engine: PolishEngine;
  /** The local model chosen, downloaded or not. */
  localModelId: string;
  /** Whether that model's weights are on this machine. */
  localReady: boolean;
}

export type PolishEngine = "openrouter" | "local";

/**
 * One model the local polish engine can run.
 *
 * Fewer facts than a speech model carries: there is no runtime to install and
 * no word error rate to read down a column, so what is left is the size of the
 * download, what it costs to keep loaded, and whether it is here yet.
 */
export interface PolishModelStatus {
  id: string;
  label: string;
  selected: boolean;
  installed: boolean;
  downloadBytes: number;
  memoryMb: number;
  detail: string;
  /** The model's own page on Hugging Face. */
  cardUrl: string;
  /** How that memory sits on this Mac, or `null` when it could not be read. */
  fit: ModelFit | null;
}

export interface SavedDictation {
  id: string;
  text: string;
  /** Milliseconds since the epoch. */
  createdAt: number;
  /** Whether a local WAV exists for playback. */
  hasAudio?: boolean;
}

export interface AppStats {
  words: number;
  phrases: number;
  sessions: number;
}

export interface HotkeyStatus {
  /** False when the native helper is missing, e.g. a non-macOS build. */
  supported: boolean;
  running: boolean;
  /** The tap exists and can actually receive events. */
  tapActive: boolean;
  accessibility: boolean;
  inputMonitoring: boolean;
  microphone: MicrophonePermissionStatus;
  binding: HotkeyBindingId;
  /** Whether the selected speech engine's runtime is present. */
  engineInstalled: boolean;
}

export type PrivacyPane = "accessibility" | "input-monitoring" | "microphone";

export interface DesktopApi {
  startModel(): Promise<void>;
  selectModel(modelId: SpeechModelId): Promise<void>;
  /** Resolves when the download has finished, or rejects with why it did not. */
  downloadModel(modelId: SpeechModelId): Promise<void>;
  /** Removes a Whisper weight file the app fetched. */
  deleteModel(modelId: SpeechModelId): Promise<void>;
  /** Stops an in-flight Whisper download. */
  cancelModelDownload(): Promise<void>;
  /** `null` means this is already the newest version. */
  checkForUpdate(): Promise<UpdateInfo | null>;
  /** Installs the newer version and relaunches, so this never resolves. */
  installUpdate(): Promise<void>;
  onUpdateEvent(listener: (event: UpdateEvent) => void): () => void;
  getLogs(): Promise<LogLine[]>;
  clearLogs(): Promise<void>;
  onLogLine(listener: (line: LogLine) => void): () => void;
  /** Writes into the same log from a window, which knows things Rust does not. */
  log(level: LogLine["level"], source: string, message: string): Promise<void>;
  requestMicrophoneAccess(): Promise<MicrophonePermissionResult>;
  /** Opens a HAL input only — not an AudioContext on the speakers. */
  startNativeCapture(): Promise<string>;
  stopNativeCapture(): Promise<void>;
  onCaptureBlock(listener: (block: CaptureBlock) => void): () => void;
  transcribe(wavBytes: Uint8Array): Promise<TranscriptionResult>;
  onModelEvent(listener: (event: ModelEvent) => void): () => void;
  getModelState(): Promise<ModelEvent>;

  getSettings(): Promise<AppSettings>;
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  /** Device labels come from the WebView; Rust uses them to populate the tray menu. */
  setAvailableMicrophones(devices: MicrophoneDevice[]): Promise<void>;
  onSettingsChanged(listener: (settings: AppSettings) => void): () => void;

  getHotkeyStatus(): Promise<HotkeyStatus>;
  onHotkeyStatusChanged(listener: (status: HotkeyStatus) => void): () => void;
  requestHotkeyPermission(scope: "accessibility" | "input-monitoring"): Promise<void>;
  openPrivacySettings(pane: PrivacyPane): Promise<void>;

  toggleDictation(): Promise<void>;
  startOverlayDictation(): Promise<void>;
  acceptDictation(): Promise<void>;
  polishDictation(): Promise<void>;
  cancelDictation(): Promise<void>;
  /** Re-transcribes the last failed clips, without opening the microphone. */
  retryDictation(): Promise<void>;
  /** Drops held clips from a failed attempt. */
  dismissDictationRetry(): Promise<void>;
  previewIndicator(): Promise<void>;
  beginOverlayDrag(): void;
  moveOverlay(deltaX: number, deltaY: number): void;
  /**
   * Ends the drag, carrying the position the pointer was let go at.
   *
   * The final move travels with the ending rather than before it: they are
   * separate commands on the same channel but separate futures once they land,
   * and an ending that won the race saved the second-to-last position.
   */
  endOverlayDrag(deltaX: number, deltaY: number): void;
  onResourceUsage(listener: (usage: ResourceUsage) => void): () => void;
  getAiStatus(): Promise<AiStatus>;
  setOpenRouterKey(key: string): Promise<AiStatus>;
  clearOpenRouterKey(): Promise<AiStatus>;
  /** Every local polish model, and what is on this machine for each. */
  getPolishModelCatalog(): Promise<PolishModelStatus[]>;
  /** Resolves when the download has finished, or rejects with why it did not. */
  downloadPolishModel(modelId: string): Promise<void>;
  /** Removes a polish weight file the app fetched. */
  deletePolishModel(modelId: string): Promise<void>;
  /** Stops an in-flight polish download. */
  cancelPolishModelDownload(): Promise<void>;
  onPolishModelEvent(listener: (event: ModelEvent) => void): () => void;
  polishSelection(): Promise<void>;
  /** The application menu asking for the settings dialog. */
  onOpenSettings(listener: () => void): () => void;
  /** The tray's microphone submenu opens directly to its matching control. */
  onOpenMicrophoneSettings(listener: () => void): () => void;
  onOpenModelSettings(listener: () => void): () => void;
  onOpenShortcutSettings(listener: () => void): () => void;
  getAppVersion(): Promise<string>;
  /** Dock and window name: "Waveform" in a release, "Waveform Dev" from `pnpm app`. */
  getAppName(): Promise<string>;
  /** Opens an http(s) address in the system browser. The webview must not navigate. */
  openUrl(url: string): Promise<void>;
  getHistory(): Promise<SavedDictation[]>;
  deleteDictation(id: string): Promise<SavedDictation[]>;
  clearHistory(): Promise<SavedDictation[]>;
  /** WAV bytes for a saved dictation, when one was kept. */
  getDictationAudio(id: string): Promise<Uint8Array>;
  /** Copies a dictation's recording into Downloads; resolves to its path. */
  saveDictationAudio(id: string, fileName: string): Promise<string>;
  /** Saves a transcription (from a dropped file, for example) into history. */
  saveDictation(text: string, wavBytes?: Uint8Array): Promise<SavedDictation[]>;
  /** Replaces the words on a saved dictation after re-running the engine. */
  updateDictation(id: string, text: string): Promise<SavedDictation[]>;
  onHistoryChanged(listener: (entries: SavedDictation[]) => void): () => void;
  getStats(): Promise<AppStats>;
  onStatsChanged(listener: (stats: AppStats) => void): () => void;
  /** Every model, and what is on this machine for each. */
  getModelCatalog(): Promise<ModelStatus[]>;
  onDictationCommand(listener: (command: DictationCommand) => void): () => void;
  /** Where the pointer is over the HUD, in its own coordinates, or null when
      it is elsewhere. The HUD cannot work this out itself: it is never the key
      window, so WebKit sends it no pointer events and matches no `:hover`. */
  onOverlayCursor(listener: (point: OverlayPoint | null) => void): () => void;
  /** Which part of the HUD's window is the pill. Everything outside it is made
      click-through, so the window's transparent margin stops swallowing clicks
      meant for the app underneath. */
  setOverlayHitRegion(region: OverlayRect): void;
  onDictationUpdate(listener: (update: DictationUpdate) => void): () => void;
  reportDictationState(status: DictationStatus): void | Promise<void>;
  /** Stashes phrase audio before transcription so idle flush cannot drop it. */
  reportDictationClip(clip: DictationClip): void | Promise<void>;
  reportDictationPhrase(phrase: DictationPhrase): void | Promise<void>;
}
