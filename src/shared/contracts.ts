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
  /** What the list shows: the polished text when there is one, else the transcript. */
  text: string;
  /** Milliseconds since the epoch. */
  createdAt: number;
  /** Whether a local WAV exists for playback. */
  hasAudio?: boolean;
  /** What the speech model returned. Empty when it found no words. */
  transcribedText?: string;
  /** What AI Polish made of it, when it ran. */
  polishedText?: string | null;
  speechModel?: string;
  polishModel?: string | null;
}

/** A name or term the speech engine should get right. */
export interface DictionaryTerm {
  id: number;
  /** How it should be typed. */
  text: string;
  /** What the engine tends to hear instead. */
  heardAs: string[];
  /** Typed by the user, or accepted from a correction they made. */
  source: "manual" | "learned";
  /** Phrases it was prompted into or corrected in. */
  uses: number;
  lastUsedAt: number | null;
  createdAt: number;
}

/** A notice shown beside the Wave Bar, with the window closed or not. */
export interface OverlayNotice {
  text: string;
  durationMs: number;
  action: { kind: "undoDictionary"; ids: number[] } | null;
}

/** A term just learned from a correction, with enough to undo it. */
export interface LearnedTerm {
  id: number;
  text: string;
  heardAs: string;
}

/** A term a transcript edit suggests learning. */
export interface DictionarySuggestion {
  /** What the engine wrote. */
  heardAs: string;
  /** What the user changed it to. */
  text: string;
}

// --- Meetings ---------------------------------------------------------------

export type MeetingState = "recording" | "processing" | "ready" | "failed";
export type MeetingTrack = "mic" | "system";

export interface Meeting {
  id: string;
  title: string;
  /** Milliseconds since the epoch. */
  createdAt: number;
  durationMs: number;
  state: MeetingState;
  /** What processing is doing now, or why it failed. */
  stage: string | null;
  language: string;
  speechModel: string;
  /** Raw speaker label ("me", "speaker_00") to the name the user gave it. */
  speakers: Record<string, string>;
  /** The summary text in its fixed shape, when one has been written. */
  summary: string | null;
  summaryModel: string | null;
  hasSystemAudio: boolean;
  /** What processing skipped or could not do; each becomes a banner with a button. */
  notes: MeetingNote[];
}

export type MeetingNoteKind =
  | "interrupted"
  | "other-side-not-heard"
  | "no-summary-key"
  | "speaker-tool-missing"
  | "summary-failed"
  | "summary-unparsed"
  | "nothing-said";

export interface MeetingNote {
  kind: MeetingNoteKind | string;
  text: string;
}

/** Whether a meeting is recording, for the HUD and the menu bar. */
export interface MeetingStateEvent {
  recording: boolean;
  meetingId: string | null;
  title: string | null;
  startedAt: number | null;
}

export interface MeetingLevelEvent {
  meetingId: string;
  mic: number;
  system: number | null;
  /** False a few seconds in means the other side's permission was not given. */
  otherHeard: boolean;
  elapsedMs: number;
}

export interface MeetingLine {
  idx: number;
  /** Milliseconds from the start of the recording. */
  startMs: number;
  endMs: number;
  track: MeetingTrack;
  /** Raw label; null for a remote line not yet tagged. */
  speaker: string | null;
  text: string;
}

export interface MeetingSummary {
  overview: string;
  topics: { heading: string; points: string[] }[];
  nextSteps: string[];
  decisions: string[];
}

export interface MeetingDetail {
  meeting: Meeting;
  lines: MeetingLine[];
  summary: MeetingSummary | null;
}

export interface RecorderStatus {
  /** The meeting being recorded now, if any. */
  recording: string | null;
  /** "available", "unsupported" (macOS before 14.2), or "missing" (helper not built). */
  systemAudio: "available" | "unsupported" | "missing";
  diarizerInstalled: boolean;
  diarizerBytes: number;
  hasOpenRouterKey: boolean;
  localName: string;
}

