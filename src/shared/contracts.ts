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

/** Where a dictation session's text should end up. */
export type DictationSink = "insert" | "transcript";

/** How the session was started, which decides how it can end. */
export type DictationMode = "hold" | "latched";

export type DictationState =
  | "idle"
  | "listening"
  | "transcribing"
  /** Waiting on an OpenRouter rewrite. */
  | "rewriting"
  | "error";

export interface DictationCommand {
  /** "preview" shows the HUD with synthetic levels, so it can be checked
      without a microphone, a loaded model, or granted permissions. */
  action: "start" | "stop" | "cancel" | "preview" | "busy" | "fail";
  sink: DictationSink;
  mode: DictationMode;
}

export interface DictationStatus {
  state: DictationState;
  sink: DictationSink;
  mode: DictationMode;
  message?: string;
}

export interface DictationPhrase {
  text: string;
  sink: DictationSink;
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
  requestMicrophoneAccess(): Promise<MicrophonePermissionResult>;
  transcribe(wavBytes: Uint8Array): Promise<TranscriptionResult>;
  onModelEvent(listener: (event: ModelEvent) => void): () => void;
  getModelState(): Promise<ModelEvent>;

  getSettings(): Promise<AppSettings>;
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  onSettingsChanged(listener: (settings: AppSettings) => void): () => void;

  getHotkeyStatus(): Promise<HotkeyStatus>;
  onHotkeyStatusChanged(listener: (status: HotkeyStatus) => void): () => void;
  requestHotkeyPermission(scope: "accessibility" | "input-monitoring"): Promise<void>;
  openPrivacySettings(pane: PrivacyPane): Promise<void>;

  toggleDictation(): Promise<void>;
  previewIndicator(): Promise<void>;
  beginOverlayDrag(): void;
  moveOverlay(deltaX: number, deltaY: number): void;
  endOverlayDrag(): void;
  onResourceUsage(listener: (usage: ResourceUsage) => void): () => void;
  getAiStatus(): Promise<AiStatus>;
  setOpenRouterKey(key: string): Promise<AiStatus>;
  clearOpenRouterKey(): Promise<AiStatus>;
  polishSelection(): Promise<void>;
  /** The application menu asking for the settings dialog. */
  onOpenSettings(listener: () => void): () => void;
  getAppVersion(): Promise<string>;
  getStats(): Promise<AppStats>;
  onStatsChanged(listener: (stats: AppStats) => void): () => void;
  onDictationCommand(listener: (command: DictationCommand) => void): () => void;
  onDictationUpdate(listener: (update: DictationUpdate) => void): () => void;
  reportDictationState(status: DictationStatus): void;
  reportDictationPhrase(phrase: DictationPhrase): void;
}