export interface DiarizerInstallEvent {
  stage: "downloading" | "ready" | "error";
  message: string;
  progress: number;
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

export type PrivacyPane = "accessibility" | "input-monitoring" | "microphone" | "audio-capture";

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
  /** The version a check found and nobody has installed yet, if any. */
  getUpdateAvailable(): Promise<string | null>;
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
  /**
   * `priorText` is what the current session has transcribed so far; the
   * engine is primed with its tail so a phrase cut mid-sentence continues the
   * sentence. Leave it out for audio with no session behind it.
   */
  transcribe(wavBytes: Uint8Array, priorText?: string): Promise<TranscriptionResult>;
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
  /** Terms just learned from a correction the user made where a dictation landed. */
  onDictionaryLearned(listener: (terms: LearnedTerm[]) => void): () => void;
  /** Something to say beside the Wave Bar; the overlay shows it. */
  onOverlayNotice(listener: (notice: OverlayNotice) => void): () => void;
  /** The Wave Bar finished showing a notice. */
  overlayNoticeDone(): Promise<void>;

  getDictionary(): Promise<DictionaryTerm[]>;
  addDictionaryTerm(text: string, heardAs: string[], learned?: boolean): Promise<DictionaryTerm[]>;
  updateDictionaryTerm(id: number, text: string, heardAs: string[]): Promise<DictionaryTerm[]>;
  removeDictionaryTerm(id: number): Promise<DictionaryTerm[]>;
  /** Adds every term in a pasted, comma- or line-separated list. */
  importDictionary(text: string): Promise<DictionaryTerm[]>;
  declineDictionarySuggestion(suggestion: DictionarySuggestion): Promise<void>;
  onDictionaryChanged(listener: (terms: DictionaryTerm[]) => void): () => void;

  meetingRecorderStatus(): Promise<RecorderStatus>;
  listMeetings(): Promise<Meeting[]>;
  getMeeting(id: string): Promise<MeetingDetail>;
  startMeeting(title?: string): Promise<Meeting>;
  stopMeeting(): Promise<Meeting>;
  /** Ends the recording and throws it away. */
  cancelMeeting(): Promise<void>;
  renameMeeting(id: string, title: string): Promise<Meeting>;
  renameMeetingSpeaker(id: string, label: string, name: string): Promise<Meeting>;
  /** Writes the summary again, after renames or once a key is added. */
  summarizeMeeting(id: string): Promise<MeetingDetail>;
  deleteMeeting(id: string): Promise<void>;
  getMeetingAudio(id: string): Promise<Uint8Array>;
  installDiarizer(): Promise<void>;
  /** Brings the window up on the live meeting. */
  showMeetings(): Promise<void>;
  /**
   * Asks macOS for permission to hear the other side of a call (the first
   * call shows the system prompt) and reports what happened.
   */
  probeSystemAudio(): Promise<"heard" | "silent" | "unsupported" | "missing">;
  cancelDiarizerInstall(): Promise<void>;
  removeDiarizer(): Promise<void>;
  onMeetingLine(listener: (event: { meetingId: string; line: MeetingLine }) => void): () => void;
  onMeetingChanged(listener: (meeting: Meeting) => void): () => void;
  /** Input levels a few times a second while recording; `system` is absent without the other side. */
  onMeetingLevel(listener: (event: MeetingLevelEvent) => void): () => void;
  onMeetingState(listener: (event: MeetingStateEvent) => void): () => void;
  /** The menu bar asked for the Meetings page: "record" starts one, "show" opens the live one. */
  onOpenMeetings(listener: (mode: "record" | "show") => void): () => void;
  /** Runs processing again for an interrupted meeting. */
  finishMeeting(id: string): Promise<void>;
  /** Tags speakers on a meeting recorded before the speaker tool was installed. */
  tagMeetingSpeakers(id: string): Promise<void>;
  /** Microphone level while dictating, a few times a second, for the Dictation page's meter. */
  onCaptureLevel(listener: (level: number) => void): () => void;
  onMeetingsChanged(listener: () => void): () => void;
  onDiarizerInstall(listener: (event: DiarizerInstallEvent) => void): () => void;
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
