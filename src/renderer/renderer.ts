import type {
  AiStatus,
  AppStats,
  ModelFit,
  SavedDictation,
  DictationUpdate,
  HotkeyStatus,
  MicrophoneDevice,
  LogLine,
  ModelEvent,
  ModelStatus,
  PolishModelStatus,
  ResourceUsage,
  UpdateEvent,
} from "../shared/contracts";
import {
  HOTKEY_BINDINGS,
  getHotkeyBinding,
  hotkeyKeycap,
  hotkeyMenuLabel,
  isHotkeyBindingId,
  type HotkeyBindingId,
} from "../shared/hotkeys";
import {
  getSpeechModel,
  isSpeechModelId,
  type SpeechModelId,
} from "../shared/models";
import {
  DEFAULT_LADDER_INDEX,
  DEFAULT_LADDER_MODEL_ID,
  MODEL_LADDER,
  chooseModel,
  ladderIndexOf,
  ladderRung,
} from "../shared/model-ladder";
import { SPEECH_LANGUAGES, isSpeechLanguage } from "../shared/languages";
import { microphoneDevices } from "../shared/microphones";
import { audioFileToMonoWav, isAudioFile } from "./audio/file-wav";
import { DEFAULT_SETTINGS, POLISH_SHORTCUTS, type AppSettings } from "../shared/settings";
import { isPolishLevel, type PolishLevel } from "../shared/polish-levels";
import { DEFAULT_POLISH_MODEL_ID, isPolishModelId } from "../shared/polish-models";
import {
  DEFAULT_POLISH_PROMPT,
  SUGGESTED_MODELS,
  transformPromptFor,
} from "../shared/prompts";
import { host } from "./host";
import { installTauriBridge } from "./tauri-bridge";

const element = {
  history: requireElement<HTMLElement>("history"),
  dictationDeck: requireElement<HTMLElement>("dictation-deck"),
  emptyState: requireElement<HTMLElement>("empty-state"),
  dictateNote: requireElement<HTMLElement>("dictate-note"),
  shortcutHint: requireElement<HTMLElement>("shortcut-hint"),
  search: requireElement<HTMLElement>("search"),
  searchButton: requireElement<HTMLButtonElement>("search-button"),
  searchField: requireElement<HTMLInputElement>("search-field"),
  settingsButton: requireElement<HTMLButtonElement>("settings-button"),
  settingsPanel: requireElement<HTMLElement>("settings-panel"),
  app: requireElement<HTMLElement>("app-shell"),
  sidebarToggle: requireElement<HTMLButtonElement>("sidebar-toggle"),
  scrim: requireElement<HTMLElement>("scrim"),
  versionLine: requireElement<HTMLElement>("version-line"),
  appBrand: requireElement<HTMLElement>("app-brand"),
  modelList: requireElement<HTMLElement>("model-list"),
  openOpenRouter: requireElement<HTMLButtonElement>("open-openrouter"),
  overlayPreview: requireElement<HTMLButtonElement>("overlay-preview"),
  overlayReset: requireElement<HTMLButtonElement>("overlay-reset"),
  onboard: requireElement<HTMLElement>("onboard"),
  onboardSteps: requireElement<HTMLElement>("onboard-steps"),
  onboardCount: requireElement<HTMLElement>("onboard-count"),
  onboardBar: requireElement<HTMLElement>("onboard-bar"),
  speechLanguage: requireElement<HTMLSelectElement>("speech-language"),
  microphoneSelect: requireElement<HTMLSelectElement>("microphone-select"),
  hotkeySelect: requireElement<HTMLSelectElement>("hotkey-select"),
  themeToggle: requireElement<HTMLElement>("theme-toggle"),
  menubarToggle: requireElement<HTMLInputElement>("menubar-toggle"),
  launchAtLoginToggle: requireElement<HTMLInputElement>("launch-at-login-toggle"),
  flowBarToggle: requireElement<HTMLInputElement>("flow-bar-toggle"),
  dockToggle: requireElement<HTMLInputElement>("dock-toggle"),
  logView: requireElement<HTMLElement>("log-view"),
  logFollow: requireElement<HTMLInputElement>("log-follow"),
  logCopy: requireElement<HTMLButtonElement>("log-copy"),
  logClear: requireElement<HTMLButtonElement>("log-clear"),
  updateToggle: requireElement<HTMLInputElement>("update-toggle"),
  updateCheck: requireElement<HTMLButtonElement>("update-check"),
  aboutVersion: requireElement<HTMLElement>("about-version"),
  openRepository: requireElement<HTMLButtonElement>("open-repository"),
  openProfile: requireElement<HTMLButtonElement>("open-profile"),
  openDonate: requireElement<HTMLButtonElement>("open-donate"),
  openSite: requireElement<HTMLButtonElement>("open-site"),
  hintKey: requireElement<HTMLElement>("hint-key"),
  emptyHeadline: requireElement<HTMLElement>("empty-headline"),
  emptyHint: requireElement<HTMLElement>("empty-hint"),
  starter: requireElement<HTMLElement>("starter"),
  starterKey: document.querySelector<HTMLElement>(".starter-key")!,
  deckStatus: requireElement<HTMLElement>("deck-status"),
  deckTitle: requireElement<HTMLElement>("deck-title"),
  deckDescription: requireElement<HTMLElement>("deck-description"),
  deckKey: requireElement<HTMLElement>("deck-key"),
  deckSettings: requireElement<HTMLButtonElement>("deck-settings"),
  gestureKeyHold: requireElement<HTMLElement>("gesture-key-hold"),
  gestureKeyTap: requireElement<HTMLElement>("gesture-key-tap"),
  fnNote: requireElement<HTMLElement>("fn-note"),
  setupBadge: requireElement<HTMLElement>("setup-badge"),
  setupLede: requireElement<HTMLElement>("setup-lede"),
  checklist: requireElement<HTMLElement>("checklist"),
  transcribeDrop: requireElement<HTMLElement>("transcribe-drop"),
  transcribeFile: requireElement<HTMLInputElement>("transcribe-file"),
  transcribeDropTitle: requireElement<HTMLElement>("transcribe-drop-title"),
  transcribeDropHint: requireElement<HTMLElement>("transcribe-drop-hint"),
  transcribeResult: requireElement<HTMLElement>("transcribe-result"),
  transcribeFileName: requireElement<HTMLElement>("transcribe-file-name"),
  transcribeText: requireElement<HTMLElement>("transcribe-text"),
  transcribeCopy: requireElement<HTMLButtonElement>("transcribe-copy"),
  transcribeClear: requireElement<HTMLButtonElement>("transcribe-clear"),
  transcribeNote: requireElement<HTMLElement>("transcribe-note"),
  statWords: requireElement<HTMLElement>("stat-words"),
  statPhrases: requireElement<HTMLElement>("stat-phrases"),
  statSessions: requireElement<HTMLElement>("stat-sessions"),
  overviewModel: requireElement<HTMLElement>("overview-model"),
  overviewModelState: requireElement<HTMLElement>("overview-model-state"),
  overviewCpu: requireElement<HTMLElement>("overview-cpu"),
  overviewMemory: requireElement<HTMLElement>("overview-memory"),
  overviewEngineMemory: requireElement<HTMLElement>("overview-engine-memory"),
  keyInput: requireElement<HTMLInputElement>("key-input"),
  keySave: requireElement<HTMLButtonElement>("key-save"),
  keyRemove: requireElement<HTMLButtonElement>("key-remove"),
  keyState: requireElement<HTMLElement>("key-state"),
  aiModel: requireElement<HTMLSelectElement>("ai-model"),
  polishLevels: requireElement<HTMLElement>("polish-levels"),
  polishLevelHint: requireElement<HTMLElement>("polish-level-hint"),
  transformPromptWhere: requireElement<HTMLElement>("transform-prompt-where"),
  transformPromptPreview: requireElement<HTMLElement>("transform-prompt-preview"),
  polishPromptPreview: requireElement<HTMLElement>("polish-prompt-preview"),
  polishShortcut: requireElement<HTMLSelectElement>("polish-shortcut"),
  polishEngine: requireElement<HTMLElement>("polish-engine"),
  polishModelList: requireElement<HTMLElement>("polish-model-list"),
  promptEditor: requireElement<HTMLElement>("prompt-editor"),
  promptEditorTitle: requireElement<HTMLElement>("prompt-editor-title"),
  promptEditorWhere: requireElement<HTMLElement>("prompt-editor-where"),
  promptEditorBody: requireElement<HTMLTextAreaElement>("prompt-editor-body"),
  promptEditorReset: requireElement<HTMLButtonElement>("prompt-editor-reset"),
  promptEditorSave: requireElement<HTMLButtonElement>("prompt-editor-save"),
  wizard: requireElement<HTMLElement>("wizard"),
  wizardBrand: requireElement<HTMLElement>("wizard-brand"),
  wizardNext: requireElement<HTMLButtonElement>("wizard-next"),
  ladderSlider: requireElement<HTMLInputElement>("ladder-slider"),
  ladderName: requireElement<HTMLElement>("ladder-name"),
  ladderModel: requireElement<HTMLElement>("ladder-model"),
  ladderTrade: requireElement<HTMLElement>("ladder-trade"),
  ladderTicks: requireElement<HTMLElement>("ladder-ticks"),
  ladderFacts: requireElement<HTMLElement>("ladder-facts"),
  ladderNote: requireElement<HTMLElement>("ladder-note"),
  keyboard: requireElement<HTMLElement>("keyboard"),
  keyboardCaption: requireElement<HTMLElement>("keyboard-caption"),
  wizardFnNote: requireElement<HTMLElement>("wizard-fn-note"),
  wizardChecklist: requireElement<HTMLElement>("wizard-checklist"),
  wizardPermissionsNote: requireElement<HTMLElement>("wizard-permissions-note"),
  wizardPolishLevels: requireElement<HTMLElement>("wizard-polish-levels"),
  wizardEngineRow: requireElement<HTMLElement>("wizard-engine-row"),
  wizardEngine: requireElement<HTMLElement>("wizard-engine"),
  wizardEngineNote: requireElement<HTMLElement>("wizard-engine-note"),
  wizardEngineDetail: requireElement<HTMLElement>("wizard-engine-detail"),
  wizardKeyRow: requireElement<HTMLElement>("wizard-key-row"),
  wizardLocalRow: requireElement<HTMLElement>("wizard-local-row"),
  wizardLocalName: requireElement<HTMLElement>("wizard-local-name"),
  wizardLocalState: requireElement<HTMLElement>("wizard-local-state"),
  wizardLocalTrack: requireElement<HTMLElement>("wizard-local-track"),
  wizardLocalBar: requireElement<HTMLElement>("wizard-local-bar"),
  wizardKeyInput: requireElement<HTMLInputElement>("wizard-key-input"),
  wizardKeySave: requireElement<HTMLButtonElement>("wizard-key-save"),
  wizardKeyState: requireElement<HTMLElement>("wizard-key-state"),
  wizardOpenOpenRouter: requireElement<HTMLButtonElement>("wizard-open-openrouter"),
  readyTitle: requireElement<HTMLElement>("ready-title"),
  readyProgress: requireElement<HTMLElement>("ready-progress"),
  readySpeechRow: requireElement<HTMLElement>("ready-speech-row"),
  readySpeechName: requireElement<HTMLElement>("ready-speech-name"),
  readySpeechState: requireElement<HTMLElement>("ready-speech-state"),
  readySpeechBar: requireElement<HTMLElement>("ready-speech-bar"),
  readyPolishRow: requireElement<HTMLElement>("ready-polish-row"),
  readyPolishName: requireElement<HTMLElement>("ready-polish-name"),
  readyPolishState: requireElement<HTMLElement>("ready-polish-state"),
  readyPolishBar: requireElement<HTMLElement>("ready-polish-bar"),
  readyKey: requireElement<HTMLElement>("ready-key"),
  readyKeyTap: requireElement<HTMLElement>("ready-key-tap"),
};

let settings: AppSettings = DEFAULT_SETTINGS;
let hotkeyStatus: HotkeyStatus | null = null;
let modelReady = false;
let modelLoading = false;
/** The model whose weights are being fetched, so a second press does nothing. */
let downloading: SpeechModelId | null = null;
/** The same, for the polish models, which are fetched from their own page. */
let polishDownloading: string | null = null;
/** The last thing the host said about the AI side, so a change in one half of
    it -- a key saved, a model downloaded -- can be redrawn with the other. */
let aiStatus: AiStatus | null = null;
/** Whether the chosen model's weights are here, which is a setup step. */
let modelInstalled = false;
/** How big the chosen model's download is, for the step that offers it. */
let modelDownloadSize = "";
/** The same three facts for the polish model, which is a step of its own. */
let polishInstalled = false;
let polishLabel = "";
let polishDownloadSize = "";
/**
 * Whether the catalogue has been read once.
 *
 * Until it has, and until the permissions have come back, nothing is known
 * about whether setup is finished -- and guessing shows the wrong card. An
 * install in daily use would open on the onboarding panel for the length of
 * one round trip and then replace it, which reads as a glitch.
 */
let setupKnown = false;
/** The version the app is running, for the About page and the sidebar. */
let appVersion = "";
/** Whether the About button is asking for a check or installing one. */
let updateAction: "check" | "install" = "check";
/** Everything the log has said this session, oldest first. */
let logLines: LogLine[] = [];
let settingsOpen = false;
/** Which instruction the popup is editing, if any. */
let promptEditorKind: "transform" | "polish" | null = null;
/** Whether closing the popup should put the settings panel back where it was. */
let promptEditorFromSettings = false;
let entries: SavedDictation[] = [];
let freshId: string | null = null;
/**
 * A failed dictation whose audio is still held for Retry.
 *
 * Null when there is nothing to retry. Cleared on dismiss, a successful
 * re-transcription, or a new listen.
 */
let pendingRetry: { message: string } | null = null;
/** Active history playback, if any. The list does not re-render for it. */
let playback: {
  id: string;
  audio: HTMLAudioElement;
  context: AudioContext;
  url: string;
  button: HTMLButtonElement;
} | null = null;
/** True while a dropped file is being decoded or transcribed. */
let transcribeBusy = false;
let lifetimeSessions = 0;
let searchOpen = false;
let query = "";
let microphones: MicrophoneDevice[] = [];
/** Which page of the first-run wizard is up, or null when it is not open. */
let wizardStep: WizardStep | null = null;
/**
 * How each model sits in this Mac's memory, and whether its weights are here.
 *
 * The slider asks the catalogue nothing as it moves: a round trip per drag
 * would be forty of them, and the answer -- how much memory this machine has
 * -- cannot change while a window is open. The installed half is re-read each
 * time a prefetch finishes, which is the only thing that changes it.
 */
let wizardCatalog = new Map<string, ModelStatus>();
/**
 * Models the wizard is fetching without being asked, in the order it wants
 * them. The host runs one download at a time -- a second call while one is
 * running comes back "A download is already running." -- so this is drained
 * one at a time rather than started at once.
 */
let prefetchQueue: SpeechModelId[] = [];
let prefetchRunning = false;
/** Poll handle for the permissions page; null when that page is not up. */
let permissionWatch: ReturnType<typeof setInterval> | null = null;
/** Frame handle for the slider's glide, null when it is not moving on its own. */
let ladderGlide: number | null = null;
/**
 * Whether a pointer is down on the slider, and whether it has moved since.
 *
 * The difference between a click on the track and the start of a drag, which
 * a range input reports identically: both arrive as an `input` event with a
 * new value. A click should glide to where you aimed; a drag has to stay
 * under the finger.
 */
let ladderPointerDown = false;
let ladderPointerMoved = false;
/** The rung the card is currently describing, so a glide is not 60 rebuilds. */
let ladderShownRung = -1;
/** Whether the slider has been moved, which turns a default into a choice. */
let ladderTouched = false;
/** The polish model's last known state, for the pages that report on it. */
let wizardPolishModel: PolishModelStatus | null = null;
/** Latest percent for each download, so the last page can draw a bar. */
let speechPercent = 0;
let polishPercent = 0;
/**
 * Where the slider sits, which is not yet what has been chosen.
 *
 * Fractional while a drag is in progress. The track is continuous so the
 * thumb follows the pointer instead of jumping between five stops, and the
 * rung is whichever one it is nearest; letting go snaps it onto that rung.
 */
let ladderIndex: number = DEFAULT_LADDER_INDEX;

// Supplies window.waveform under Tauri; a no-op under Electron.
installTauriBridge();

void bootstrap();

async function bootstrap(): Promise<void> {
  populateSelects();
  wireEvents();

  applySettings(await host().getSettings());
  void refreshMicrophones();
  renderStats(await host().getStats());
  entries = await host().getHistory();
  renderHistory();
  // Falls back to the bare name: a version that failed to load should not be
  // rendered as "Waveform null".
  appVersion = await host().getAppVersion().catch(() => "");
  const appName = await host().getAppName().catch(() => "Waveform");
  document.title = appName;
  element.appBrand.textContent = appName;
  element.wizardBrand.textContent = appName;
  element.versionLine.textContent = appVersion ? `${appName} ${appVersion}` : appName;
  element.aboutVersion.textContent = appVersion ? `${appName} ${appVersion}` : appName;
  // Pull the engine's current stage: any event it pushed while this window was
  // still loading is already gone.
  handleModelEvent(await host().getModelState());

  hotkeyStatus = await host().getHotkeyStatus();
  renderHotkeyStatus();
  renderAiStatus(await host().getAiStatus());
  await refreshModelInstalled();
  // Last, because it reads the settings, the lifetime count, the permissions
  // and the catalogue -- and opening on a guess at any of them would show the
  // wrong page and then correct itself, which reads as a glitch.
  maybeOpenWizard();
}

function wireEvents(): void {
  wireWizard();
  host().onModelEvent(handleModelEvent);
  host().onPolishModelEvent(showPolishDownloadProgress);
  host().onUpdateEvent(handleUpdateEvent);
  host().onLogLine(handleLogLine);
  host().onSettingsChanged(applySettings);
  host().onHotkeyStatusChanged((next) => {
    hotkeyStatus = next;
    renderHotkeyStatus();
  });
  host().onDictationUpdate(handleDictationUpdate);
  navigator.mediaDevices?.addEventListener("devicechange", () => void refreshMicrophones());
  host().onResourceUsage(renderResourceUsage);
  host().onOpenSettings(() => toggleSettings(true));
  host().onOpenMicrophoneSettings(() => toggleSettings(true, "dictation"));
  host().onOpenModelSettings(() => {
    toggleSettings(false);
    showView("models");
  });
  host().onOpenShortcutSettings(() => toggleSettings(true, "dictation"));
  host().onStatsChanged(renderStats);
  host().onHistoryChanged((next) => {
    // The newest entry is the one that just landed, so it gets the tint.
    freshId = next.length > entries.length ? (next[0]?.id ?? null) : null;
    entries = next;
    renderHistory();
  });

  bindGroup(".nav[aria-label='Sections'] [data-view]", (button) =>
    showView(button.dataset.view ?? "dictate"),
  );
  bindGroup(".modal-nav [data-page]", (button) =>
    showSettingsPage(button.dataset.page ?? "general"),
  );

  // Without this the field blurs on mousedown, closes itself, and the click
  // that followed reopened it: the icon could never close an empty search.
  element.searchButton.addEventListener("mousedown", (event) => event.preventDefault());
  element.searchButton.addEventListener("click", () => toggleSearch(!searchOpen));
  element.searchField.addEventListener("input", () => {
    query = element.searchField.value.trim();
    renderHistory();
  });
  element.searchField.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      toggleSearch(false);
    }
  });
  // Closing an empty field tidies the head; a field with a term in it stays,
  // so clicking an entry does not silently drop the filter behind it.
  element.searchField.addEventListener("blur", () => {
    if (query === "") toggleSearch(false);
  });

  element.settingsButton.addEventListener("click", () => toggleSettings(!settingsOpen));
  element.sidebarToggle.addEventListener("click", () => {
    // Written straight to the grid as well as saved, so the rail folds now
    // rather than after the host has been round-tripped.
    const collapsed = !settings.sidebarCollapsed;
    settings = { ...settings, sidebarCollapsed: collapsed };
    renderSidebarCollapsed();
    void patchSettings({ sidebarCollapsed: collapsed });
  });
  element.scrim.addEventListener("click", () => {
    if (promptEditorKind) togglePromptEditor(false);
    else toggleSettings(false);
  });
  element.deckSettings.addEventListener("click", () => {
    toggleSettings(true, setupSteps().some((step) => !step.done) ? "setup" : "dictation");
  });

  bindTranscribeDrop();

  // Closing the window hides it rather than quitting; a recording must not
  // keep playing from a window nobody can see.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopPlayback();
  });

  // Delegated rather than bound per button: both the onboarding card and the
  // Setup page rebuild their rows whenever a step completes.
  for (const container of [element.onboardSteps, element.checklist]) {
    container.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>("[data-fix]");
      if (button) resolveSetupStep(button.dataset.fix ?? "");
    });
  }
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (promptEditorKind) togglePromptEditor(false);
    else if (settingsOpen) toggleSettings(false);
  });

  element.modelList.addEventListener("click", (event) => {
    // The card link sits inside the row, so it is checked first: otherwise
    // reading about a model would also switch to it. Download, cancel and
    // delete are the same kind of exception.
    const card = (event.target as HTMLElement).closest<HTMLElement>("[data-card]");
    if (card?.dataset.card) {
      void host().openUrl(card.dataset.card);
      return;
    }
    const remove = (event.target as HTMLElement).closest<HTMLElement>("[data-remove]");
    if (remove?.dataset.remove && isSpeechModelId(remove.dataset.remove)) {
      void deleteModel(remove.dataset.remove);
      return;
    }
    const fetch = (event.target as HTMLElement).closest<HTMLElement>("[data-fetch]");
    if (fetch?.dataset.fetch && isSpeechModelId(fetch.dataset.fetch)) {
      void downloadModel(fetch.dataset.fetch);
      return;
    }
    const cancel = (event.target as HTMLElement).closest<HTMLElement>("[data-cancel-download]");
    if (cancel) {
      void host().cancelModelDownload();
      return;
    }
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-model]");
    const id = row?.dataset.model;
    if (!id || !isSpeechModelId(id)) return;
    if (row?.getAttribute("aria-disabled") === "true") return;
    void host().selectModel(id);
  });
  element.polishEngine.addEventListener("click", (event) => {
    const engine = (event.target as HTMLElement).closest<HTMLElement>("[data-engine]")
      ?.dataset.engine;
    if (engine === "local" || engine === "openrouter") {
      void patchSettings({ polishEngine: engine });
    }
  });

  // Installed polish models are chosen by the row; missing ones only by their
  // Download button, so a press meant for the HF link cannot start a fetch.
  element.polishModelList.addEventListener("click", (event) => {
    const card = (event.target as HTMLElement).closest<HTMLElement>("[data-card]");
    if (card?.dataset.card) {
      void host().openUrl(card.dataset.card);
      return;
    }
    const remove = (event.target as HTMLElement).closest<HTMLElement>("[data-remove]");
    if (remove?.dataset.remove && isPolishModelId(remove.dataset.remove)) {
      void deletePolishModel(remove.dataset.remove);
      return;
    }
    const fetch = (event.target as HTMLElement).closest<HTMLElement>("[data-fetch]");
    if (fetch?.dataset.fetch && isPolishModelId(fetch.dataset.fetch)) {
      void downloadPolishModel(fetch.dataset.fetch);
      return;
    }
    const cancel = (event.target as HTMLElement).closest<HTMLElement>("[data-cancel-download]");
    if (cancel) {
      void host().cancelPolishModelDownload();
      return;
    }
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-model]");
    const id = row?.dataset.model;
    if (!id || !isPolishModelId(id)) return;
    if (row?.getAttribute("aria-disabled") === "true") return;
    void patchSettings({ localModelId: id });
  });

  element.speechLanguage.addEventListener("change", () => {
    const value = element.speechLanguage.value;
    if (isSpeechLanguage(value)) void patchSettings({ speechLanguage: value });
  });
  element.microphoneSelect.addEventListener("change", () => {
    const id = element.microphoneSelect.value;
    const device = microphones.find((candidate) => candidate.id === id);
    void patchSettings({
      microphoneDeviceId: id,
      microphoneDeviceName: device?.label ?? "",
    });
  });
  element.hotkeySelect.addEventListener("change", () => {
    const value = element.hotkeySelect.value;
    if (isHotkeyBindingId(value)) void patchSettings({ hotkeyId: value });
  });
  element.themeToggle.addEventListener("click", (event) => {
    const theme = (event.target as HTMLElement).closest<HTMLElement>("[data-theme-value]")
      ?.dataset.themeValue;
    if (theme === "system" || theme === "light" || theme === "dark") {
      void patchSettings({ theme });
    }
  });
  // Typing anything means the field no longer holds the placeholder mask.
  element.keyInput.addEventListener("input", () => {
    element.keyInput.dataset.pristine = "false";
    syncKeyButtons();
  });
  // Save is the only way the key changes. Typing edits the field and nothing
  // more, so a half-pasted key cannot be committed by a stray keystroke.
  element.keySave.addEventListener("click", saveApiKey);
  element.keyRemove.addEventListener("click", removeApiKey);
  element.aiModel.addEventListener("change", () => {
    void patchSettings({ openRouterModel: element.aiModel.value });
  });
  // A level is also an instruction, so choosing one writes that instruction.
  // An edit made to the previous level's text is not carried across: it was
  // written about a different amount of rewriting. None writes nothing, so
  // turning polish off and on again leaves an edited instruction alone.
  element.polishLevels.addEventListener("click", (event) => {
    const card = (event.target as HTMLElement).closest<HTMLElement>("[data-level]");
    const level = card?.dataset.level;
    if (!isPolishLevel(level) || level === settings.polishLevel) return;
    void patchSettings(
      level === "none"
        ? { polishLevel: level }
        : { polishLevel: level, transformPrompt: transformPromptFor(level) },
    );
  });
  element.polishShortcut.addEventListener("change", () => {
    void patchSettings({ polishShortcut: element.polishShortcut.value });
  });
  for (const card of Array.from(
    document.querySelectorAll<HTMLButtonElement>(".prompt-card[data-prompt]"),
  )) {
    card.addEventListener("click", () => {
      const kind = card.dataset.prompt;
      if (kind === "transform" || kind === "polish") togglePromptEditor(true, kind);
    });
  }
  element.promptEditorReset.addEventListener("click", () => {
    if (!promptEditorKind) return;
    element.promptEditorBody.value =
      promptEditorKind === "transform"
        ? transformPromptFor(settings.polishLevel)
        : DEFAULT_POLISH_PROMPT;
    element.promptEditorBody.focus();
  });
  element.promptEditorSave.addEventListener("click", () => {
    if (!promptEditorKind) return;
    const value = element.promptEditorBody.value;
    const patch =
      promptEditorKind === "transform" ? { transformPrompt: value } : { polishPrompt: value };
    void patchSettings(patch).then(() => togglePromptEditor(false));
  });

  element.menubarToggle.addEventListener("change", () => {
    void patchSettings({ menuBarIcon: element.menubarToggle.checked });
  });
  element.launchAtLoginToggle.addEventListener("change", () => {
    void patchSettings({ launchAtLogin: element.launchAtLoginToggle.checked });
  });
  element.flowBarToggle.addEventListener("change", () => {
    void patchSettings({ showFlowBarAlways: element.flowBarToggle.checked });
  });
  element.logCopy.addEventListener("click", () => {
    const text = logLines
      .map((line) => `${new Date(line.at).toISOString()} ${line.source} ${line.message}`)
      .join("\n");
    void navigator.clipboard.writeText(text);
  });
  element.logClear.addEventListener("click", () => {
    void host().clearLogs();
    logLines = [];
    renderLogs();
  });
  element.updateToggle.addEventListener("change", () => {
    void patchSettings({ automaticUpdateCheck: element.updateToggle.checked });
  });
  element.updateCheck.addEventListener("click", () => {
    if (updateAction === "install") {
      void installUpdate();
      return;
    }
    void checkForUpdate();
  });
  element.openRepository.addEventListener("click", () => {
    void host().openUrl("https://github.com/vipinsight/waveform");
  });
  element.openProfile.addEventListener("click", () => {
    void host().openUrl("https://x.com/vip_iny");
  });
  element.openDonate.addEventListener("click", () => {
    void host().openUrl("https://buymeacoffee.com/vip_iny");
  });
  element.openSite.addEventListener("click", () => {
    void host().openUrl("https://vipinyadav.com");
  });
  element.openOpenRouter.addEventListener("click", () => {
    void host().openUrl("https://openrouter.ai/keys");
  });
  // Both were documented and neither existed. Between them they are the only
  // way to find a Wave Bar that has been dragged somewhere unfortunate, or to
  // see what it looks like without holding the key and saying something.
  element.overlayPreview.addEventListener("click", () => {
    void host().previewIndicator();
  });
  element.overlayReset.addEventListener("click", () => {
    void patchSettings({ overlayX: null, overlayY: null, overlayCx: null, overlayCy: null });
  });
  element.dockToggle.addEventListener("change", () => {
    void patchSettings({ hideDockWhenClosed: !element.dockToggle.checked });
  });

}

/** Wires a set of buttons that behave as one exclusive selection. */
function bindGroup(selector: string, onSelect: (button: HTMLElement) => void): void {
  for (const button of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
    button.addEventListener("click", () => onSelect(button));
  }
}

function showView(view: string): void {
  // Recordings play from the Transcripts list; leaving it leaves them.
  if (view !== "dictate") stopPlayback();
  for (const button of Array.from(
    document.querySelectorAll<HTMLElement>(".nav[aria-label='Sections'] [data-view]"),
  )) {
    const active = button.dataset.view === view;
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  for (const id of ["dictate", "transcribe", "overview", "models", "ai"]) {
    requireElement<HTMLElement>(`view-${id}`).hidden = id !== view;
  }
  // Both lists describe files on the disk, which arrive while the section is
  // closed -- from a download here, or from a terminal -- so each is re-read on
  // the way in rather than trusted from startup.
  if (view === "models") void renderModels();
  // The levels say what they need before they can run, and what they need is
  // a key or a download that could have arrived while the section was closed.
  if (view === "ai") void host().getAiStatus().then(renderAiStatus);
}

function showSettingsPage(page: string): void {
  for (const button of Array.from(
    document.querySelectorAll<HTMLElement>(".modal-nav [data-page]"),
  )) {
    const active = button.dataset.page === page;
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  for (const section of Array.from(
    document.querySelectorAll<HTMLElement>(".settings-page"),
  )) {
    section.hidden = section.dataset.page !== page;
  }
  if (page === "dictation") void refreshMicrophones(true);
  // Weights arrive while the page is closed -- from a download here, or from a
  // terminal -- so the list is re-read on the way in rather than trusted.
  if (page === "ai") void renderPolishModels();
  // Lines pushed while the page was closed are in the buffer, not on screen.
  if (page === "logs") void loadLogs();
}

/**
 * Fills the log page from the buffer Rust holds.
 *
 * Pulled rather than accumulated from events alone: this window can open long
 * after the interesting part, and the engine says most of what matters while
 * it is starting.
 */
async function loadLogs(): Promise<void> {
  logLines = await host().getLogs().catch(() => []);
  renderLogs();
}

function renderLogs(): void {
  const view = element.logView;
  // Measured before the write, because appending changes both numbers.
  const pinned = element.logFollow.checked;
  view.replaceChildren(
    ...logLines.map((line) => {
      const row = document.createElement("div");
      const time = document.createElement("b");
      time.textContent = new Date(line.at).toLocaleTimeString([], { hour12: false });
      const source = document.createElement("i");
      source.textContent = ` ${line.source} `;
      const message =
        line.level === "error"
          ? document.createElement("s")
          : document.createElement("span");
      message.textContent = line.message;
      row.append(time, source, message);
      return row;
    }),
  );
  if (pinned) view.scrollTop = view.scrollHeight;
}

function handleLogLine(line: LogLine): void {
  logLines.push(line);
  // The same cap Rust keeps, so a long session does not grow this window's
  // copy without bound.
  if (logLines.length > 400) logLines.shift();
  const page = element.logView.closest<HTMLElement>(".settings-page");
  if (page && !page.hidden) renderLogs();
}

async function patchSettings(patch: Partial<AppSettings>): Promise<void> {
  applySettings(await host().updateSettings(patch));
}

function applySettings(next: AppSettings): void {
  settings = next;
  if (next.theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = next.theme;

  void renderModels();
  renderLanguageSelect();
  renderMicrophoneSelect();
  element.hotkeySelect.value = next.hotkeyId;
  element.menubarToggle.checked = next.menuBarIcon;
  element.launchAtLoginToggle.checked = next.launchAtLogin;
  element.flowBarToggle.checked = next.showFlowBarAlways;
  element.updateToggle.checked = next.automaticUpdateCheck;
  element.dockToggle.checked = !next.hideDockWhenClosed;
  renderSidebarCollapsed();
  // Without a menu bar icon there would be no way back to the window.
  element.dockToggle.disabled = !next.menuBarIcon;
  // A model chosen before this list existed is still a valid choice, so it is
  // added rather than silently swapped for the first option.
  if (!SUGGESTED_MODELS.some((model) => model === next.openRouterModel)) {
    element.aiModel.append(new Option(next.openRouterModel, next.openRouterModel));
  }
  element.aiModel.value = next.openRouterModel;
  renderPolishEngine(next.polishEngine);
  renderPolishLevel(next.polishLevel);
  renderPromptPreviews(next);
  element.polishShortcut.value = next.polishShortcut;
  renderThemeToggle(next.theme);

  const model = getSpeechModel(next.modelId);
  element.overviewModel.textContent = model.label;

  renderHotkeyLabels();
  renderHotkeyStatus();
  renderDictationDeck();
  // Every control in the wizard writes through the host and reads back from
  // here, so this is what actually ticks the card that was clicked.
  renderWizard();
  // Choosing a different model can un-finish setup: the new one's weights are
  // very likely not here.
  void refreshModelInstalled();
}

function populateSelects(): void {
  element.hotkeySelect.append(new Option("Off", "none"));
  for (const binding of HOTKEY_BINDINGS) {
    element.hotkeySelect.append(new Option(hotkeyMenuLabel(binding), binding.id));
  }

  for (const accelerator of POLISH_SHORTCUTS) {
    element.polishShortcut.append(
      new Option(describeAccelerator(accelerator), accelerator),
    );
  }
  for (const model of SUGGESTED_MODELS) {
    element.aiModel.append(new Option(model, model));
  }
}

/**
 * Browser media APIs own device enumeration; Rust receives this list for tray
 * controls. When `requestLabels` is true, getUserMedia is what surfaces the
 * macOS microphone prompt — opening Privacy settings alone never asks.
 */
async function refreshMicrophones(requestLabels = false): Promise<boolean> {
  try {
    if (requestLabels) {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    microphones = microphoneDevices(devices);
    renderMicrophoneSelect();
    await host().setAvailableMicrophones(microphones);
    return true;
  } catch {
    // Device enumeration is unavailable until WebKit can access media devices.
    // The system-default option remains usable and capture will request access.
    return false;
  }
}

function renderMicrophoneSelect(): void {
  const selected = settings.microphoneDeviceId;
  // The list carries the system default as its first entry, so there is no
  // case for it here.
  element.microphoneSelect.replaceChildren(
    ...microphones.map((device) => new Option(device.displayLabel, device.id)),
  );
  if (microphones.length === 0) {
    element.microphoneSelect.append(new Option("Auto-detect", ""));
  }
  if (selected && !microphones.some((device) => device.id === selected)) {
    element.microphoneSelect.append(
      new Option(`Unavailable: ${settings.microphoneDeviceName || "microphone"}`, selected),
    );
  }
  element.microphoneSelect.value = selected;
}

/** Renders an Electron accelerator the way macOS writes it. */
function describeAccelerator(accelerator: string): string {
  if (accelerator === "none") return "Off";
  return accelerator.replace("Alt+", "⌥");
}

/**
 * A stand-in for a saved key.
 *
 * The key is write-only: it goes to the keychain and is never handed back, so
 * the field can only ever show that one exists. `pristine` marks the mask as
 * untouched, which is what stops Save from writing these bullets in as the key.
 */
const KEY_MASK = "•".repeat(20);

function renderAiStatus(status: AiStatus): void {
  aiStatus = status;
  // The wizard shows the same key, so it is repainted from the same status.
  if (wizardStep === "polish") renderWizardKey();
  // Never overwrite an edit in progress: reopening settings used to discard a
  // key that had been typed but not yet saved.
  if (element.keyInput.dataset.pristine !== "false") {
    element.keyInput.value = status.hasApiKey ? KEY_MASK : "";
    element.keyInput.dataset.pristine = "true";
  }
  element.keyState.classList.toggle("key-saved", status.hasApiKey && !status.memoryOnly);

  element.keyState.textContent = status.memoryOnly ? "This session only" : "";

  // Nothing to fetch once there is a key, and the row is long enough already.
  element.openOpenRouter.hidden = status.hasApiKey;
  element.keyRemove.hidden = !status.hasApiKey;
  syncKeyButtons();

  // Nothing above None can run until there is something to run it with, so
  // the levels that need one say where to get it rather than being selectable
  // and then quietly doing nothing.
  const ready = status.engine === "local" ? status.localReady : status.hasApiKey;
  element.polishLevelHint.textContent = ready
    ? ""
    : status.engine === "local"
      ? "Download a model in Settings → AI polish to use these."
      : "Add an OpenRouter key in Settings → AI polish to use these.";
  element.polishLevelHint.hidden = ready;
  for (const card of polishLevelCards()) {
    card.disabled = !ready && card.dataset.level !== "none";
  }
}

function polishLevelCards(): HTMLButtonElement[] {
  return Array.from(element.polishLevels.querySelectorAll<HTMLButtonElement>("[data-level]"));
}

function renderPolishLevel(level: PolishLevel): void {
  for (const card of polishLevelCards()) {
    card.setAttribute("aria-checked", String(card.dataset.level === level));
  }
}

/**
 * Which engine is selected, and therefore which half of the page applies.
 *
 * The two halves are not alternatives to read side by side: a key is nothing to
 * a local model and a download is nothing to a hosted one. So the other half is
 * hidden rather than dimmed.
 */
function renderPolishEngine(engine: AppSettings["polishEngine"]): void {
  for (const button of Array.from(
    element.polishEngine.querySelectorAll<HTMLElement>("[data-engine]"),
  )) {
    button.setAttribute("aria-checked", String(button.dataset.engine === engine));
  }
  for (const section of Array.from(
    document.querySelectorAll<HTMLElement>("[data-engine-only]"),
  )) {
    section.hidden = section.dataset.engineOnly !== engine;
  }
  if (engine === "local") void renderPolishModels();
  // Switching engines changes what "ready" means, and the rows that say so were
  // drawn for the other one.
  if (aiStatus && aiStatus.engine !== engine) {
    void host().getAiStatus().then(renderAiStatus);
  }
}

/**
 * The models the local engine can run, and what it would take to have one.
 *
 * The same rows as the speech catalogue, with fewer numbers on them: there is
 * no runtime to install and no error rate to compare, so what is left is how
 * big the download is and what keeping it loaded costs.
 */
async function renderPolishModels(): Promise<void> {
  const catalog = await host().getPolishModelCatalog().catch(() => []);
  element.polishModelList.replaceChildren(...catalog.map(polishModelRow));
}

function polishModelRow(model: PolishModelStatus): HTMLElement {
  const size = formatBytes(model.downloadBytes);
  const facts = `${size} · ${formatMemory(model.memoryMb)} RAM`;
  const busy = polishDownloading === model.id;

  const pick = document.createElement("button");
  pick.type = "button";
  pick.className = "model-pick";
  pick.dataset.model = model.id;
  // A radio only where there is something to choose. Missing weights are
  // fetched by their own button, so the row itself must not start a download.
  if (model.installed) {
    pick.setAttribute("role", "radio");
    pick.setAttribute("aria-checked", String(model.selected));
    pick.setAttribute("aria-label", `${model.label} — ${facts}`);
  } else {
    pick.setAttribute("aria-disabled", "true");
    pick.setAttribute("aria-label", `${model.label} — ${facts}`);
  }

  const card = document.createElement("button");
  card.type = "button";
  card.className = "model-card";
  card.dataset.card = model.cardUrl;
  card.textContent = "↗";
  card.setAttribute("aria-label", `Open ${model.label} on Hugging Face`);
  card.title = `Open ${model.label} on Hugging Face`;

  const name = document.createElement("span");
  name.className = "model-name";
  const title = document.createElement("strong");
  title.textContent = model.label;
  name.append(title, card);

  const factLine = document.createElement("small");
  factLine.className = "model-facts";
  factLine.textContent = facts;

  const body = document.createElement("span");
  body.className = "model-body";
  body.append(name, factLine);

  const row = document.createElement("div");
  row.className = "model-row";
  row.setAttribute("role", "presentation");
  row.dataset.state = model.installed ? "here" : busy ? "busy" : "download";
  row.append(pick, body);

  if (model.installed && model.selected) {
    const tag = document.createElement("span");
    tag.className = "model-tag";
    tag.dataset.ready = "true";
    tag.textContent = "In use";
    row.append(tag);
  }

  if (busy) {
    row.append(cancelDownloadButton());
  } else if (!model.installed) {
    row.append(fetchButton(model.id, model.label, size));
  } else {
    row.append(installedControls(model.id, model.label, size));
  }

  return row;
}

/**
 * Fetches a polish model, with the row saying how far it has got.
 *
 * One at a time, and the list is rebuilt afterwards either way -- and so is the
 * AI status, because a model arriving is what turns the tidy-everything switch
 * from unavailable into off.
 */
async function downloadPolishModel(id: string): Promise<void> {
  if (polishDownloading) return;
  polishDownloading = id;
  await renderPolishModels();
  try {
    await host().downloadPolishModel(id);
  } catch {
    // Cancelled or failed: the event already said which, and the rebuild below
    // puts the Download button back.
  } finally {
    polishDownloading = null;
    await renderPolishModels();
    renderAiStatus(await host().getAiStatus());
    // It is a setup step now, so its arrival is what closes that row.
    await refreshModelInstalled();
  }
}

/** Progress written next to Cancel — the facts line stays as size and RAM. */
function showPolishDownloadProgress(event: ModelEvent): void {
  // The wizard shows this model arriving on its polish page, which is where
  // the choice that started the download was made.
  polishPercent = Math.round((event.progress ?? 0) * 100);
  if (wizardStep === "ready") renderReadyProgress();
  // The onboarding card carries this model as a step, so it shows the same
  // percentage the speech row does rather than a button that says Download
  // while the file is already arriving.
  const step = element.onboardSteps.querySelector<HTMLElement>('[data-step="polish-model"]');
  const action = step?.querySelector("button");
  if (action) {
    action.textContent = `${polishPercent}%`;
    action.disabled = true;
  }
  if (wizardStep === "polish" && !element.wizardLocalRow.hidden) {
    const percent = polishPercent;
    element.wizardLocalTrack.classList.toggle("is-reserved", event.stage !== "downloading");
    element.wizardLocalBar.style.width = `${percent}%`;
    element.wizardLocalState.textContent =
      event.stage === "downloading" ? `Downloading… ${percent}%` : "Ready";
    element.wizardLocalState.dataset.state =
      event.stage === "downloading" ? "working" : "ready";
  }

  const pick = element.polishModelList.querySelector<HTMLElement>(
    `[data-model="${event.modelId}"]`,
  );
  const row = pick?.closest(".model-row");
  if (!row) return;
  const progress = row.querySelector<HTMLElement>(".model-progress");
  if (progress && event.progress !== undefined) {
    progress.textContent = `${Math.round(event.progress * 100)}%`;
  }
}

/** Saves, replaces or removes the key depending on what the field holds. */
function saveApiKey(): void {
  const value = element.keyInput.value.trim();
  if (element.keyInput.dataset.pristine === "true" || !value) return;

  void host()
    .setOpenRouterKey(value)
    .then((status) => {
      element.keyInput.dataset.pristine = "true";
      renderAiStatus(status);
      flash(element.keySave, "Saved");
    });
}

/**
 * Removing is its own button rather than a mode of saving.
 *
 * Saving an empty field used to delete the key, which is a destructive action
 * hidden inside a button that says Save -- and the only sign of which was the
 * word the button flashed afterwards.
 */
function removeApiKey(): void {
  void host()
    .clearOpenRouterKey()
    .then((status) => {
      element.keyInput.dataset.pristine = "true";
      renderAiStatus(status);
    });
}

/** Save is only offered when there is an edit worth saving. */
function syncKeyButtons(): void {
  const edited = element.keyInput.dataset.pristine === "false";
  element.keySave.disabled = !edited || element.keyInput.value.trim().length === 0;
}

/** Briefly confirms an action on the button that triggered it. */
function flash(button: HTMLButtonElement, message: string): void {
  const original = button.textContent;
  button.textContent = message;
  setTimeout(() => {
    button.textContent = original;
  }, 1_400);
}

function renderThemeToggle(theme: AppSettings["theme"]): void {
  for (const button of Array.from(
    element.themeToggle.querySelectorAll<HTMLElement>("[data-theme-value]"),
  )) {
    button.setAttribute("aria-checked", String(button.dataset.themeValue === theme));
  }
}

function renderHotkeyLabels(): void {
  const binding = getHotkeyBinding(settings.hotkeyId);
  const glyph = binding ? hotkeyKeycap(binding) : "—";
  element.hintKey.textContent = glyph;
  element.gestureKeyHold.textContent = glyph;
  element.gestureKeyTap.textContent = `${glyph} ${glyph}`;
  element.fnNote.hidden = settings.hotkeyId !== "fn";
}

interface SetupStep {
  id: string;
  done: boolean;
  /** What the step gets you, in the words of someone who has not read a manual. */
  title: string;
  /**
   * What macOS calls the same thing.
   *
   * Said as well as the plain title rather than instead of it: the plain title
   * is what makes the step make sense, and this is the word they have to find
   * in System Settings a second later. Dropping either one strands someone.
   */
  detail: string;
  /** The button, which is a verb. */
  action: string;
  /** How the step reads inside a sentence listing what is missing. */
  label: string;
}

/**
 * Everything that has to be true before dictation works end to end.
 *
 * Ordered the way a person meets them: hear you, put the words somewhere, see
 * the key that starts it, and have something to do the listening with.
 *
 * Typing comes before the shortcut because it is the half people recognise --
 * "it types for you" is the app, while Input Monitoring is the plumbing that
 * notices a key -- and a list that opens with two pieces of plumbing reads as
 * more suspicious than it is.
 *
 * The model is a step like any other because it is one. Weights are not
 * bundled -- the disk image would be half a gigabyte heavier and most of it
 * unwanted -- and nothing downloads them on its own, so an install with three
 * permissions granted and no model is an install that fails on the first
 * phrase with a file path in the error. It used to do exactly that.
 */
function setupSteps(): SetupStep[] {
  const status = hotkeyStatus;
  const model = getSpeechModel(settings.modelId);
  return [
    {
      id: "microphone",
      done: status?.microphone === "granted",
      title: "Let Waveform hear you",
      detail: "Microphone — macOS will ask, and the audio stays on this Mac",
      action: "Allow",
      label: "microphone access",
    },
    {
      id: "accessibility",
      done: status?.accessibility === true,
      title: "Let it type for you",
      detail: "Accessibility — so your words land wherever your cursor is",
      action: "Allow",
      label: "Accessibility",
    },
    {
      id: "input-monitoring",
      done: status?.inputMonitoring === true,
      title: "Let it watch for your shortcut",
      detail: "Input Monitoring — so your key works in every app, not just this one",
      action: "Allow",
      label: "Input Monitoring",
    },
    {
      id: "model",
      done: modelInstalled,
      title: "Download a speech model",
      detail: `${model.label}${modelDownloadSize === "" ? "" : ` · ${modelDownloadSize}`} — the part that turns speech into words`,
      action: "Download",
      label: "a speech model",
    },
    // A fifth step only when something is set to rewrite with it. At None no
    // model runs on the dictation path, and through OpenRouter the rewriting
    // happens elsewhere -- in both cases a missing local model stops nothing,
    // and a checklist row for it would be a chore invented out of nothing.
    ...(settings.polishLevel !== "none" && settings.polishEngine === "local"
      ? [
          {
            id: "polish-model",
            done: polishInstalled,
            title: "Download the AI polish model",
            detail: `${polishLabel}${polishDownloadSize === "" ? "" : ` · ${polishDownloadSize}`} — the part that tidies what you said`,
            action: "Download",
            label: "the AI polish model",
          },
        ]
      : []),
  ];
}

/**
 * Whether the chosen model's weights are on this Mac.
 *
 * Kept here rather than asked for at each render: it comes from the catalogue,
 * which is a round trip to the host, and four different things on this page
 * want to know it.
 */
async function refreshModelInstalled(): Promise<void> {
  const catalog = await host().getModelCatalog().catch(() => []);
  const current = catalog.find((model) => model.selected);
  modelInstalled = current ? current.runtimeInstalled && current.weightsInstalled : false;
  modelDownloadSize =
    current && current.downloadBytes !== null ? formatBytes(current.downloadBytes) : "";

  // The polish model is the other half of "can this app do what it is set to
  // do", and it is read here so both halves are known at the same moment --
  // a list that ticks one row a round trip after the other reads as broken.
  await readPolishModel();
  polishInstalled = wizardPolishModel?.installed ?? false;
  polishLabel = wizardPolishModel?.label ?? "";
  polishDownloadSize = wizardPolishModel
    ? formatBytes(wizardPolishModel.downloadBytes)
    : "";

  setupKnown = true;
  renderSetup();
  renderDictationDeck();
}

/**
 * The first thing a new install shows, and the thing it keeps showing until
 * dictation actually works.
 *
 * It sits where the deck sits, on the page someone lands on, rather than
 * behind a button that opens Settings. Setup used to be three rows inside a
 * modal, reached by pressing "Finish setup" on a card that had already
 * explained nothing -- which is two decisions and a dialog between someone and
 * the first thing they want to do.
 *
 * Each step says what it gets you first and what macOS calls it second. The
 * plain sentence is what makes the step make sense; the macOS term is the one
 * they have to recognise in System Settings ten seconds later.
 */
function renderOnboarding(steps: SetupStep[]): void {
  const done = steps.filter((step) => step.done).length;
  element.onboardCount.textContent = `${done} of ${steps.length}`;
  element.onboardBar.style.width = `${(done / steps.length) * 100}%`;

  element.onboardSteps.replaceChildren(
    ...steps.map((step, index) => {
      const item = document.createElement("li");
      item.className = "onboard-step";
      item.dataset.done = String(step.done);
      item.dataset.step = step.id;

      const mark = document.createElement("span");
      mark.className = "onboard-mark";
      // The tick replaces the number rather than joining it: a row that is
      // done is no longer a thing with a position in a queue.
      mark.textContent = step.done ? "" : String(index + 1);
      mark.setAttribute("aria-hidden", "true");

      const body = document.createElement("span");
      body.className = "onboard-body";
      const title = document.createElement("strong");
      title.textContent = step.title;
      const detail = document.createElement("small");
      detail.textContent = step.detail;
      body.append(title, detail);

      item.append(mark, body);

      if (!step.done) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "pill-button is-primary onboard-action";
        button.dataset.fix = step.id;
        button.textContent =
          step.id === "model" && downloading !== null ? "Downloading…" : step.action;
        button.disabled = step.id === "model" && downloading !== null;
        item.append(button);
      }
      return item;
    }),
  );
}

function renderSetup(): void {
  const steps = setupSteps();
  const outstanding = steps.filter((step) => !step.done);
  // The wizard draws the same permissions and the same download progress, and
  // a permission granted in System Settings arrives here with nothing else
  // watching for it.
  renderWizard();

  // One list, two surfaces. The Setup page used to hold its own copy of the
  // three permissions in markup, which is how it came to be missing the one
  // step that actually stops a fresh install working.
  element.checklist.replaceChildren(
    ...steps.map((step) => {
      const row = document.createElement("li");
      row.className = "check";
      row.dataset.check = step.id;
      row.dataset.done = String(step.done);

      const mark = document.createElement("span");
      mark.className = "check-mark";
      mark.setAttribute("aria-hidden", "true");

      const body = document.createElement("span");
      body.className = "check-body";
      const title = document.createElement("strong");
      title.textContent = step.title;
      const detail = document.createElement("small");
      detail.textContent = step.detail;
      body.append(title, detail);

      row.append(mark, body);

      // A granted step already carries its tick. A button reading "Done" says
      // the same thing a second time, and looks like something to press.
      if (!step.done) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "pill-button is-primary";
        button.dataset.fix = step.id;
        button.textContent = step.action;
        row.append(button);
      }
      return row;
    }),
  );

  renderOnboarding(steps);
  element.setupBadge.hidden = outstanding.length === 0;
  element.setupBadge.textContent = String(outstanding.length);
  element.setupLede.textContent =
    outstanding.length === 0
      ? "Everything is in place. Hold your shortcut anywhere and speak."
      : "Waveform needs these before it can dictate into other apps.";

  renderEmptyState();
}

/**
 * Folds the sidebar away, and tells the button what it will do next.
 *
 * The label is the state it moves to rather than the state it is in: a control
 * that reads "sidebar hidden" while the sidebar is showing is a description,
 * and this is a button.
 */
function renderSidebarCollapsed(): void {
  const collapsed = settings.sidebarCollapsed;
  element.app.dataset.sidebar = collapsed ? "collapsed" : "expanded";
  element.sidebarToggle.setAttribute("aria-expanded", String(!collapsed));
  element.sidebarToggle.setAttribute(
    "aria-label",
    collapsed ? "Show sidebar" : "Hide sidebar",
  );

  // Collapsed, the icon is all there is to go on, so each one names itself on
  // hover. Expanded, the label is already beside it and a tooltip repeating it
  // is just something else to wait for.
  for (const item of Array.from(
    document.querySelectorAll<HTMLElement>(".sidebar .nav-item"),
  )) {
    const label = item.querySelector("span")?.textContent?.trim();
    if (collapsed && label) item.title = label;
    else item.removeAttribute("title");
  }
}

/**
 * The models, and what is on this machine for each.
 *
 * All of them, every time. They used to arrive folded, with a `Show every size`
 * button holding back the eleven nobody had downloaded -- which meant the page
 * opened having already decided the question it exists to ask.
 *
 * What makes the full list readable instead is that each row is four facts in
 * one line: how accurate, how big to fetch, how much memory to keep loaded, and
 * a link to the page those came from.
 */
async function renderModels(): Promise<void> {
  const catalog = await host().getModelCatalog().catch(() => []);

  // Group headings come from the catalogue in its own order, so the interface
  // does not hold a second opinion about which groups exist.
  const groups = catalog.reduce<{ heading: string; models: ModelStatus[] }[]>((all, model) => {
    const group = all.find((candidate) => candidate.heading === model.group);
    if (group) group.models.push(model);
    else all.push({ heading: model.group, models: [model] });
    return all;
  }, []);

  const sections = groups.flatMap(({ heading, models }) => {
    const rows = document.createElement("div");
    rows.className = "model-list";
    // One radio group per heading: arrow keys then move within a group rather
    // than sweeping from Parakeet through fourteen Whisper sizes.
    rows.setAttribute("role", "radiogroup");
    rows.setAttribute("aria-label", heading || models.map((model) => model.label).join(", "));
    rows.append(...models.map(modelRow));
    // Parakeet and Qwen sit at the top unnamed: a heading here used to say
    // "Other engines", which made them sound like leftovers.
    if (heading === "") return [rows];
    const title = document.createElement("h2");
    title.className = "model-group";
    title.textContent = heading;
    return [title, rows];
  });

  element.modelList.replaceChildren(...sections);
}

/**
 * A Lucide glyph, built here because these rows are built here.
 *
 * The markup carries its icons inline with `data-icon` naming the Lucide entry
 * it came from; this is the same thing for a row that does not exist until the
 * catalogue arrives.
 */
function icon(name: string, paths: string[]): SVGSVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("data-icon", name);
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const d of paths) {
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

/** Lucide `terminal`: the two models the app cannot fetch for you. */
const TERMINAL = ["M12 19h8", "m4 17 6-6-6-6"];

/** Frees installed weights — same pill shape as Download. */
function removeButton(id: string, label: string, size: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "pill-button model-remove";
  button.dataset.remove = id;
  button.textContent = "Remove";
  button.title = size === "" ? `Remove ${label}` : `Remove ${label} — free ${size}`;
  button.setAttribute(
    "aria-label",
    size === "" ? `Remove ${label}` : `Remove ${label} to free ${size}`,
  );
  return button;
}

/**
 * Installed at rest; Remove on hover / focus. Keeps the slot filled so a
 * downloaded row does not look like a missing Download, and only offers
 * destructive action when the pointer is on this control.
 */
function installedControls(id: string, label: string, size: string): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "model-installed-controls";

  const installed = document.createElement("span");
  installed.className = "pill-button model-installed";
  installed.textContent = "Installed";
  installed.setAttribute("aria-hidden", "true");

  wrap.append(installed, removeButton(id, label, size));
  return wrap;
}

/** Starts a fetch the row itself no longer does. */
function fetchButton(id: string, label: string, size: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "pill-button model-fetch";
  button.dataset.fetch = id;
  button.textContent = "Download";
  button.title = `Download ${label} — ${size}`;
  button.setAttribute("aria-label", `Download ${label}, ${size}`);
  return button;
}

/** Stops the in-flight fetch; progress sits beside it while it runs. */
function cancelDownloadButton(): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "model-download-controls";

  const progress = document.createElement("span");
  progress.className = "model-progress";
  progress.textContent = "0%";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "pill-button model-cancel";
  button.dataset.cancelDownload = "true";
  button.textContent = "Cancel";
  button.setAttribute("aria-label", "Cancel download");

  wrap.append(progress, button);
  return wrap;
}

/**
 * One model: the numbers to choose on, and what it would take to have it.
 *
 * The row is not the button. Choosing a model and reading about it are
 * different acts, and a link inside a button is not a thing a browser will
 * render -- so the press target is a transparent layer over the whole row, and
 * everything visible sits on top of it and lets clicks through. The arrow out
 * to Hugging Face, the Download / Cancel controls, and delete are exceptions.
 *
 * A model whose weights are here is chosen by pressing the row. One whose
 * weights are not is fetched only by its Download button -- pressing the row
 * must not start a gigabyte transfer by accident.
 */
function modelRow(model: ModelStatus): HTMLElement {
  const ready = model.runtimeInstalled && model.weightsInstalled;
  const fetchable = !ready && model.downloadBytes !== null;
  const busy = downloading === model.id;
  const size = model.downloadBytes === null ? "" : formatBytes(model.downloadBytes);

  // The numbers the choice is made on. A third line of prose is dropped: the
  // group heading and the figures already say what the model is for.
  const facts = [
    model.wer === null ? "" : `${model.wer.toFixed(1)}% errors`,
    size,
    `${formatMemory(model.memoryMb)} RAM`,
  ]
    .filter((part) => part !== "")
    .join(" · ");
  // Only when the app cannot fetch the weights: that command is the next act,
  // not a description.
  const aside = ready || fetchable ? "" : `Run ${model.setupCommand}`;

  const pick = document.createElement("button");
  pick.type = "button";
  pick.className = "model-pick";
  pick.dataset.model = model.id;
  if (ready) {
    pick.setAttribute("role", "radio");
    pick.setAttribute("aria-checked", String(model.selected));
    pick.setAttribute("aria-label", `${model.label} — ${facts}`);
  } else {
    // Nothing the row press does: Download has its own button, and a terminal
    // model needs a command typed elsewhere.
    pick.setAttribute("aria-disabled", "true");
    pick.setAttribute(
      "aria-label",
      fetchable ? `${model.label} — ${facts}` : `${model.label} — run ${model.setupCommand}`,
    );
  }

  const card = document.createElement("button");
  card.type = "button";
  card.className = "model-card";
  card.dataset.card = model.cardUrl;
  // The arrow a link out of the app is drawn with, sitting against the name it
  // belongs to rather than at the far end of the row.
  card.textContent = "↗";
  card.setAttribute("aria-label", `Open ${model.label} on Hugging Face`);
  card.title = `Open ${model.label} on Hugging Face`;

  const name = document.createElement("span");
  name.className = "model-name";
  const title = document.createElement("strong");
  title.textContent = model.label;
  name.append(title, card);

  const factLine = document.createElement("small");
  factLine.className = "model-facts";
  factLine.textContent = facts;
  if (model.wer !== null) {
    factLine.title = "Word error rate — lower is more accurate";
  }

  const body = document.createElement("span");
  body.className = "model-body";
  body.append(name, factLine);
  if (aside !== "") {
    const detail = document.createElement("small");
    detail.className = "model-detail";
    detail.textContent = aside;
    body.append(detail);
  }

  const row = document.createElement("div");
  row.className = "model-row";
  row.setAttribute("role", "presentation");
  // What the row is, in one word, so the stylesheet can say the rest: a model
  // that is not here reads dimmer than one that is.
  row.dataset.state = ready ? "here" : busy ? "busy" : fetchable ? "download" : "terminal";
  row.append(pick, body);

  if (ready && model.selected) {
    const tag = document.createElement("span");
    tag.className = "model-tag";
    tag.dataset.ready = "true";
    tag.textContent = "In use";
    row.append(tag);
  }

  if (busy) {
    row.append(cancelDownloadButton());
  } else if (fetchable) {
    row.append(fetchButton(model.id, model.label, size));
  } else if (!ready) {
    const action = document.createElement("span");
    action.className = "model-action";
    action.append(icon("terminal", TERMINAL));
    action.title = `Run ${model.setupCommand}`;
    row.append(action);
  }

  // Installed slot (Remove on hover). weightsInstalled alone covers a runtime
  // that is still missing — Remove clears the cache; Download finishes setup.
  if (model.weightsInstalled && !busy) {
    row.append(installedControls(model.id, model.label, size));
  }

  return row;
}

/**
 * Frees the weight file, so a model that is no longer wanted is not occupying
 * a gigabyte. The list is rebuilt afterwards: the row's whole text depends on
 * whether the file is there now.
 */
async function deleteModel(id: SpeechModelId): Promise<void> {
  try {
    await host().deleteModel(id);
  } catch {
    // The failure already arrived as an error, or there was nothing to delete.
  } finally {
    await renderModels();
    await refreshModelInstalled();
  }
}

async function deletePolishModel(id: string): Promise<void> {
  try {
    await host().deletePolishModel(id);
  } catch {
    // Same as speech: the row rebuild is what says whether the file is gone.
  } finally {
    await renderPolishModels();
    renderAiStatus(await host().getAiStatus());
  }
}

/**
 * Fetches a model's weights, with the row saying how far it has got.
 *
 * One at a time, and the list is rebuilt afterwards either way: the row's whole
 * text depends on whether the file is there now.
 */
async function downloadModel(id: SpeechModelId): Promise<void> {
  if (downloading) return;
  downloading = id;
  await renderModels();
  try {
    await host().downloadModel(id);
  } catch {
    // Cancelled or failed: the event already said which, and the rebuild below
    // puts the Download button back.
  } finally {
    downloading = null;
    await renderModels();
    // The model is a setup step, so its arrival is what closes the last row of
    // the onboarding card.
    await refreshModelInstalled();
  }
}

/**
 * Writes progress next to Cancel rather than rebuilding the list.
 *
 * A rebuild four times a second would ask the host for the whole catalogue
 * each time, and replace the button under the pointer that started it. The
 * facts line keeps size and RAM — the percent beside Cancel is enough.
 */
function showDownloadProgress(event: ModelEvent): void {
  // The onboarding card offers the same download without the models page ever
  // being opened, so it gets the same progress.
  const percent = Math.round((event.progress ?? 0) * 100);
  speechPercent = percent;
  if (wizardStep === "ready") renderReadyProgress();
  // Nothing for the wizard beyond the last page. It fetches two models on
  // spec before anyone asks
  // for one, and a percentage counting up in its footer would be announcing
  // a download the person never started.
  const step = element.onboardSteps.querySelector<HTMLElement>('[data-step="model"]');
  const stepAction = step?.querySelector("button");
  if (stepAction) stepAction.textContent = `${percent}%`;
  const stepDetail = step?.querySelector("small");
  if (stepDetail) stepDetail.textContent = event.message;

  const pick = element.modelList.querySelector<HTMLElement>(
    `[data-model="${event.modelId}"]`,
  );
  const row = pick?.closest(".model-row");
  if (!row) return;
  const progress = row.querySelector<HTMLElement>(".model-progress");
  if (progress) {
    progress.textContent = `${percent}%`;
  }
}

/**
 * Asks whether there is a newer version, and says so either way.
 *
 * A check with no visible outcome reads as broken, which is why "up to date" is
 * a result rather than silence.
 */
async function checkForUpdate(): Promise<void> {
  try {
    await host().checkForUpdate();
  } catch {
    // Reported as an error event, which is what paints the button.
  }
}

/**
 * Installs the newer version. Does not return: the app relaunches into it.
 */
async function installUpdate(): Promise<void> {
  try {
    await host().installUpdate();
  } catch {
    // Reported as an error event, which is what paints the button.
  }
}

function setUpdateButton(
  label: string,
  options?: { busy?: boolean; install?: boolean; detail?: string },
): void {
  element.updateCheck.textContent = label;
  element.updateCheck.disabled = Boolean(options?.busy);
  element.updateCheck.title = options?.detail ?? "";
  element.updateCheck.setAttribute("aria-busy", options?.busy ? "true" : "false");
  element.updateCheck.classList.toggle("is-primary", Boolean(options?.install));
  updateAction = options?.install ? "install" : "check";
}

/**
 * The button itself carries every stage, so a status line cannot shove the
 * copyright off to the left.
 */
function handleUpdateEvent(event: UpdateEvent): void {
  switch (event.stage) {
    case "checking":
      setUpdateButton("Checking…", { busy: true });
      return;
    case "current":
      setUpdateButton("Up to date");
      return;
    case "available":
      setUpdateButton("Update and Restart", { install: true, detail: event.message });
      return;
    case "downloading": {
      const percent =
        event.progress !== undefined ? ` ${Math.round(event.progress * 100)}%` : "";
      setUpdateButton(`Downloading…${percent}`, {
        busy: true,
        install: true,
        detail: event.message,
      });
      return;
    }
    case "installed":
      setUpdateButton("Restarting…", { busy: true, install: true, detail: event.message });
      return;
    case "error":
      setUpdateButton(
        event.message.startsWith("Could not install") ? "Update failed" : "Could not check",
        {
          detail: event.message,
          install: updateAction === "install",
        },
      );
      return;
    default: {
      const _exhaustive: never = event.stage;
      return _exhaustive;
    }
  }
}

/**
 * A download's size, in the unit someone would say it in.
 *
 * Whisper Medium is "1.5 GB", not "1534 MB": past a thousand the megabytes
 * stop being a size and start being a number to read.
 */
function formatBytes(bytes: number): string {
  const megabytes = bytes / 1_000_000;
  return megabytes >= 1_000
    ? `${(megabytes / 1_000).toFixed(1)} GB`
    : `${Math.round(megabytes)} MB`;
}

function renderLanguageSelect(): void {
  if (element.speechLanguage.options.length === 0) {
    element.speechLanguage.append(
      ...SPEECH_LANGUAGES.map(({ code, label }) => new Option(label, code)),
    );
  }
  element.speechLanguage.value = settings.speechLanguage;
}

function resolveSetupStep(id: string): void {
  if (id === "model") {
    void downloadModel(settings.modelId);
    return;
  }
  if (id === "polish-model") {
    void downloadPolishModel(settings.localModelId).then(refreshModelInstalled);
    return;
  }
  if (id === "microphone") {
    // Same path as opening Dictation: getUserMedia shows the allow prompt.
    // If macOS already refused, only System Settings can flip it back on.
    void refreshMicrophones(true).then((ok) => {
      if (!ok) {
        void host().openPrivacySettings("microphone");
        return;
      }
      // Granted through the WKWebView prompt, which the host did not see. Ask
      // for the status rather than waiting for something to volunteer it.
      void host()
        .getHotkeyStatus()
        .then((status) => {
          hotkeyStatus = status;
          renderHotkeyStatus();
        })
        .catch(() => {});
    });
    return;
  }
  if (id !== "accessibility" && id !== "input-monitoring") return;
  if (isScopeGranted(id)) return;
  void host().requestHotkeyPermission(id);
  void host().openPrivacySettings(id);
}

function renderHotkeyStatus(): void {
  // The shortcut card names the binding, and it is rendered from here rather
  // than from anything that could describe a different one.
  renderShortcutCard();
  renderSetup();
  renderDictationDeck();
}

function isScopeGranted(scope: "accessibility" | "input-monitoring"): boolean {
  if (!hotkeyStatus) return false;
  return scope === "accessibility"
    ? hotkeyStatus.accessibility
    : hotkeyStatus.inputMonitoring;
}

/**
 * The list's resting state, which is the app's only real onboarding.
 *
 * Someone who has never dictated needs to be told what to do; someone who has
 * done it a hundred times needs the panel to be quiet.
 */
function renderEmptyState(): void {
  const outstanding = setupSteps().filter((step) => !step.done);
  const shortcut = getHotkeyBinding(settings.hotkeyId);
  const glyph = shortcut ? hotkeyKeycap(shortcut) : "your shortcut";
  const firstRun = lifetimeSessions === 0;

  // The onboarding card is already saying what to do, at length. A second
  // paragraph under it saying the same thing more vaguely is the page talking
  // over itself.
  element.emptyState.hidden = outstanding.length > 0 || !setupKnown;
  if (element.emptyState.hidden) return;

  element.starter.hidden = !firstRun;
  element.starterKey.textContent = glyph;

  if (firstRun) {
    element.emptyHeadline.textContent = "You're set. Try it once.";
    element.emptyHint.textContent =
      "Dictation works in any app. Here is the whole thing:";
    return;
  }

  element.emptyHeadline.textContent = "Your words will land here.";
  element.emptyHint.textContent = `Hold ${glyph} anywhere in macOS and speak. Release to transcribe, or tap twice to keep listening.`;
}

/** The first thing on Dictation is a live instruction, not a static welcome. */
function renderDictationDeck(): void {
  const outstanding = setupSteps().filter((step) => !step.done);
  const binding = getHotkeyBinding(settings.hotkeyId);
  const key = binding ? hotkeyKeycap(binding) : "—";

  // One card in this slot at a time. Until dictation works, the thing worth
  // saying is how to make it work -- and until the host has answered, neither
  // is true yet, so the slot stays empty rather than guessing.
  const known = setupKnown && hotkeyStatus !== null;
  element.onboard.hidden = !known || outstanding.length === 0;
  element.dictationDeck.hidden = !known || outstanding.length > 0;
  if (!known || outstanding.length > 0) return;

  element.deckKey.textContent = key;

  if (!binding) {
    element.deckStatus.textContent = "Shortcut off";
    element.deckTitle.textContent = "Choose a key to start dictating";
    element.deckDescription.textContent = "Pick a modifier key that will not type into the app you are using.";
    element.deckSettings.textContent = "Choose shortcut";
    return;
  }

  if (modelLoading) {
    element.deckStatus.textContent = "Preparing speech model";
    element.deckTitle.textContent = "Your words are about to be ready";
    element.deckDescription.textContent = `${getSpeechModel(settings.modelId).label} is loading on this Mac.`;
    element.deckSettings.textContent = "Dictation settings";
    return;
  }

  element.deckStatus.textContent = modelReady ? "Ready anywhere" : "Ready on demand";
  element.deckTitle.textContent = `Hold ${key}, say it, release`;
  element.deckDescription.textContent = modelReady
    ? "Words will land at your cursor, then stay here for easy copying."
    : "Your local speech model wakes when you use the shortcut. Nothing leaves this Mac.";
  element.deckSettings.textContent = "Dictation settings";
}

function renderStats(stats: AppStats): void {
  lifetimeSessions = stats.sessions;
  element.statWords.textContent = stats.words.toLocaleString();
  element.statPhrases.textContent = stats.phrases.toLocaleString();
  element.statSessions.textContent = stats.sessions.toLocaleString();
  renderEmptyState();
}

function renderResourceUsage(usage: ResourceUsage): void {
  const memory = formatMemory(usage.memoryMb);
  element.overviewCpu.textContent = `${usage.cpuPercent}%`;
  element.overviewMemory.textContent = memory;
  element.overviewEngineMemory.textContent =
    usage.engineMemoryMb === null
      ? "Speech engine is not running"
      : `Speech engine accounts for ${formatMemory(usage.engineMemoryMb)}`;
}

function formatMemory(megabytes: number): string {
  return megabytes >= 1024 ? `${(megabytes / 1024).toFixed(1)} GB` : `${megabytes} MB`;
}

function handleModelEvent(event: ModelEvent): void {
  // A download runs for whichever row was pressed, which is not necessarily
  // the selected model, so this cannot be filtered by selection: the progress
  // would go on the floor for every model but one.
  if (event.stage === "downloading") {
    showDownloadProgress(event);
    return;
  }
  if (event.modelId !== settings.modelId) {
    // Nothing about the running engine changed, but a download that failed is
    // still worth saying out loud.
    if (event.stage === "error") setStatus(event.message);
    return;
  }

  if (event.stage === "ready") {
    modelReady = true;
    modelLoading = false;
  } else if (event.stage === "error") {
    modelReady = false;
    modelLoading = false;
  } else if (event.stage === "idle") {
    // Not loaded, and not loading either: the engine waits for a first
    // session, so this must not read as work in progress.
    modelReady = false;
    modelLoading = false;
  } else {
    modelLoading = true;
  }

  setStatus(event.message);
  renderDictationDeck();
}

function handleDictationUpdate(update: DictationUpdate): void {
  // The pill outside the app is the listening indicator, and it is the one you
  // can actually see while dictating into another window. Mirroring its state
  // in here gave two things to watch that could disagree, so the sidebar
  // carries only the engine: which model, ready or not, and anything that
  // went wrong.
  const { status } = update;
  const retryable = status.state === "error" && Boolean(status.canRetry);
  const nextRetry = retryable
    ? { message: status.message ?? "Transcription failed." }
    : null;
  const retryChanged =
    (pendingRetry?.message ?? null) !== (nextRetry?.message ?? null) ||
    Boolean(pendingRetry) !== Boolean(nextRetry);
  pendingRetry = nextRetry;
  if (retryChanged) renderHistory();

  // Errors, and the one outcome that is not an error and still needs saying:
  // a polish that changed nothing looks exactly like a shortcut that missed.
  if ((status.state === "error" || status.state === "idle") && status.message) {
    setStatus(status.message);
  }
  else if (modelReady) setStatus(`${getSpeechModel(settings.modelId).label} ready`);
}

/** The shortcut is the way in, so the sidebar says which one to hold. */
function renderShortcutCard(): void {
  const hint = element.shortcutHint;
  hint.replaceChildren();

  // Nothing to hold yet. The card told a new install to hold a key that could
  // not have worked, beside a panel explaining why not.
  hint.hidden = setupSteps().some((step) => !step.done);
  if (hint.hidden) return;

  // With no button on the page, an unusable shortcut would leave no way in at
  // all, so say which one it is instead of repeating the instruction.
  const binding = getHotkeyBinding(settings.hotkeyId);
  if (!binding || hotkeyStatus?.supported === false) {
    hint.append(text("Choose a shortcut in Settings to start dictating."));
    return;
  }

  hint.append(
    text("Hold "),
    key(hotkeyKeycap(binding)),
    text(" anywhere in macOS to dictate, or tap twice to keep listening."),
  );
}

function text(value: string): Text {
  return document.createTextNode(value);
}

function key(glyph: string): HTMLElement {
  const element = document.createElement("kbd");
  element.textContent = glyph;
  return element;
}

/** Renders the saved dictations, newest first, grouped by the day they landed. */
function renderHistory(): void {
  // Its row is about to be replaced; a menu left floating would act on nothing.
  closeEntryMenu();
  const matches =
    query === ""
      ? entries
      : entries.filter((entry) => entry.text.toLowerCase().includes(query.toLowerCase()));

  // Both cards stay in the tree; renderDictationDeck decides which is showing.
  element.history.replaceChildren(element.onboard, element.dictationDeck);
  element.history.classList.toggle("is-empty", matches.length === 0 && !pendingRetry);

  if (pendingRetry) element.history.append(renderRetryCard(pendingRetry.message));

  if (matches.length === 0 && query !== "") {
    const note = document.createElement("p");
    note.className = "no-matches";
    note.textContent = `Nothing matches \u201c${query}\u201d.`;
    element.history.append(note);
  } else if (matches.length === 0) {
    // renderEmptyState decides whether it is shown: during setup the
    // onboarding card is already saying all of this.
    element.history.append(element.emptyState);
    renderEmptyState();
  } else {
    for (const day of groupByDay(matches)) element.history.append(renderDay(day));
  }

  element.dictateNote.textContent = describeCount(matches.length);
}

/**
 * Offered while the overlay still holds the failed clips, so Retry does not
 * require speaking again or digging through a log.
 */
function renderRetryCard(message: string): HTMLElement {
  const card = document.createElement("section");
  card.className = "retry-card";

  const title = document.createElement("h2");
  title.className = "retry-title";
  title.textContent = "Dictation failed";

  const body = document.createElement("p");
  body.className = "retry-message";
  body.textContent = message;

  const actions = document.createElement("div");
  actions.className = "retry-actions";

  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "pill-button";
  dismiss.textContent = "Dismiss";
  dismiss.addEventListener("click", () => {
    void host().dismissDictationRetry();
  });

  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "pill-button is-primary";
  retry.textContent = "Retry";
  retry.addEventListener("click", () => {
    void host().retryDictation();
  });

  actions.append(dismiss, retry);
  card.append(title, body, actions);
  return card;
}

function describeCount(matched: number): string {
  if (entries.length === 0) return "";
  if (query !== "") return `${matched.toLocaleString()} of ${entries.length.toLocaleString()}`;
  return `${entries.length.toLocaleString()} ${entries.length === 1 ? "dictation" : "dictations"}`;
}

/** Consecutive runs, not a map: the list is already ordered by time. */
function groupByDay(list: SavedDictation[]): SavedDictation[][] {
  const days: SavedDictation[][] = [];
  let key = "";
  let current: SavedDictation[] = [];
  for (const entry of list) {
    const day = new Date(entry.createdAt).toDateString();
    if (day !== key) {
      current = [];
      days.push(current);
      key = day;
    }
    current.push(entry);
  }
  return days;
}

function renderDay(day: SavedDictation[]): HTMLElement {
  const section = document.createElement("section");
  section.className = "day";

  const label = document.createElement("h2");
  label.className = "day-label";
  label.textContent = formatDay(day[0]?.createdAt ?? Date.now());

  const card = document.createElement("div");
  card.className = "entry-card";
  for (const entry of day) card.append(renderEntry(entry));

  section.append(label, card);
  return section;
}

function renderEntry(entry: SavedDictation): HTMLElement {
  const article = document.createElement("article");
  const isActive = playback?.id === entry.id;
  article.className = [
    entry.id === freshId ? "entry is-fresh" : "entry",
    isActive ? "is-playing" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const time = document.createElement("span");
  time.className = "entry-time";
  time.textContent = formatTime(entry.createdAt);
  time.title = new Date(entry.createdAt).toLocaleString();

  const text = document.createElement("p");
  text.className = "entry-text";
  text.textContent = entry.text;

  const actions = document.createElement("span");
  actions.className = "entry-actions";
  if (entry.hasAudio) {
    const playing = Boolean(isActive && playback && !playback.audio.paused);
    const play = iconButton(
      playing ? "Pause audio" : "Play audio",
      playing ? PAUSE_ICON : PLAY_ICON,
      `is-play${playing ? " is-playing" : ""}`,
      () => {
        void togglePlayback(entry.id, play);
      },
    );
    play.dataset.playId = entry.id;
    if (isActive) playback!.button = play;
    actions.append(play);
  }
  // Play and Copy are the everyday actions and stay on the row; the rest
  // (one of them destructive) wait behind the menu.
  actions.append(
    iconButton("Copy", COPY_ICON, "", () => {
      void navigator.clipboard.writeText(entry.text);
    }),
    entryMenuButton(entry, text),
  );

  article.append(time, text, actions);
  return article;
}

interface EntryMenuItem {
  label: string;
  icon: string;
  danger?: boolean;
  onSelect: () => void;
}

/** The one open row menu: opening another, or clicking away, closes it. */
let entryMenu: { trigger: HTMLButtonElement; close: () => void } | null = null;

function entryMenuButton(entry: SavedDictation, text: HTMLElement): HTMLButtonElement {
  const trigger = iconButton("More actions", MORE_ICON, "is-more", () => {
    if (entryMenu?.trigger === trigger) {
      closeEntryMenu();
      return;
    }
    openEntryMenu(trigger, entryMenuItems(entry, trigger, text));
  });
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", "false");
  return trigger;
}

function entryMenuItems(
  entry: SavedDictation,
  trigger: HTMLButtonElement,
  text: HTMLElement,
): EntryMenuItem[] {
  const items: EntryMenuItem[] = [];
  if (entry.hasAudio) {
    items.push({
      label: "Retry transcript",
      icon: RETRY_ICON,
      // The trigger shows the busy state: the menu is gone by then.
      onSelect: () => void retryHistoryTranscription(entry, trigger, text),
    });
  }
  items.push({
    label: "Delete transcript",
    icon: TRASH_ICON,
    danger: true,
    onSelect: () => deleteEntry(entry),
  });
  if (entry.hasAudio) {
    items.push({
      label: "Save audio",
      icon: SAVE_AUDIO_ICON,
      onSelect: () => void saveEntryAudio(entry),
    });
  }
  return items;
}

/**
 * Floats the menu on the body, beside its trigger.
 *
 * Inside the row it would be clipped by the day card's rounded corners, and
 * the last row of the list has no room below it, so it flips above.
 */
function openEntryMenu(trigger: HTMLButtonElement, items: EntryMenuItem[]): void {
  closeEntryMenu();
  const menu = document.createElement("div");
  menu.className = "entry-menu";
  menu.setAttribute("role", "menu");
  const buttons = items.map((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = item.danger ? "entry-menu-item is-danger" : "entry-menu-item";
    button.setAttribute("role", "menuitem");
    button.innerHTML = iconSvg(item.icon);
    const label = document.createElement("span");
    label.textContent = item.label;
    button.append(label);
    button.addEventListener("click", () => {
      closeEntryMenu();
      item.onSelect();
    });
    return button;
  });
  menu.append(...buttons);
  document.body.append(menu);

  const anchor = trigger.getBoundingClientRect();
  const gap = 6;
  const margin = 8;
  const below = anchor.bottom + gap;
  const top =
    below + menu.offsetHeight > window.innerHeight - margin
      ? anchor.top - gap - menu.offsetHeight
      : below;
  const left = Math.min(anchor.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - margin);
  menu.style.top = `${Math.max(margin, top)}px`;
  menu.style.left = `${Math.max(margin, left)}px`;

  const row = trigger.closest(".entry");
  trigger.setAttribute("aria-expanded", "true");
  row?.classList.add("is-menu-open");
  buttons[0]?.focus();

  const onPointer = (event: PointerEvent): void => {
    const target = event.target as Node;
    if (!menu.contains(target) && !trigger.contains(target)) closeEntryMenu();
  };
  // Captured, so Escape closes this menu and not Settings behind it.
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeEntryMenu();
      trigger.focus();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    buttons[(current + step + buttons.length) % buttons.length]?.focus();
  };
  // A floating menu left behind by a scroll points at the wrong row.
  const onMove = (): void => closeEntryMenu();

  document.addEventListener("pointerdown", onPointer, true);
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("scroll", onMove, true);
  window.addEventListener("resize", onMove);
  window.addEventListener("blur", onMove);

  entryMenu = {
    trigger,
    close: () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("blur", onMove);
      menu.remove();
      trigger.setAttribute("aria-expanded", "false");
      row?.classList.remove("is-menu-open");
    },
  };
}

function closeEntryMenu(): void {
  const current = entryMenu;
  entryMenu = null;
  current?.close();
}

function deleteEntry(entry: SavedDictation): void {
  if (playback?.id === entry.id) stopPlayback();
  void host().deleteDictation(entry.id).then((next) => {
    entries = next;
    freshId = null;
    renderHistory();
  });
}

async function saveEntryAudio(entry: SavedDictation): Promise<void> {
  try {
    const path = await host().saveDictationAudio(entry.id, audioFileName(entry.createdAt));
    setStatus(`Saved ${path.split("/").pop() ?? "the audio"} to Downloads`);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
  }
}

/** Named the way macOS names a screenshot, so a folder of them sorts by time. */
function audioFileName(createdAt: number): string {
  const date = new Date(createdAt);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return (
    `Waveform ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `at ${pad(date.getHours())}.${pad(date.getMinutes())}.${pad(date.getSeconds())}`
  );
}

/**
 * Runs the speech engine again on a saved recording and updates that row.
 */
async function retryHistoryTranscription(
  entry: SavedDictation,
  button: HTMLButtonElement,
  textNode: HTMLElement,
): Promise<void> {
  if (button.disabled) return;
  button.disabled = true;
  button.classList.add("is-busy");
  setStatus("Retrying transcription…");
  try {
    const bytes = await host().getDictationAudio(entry.id);
    const { text } = await host().transcribe(bytes);
    const trimmed = text.trim();
    if (!trimmed) {
      setStatus("No words found in that recording.");
      return;
    }
    entries = await host().updateDictation(entry.id, trimmed);
    freshId = entry.id;
    entry.text = trimmed;
    textNode.textContent = trimmed;
    setStatus("Transcription updated");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
  } finally {
    button.disabled = false;
    button.classList.remove("is-busy");
  }
}

/**
 * Plays or pauses a saved recording without rebuilding the list.
 *
 * Clips are stored at the level the speech engine wants, which is quiet for
 * listening. Peak-normalising on the way out keeps the beginning audible
 * without changing what was sent to the model.
 */
async function togglePlayback(id: string, button: HTMLButtonElement): Promise<void> {
  if (playback?.id === id) {
    if (playback.audio.paused) {
      await playback.audio.play();
      setPlaybackButton(button, true);
      button.closest(".entry")?.classList.add("is-playing");
    } else {
      playback.audio.pause();
      setPlaybackButton(button, false);
    }
    return;
  }

  stopPlayback();
  try {
    const bytes = await host().getDictationAudio(id);
    const copy = new Uint8Array(bytes);
    const decoded = await decodeAudioPeak(copy);
    const blob = new Blob([copy], { type: "audio/wav" });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    const context = new AudioContext();
    const source = context.createMediaElementSource(audio);
    const gain = context.createGain();
    gain.gain.value = decoded;
    source.connect(gain);
    gain.connect(context.destination);
    playback = { id, audio, context, url, button };
    audio.addEventListener("ended", () => {
      if (playback?.id === id) {
        setPlaybackButton(button, false);
        button.closest(".entry")?.classList.remove("is-playing");
        stopPlayback();
      }
    });
    button.closest(".entry")?.classList.add("is-playing");
    setPlaybackButton(button, true);
    await audio.play();
  } catch (error) {
    stopPlayback();
    setPlaybackButton(button, false);
    setStatus(error instanceof Error ? error.message : String(error));
  }
}

/** Peak-normalise gain for a WAV, without holding the decoded buffer. */
async function decodeAudioPeak(bytes: Uint8Array): Promise<number> {
  const context = new AudioContext();
  try {
    const copy = new Uint8Array(bytes);
    const buffer = await context.decodeAudioData(copy.buffer);
    return listeningGain(buffer);
  } finally {
    void context.close();
  }
}

/** Lift a quiet ASR clip to a comfortable listening level without clipping. */
function listeningGain(buffer: AudioBuffer): number {
  let peak = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let index = 0; index < data.length; index += 1) {
      peak = Math.max(peak, Math.abs(data[index] ?? 0));
    }
  }
  if (peak < 0.001) return 1;
  return Math.min(8, 0.85 / peak);
}

function setPlaybackButton(button: HTMLButtonElement, playing: boolean): void {
  const label = playing ? "Pause audio" : "Play audio";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.classList.toggle("is-playing", playing);
  button.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${
      playing ? PAUSE_ICON : PLAY_ICON
    }</svg>`;
}

function stopPlayback(): void {
  const current = playback;
  playback = null;
  if (!current) return;
  current.button.closest(".entry")?.classList.remove("is-playing");
  setPlaybackButton(current.button, false);
  current.audio.pause();
  current.audio.removeAttribute("src");
  current.audio.load();
  void current.context.close();
  URL.revokeObjectURL(current.url);
}

function iconButton(
  label: string,
  path: string,
  modifier: string,
  onClick: () => void,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `entry-action ${modifier}`.trim();
  button.title = label;
  button.setAttribute("aria-label", label);
  button.innerHTML = iconSvg(path);
  button.addEventListener("click", () => {
    onClick();
    if (label === "Copy") {
      button.classList.add("is-done");
      setTimeout(() => button.classList.remove("is-done"), 900);
    }
  });
  return button;
}

/* Lucide outline glyphs, matching Copy and Delete. */
const PLAY_ICON =
  '<path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z" />';
const PAUSE_ICON =
  '<rect x="14" y="3" width="5" height="18" rx="1" />' +
  '<rect x="5" y="3" width="5" height="18" rx="1" />';
const RETRY_ICON =
  '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />' +
  '<path d="M21 3v5h-5" />';
const MORE_ICON =
  '<circle cx="12" cy="12" r="1" /><circle cx="12" cy="5" r="1" /><circle cx="12" cy="19" r="1" />';
const SAVE_AUDIO_ICON =
  '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />' +
  '<path d="M14 2v5a1 1 0 0 0 1 1h5" /><path d="M12 18v-6" /><path d="m9 15 3 3 3-3" />';

/** A Lucide glyph at the stroke the rest of the interface uses. */
function iconSvg(path: string): string {
  return (
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`
  );
}
const COPY_ICON = '<rect width="14" height="14" x="8" y="8" rx="2" ry="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />';

const TRASH_ICON = '<path d="M10 11v6" /><path d="M14 11v6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />';

function bindTranscribeDrop(): void {
  const drop = element.transcribeDrop;
  const input = element.transcribeFile;

  drop.addEventListener("click", () => {
    if (!transcribeBusy) input.click();
  });
  drop.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (!transcribeBusy) input.click();
    }
  });
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    input.value = "";
    if (file) void transcribeAudioFile(file);
  });

  drop.addEventListener("dragenter", (event) => {
    event.preventDefault();
    drop.classList.add("is-dragging");
  });
  drop.addEventListener("dragover", (event) => {
    event.preventDefault();
    drop.classList.add("is-dragging");
  });
  drop.addEventListener("dragleave", (event) => {
    if (!drop.contains(event.relatedTarget as Node | null)) {
      drop.classList.remove("is-dragging");
    }
  });
  drop.addEventListener("drop", (event) => {
    event.preventDefault();
    drop.classList.remove("is-dragging");
    const file = event.dataTransfer?.files?.[0];
    if (file) void transcribeAudioFile(file);
  });

  element.transcribeCopy.addEventListener("click", () => {
    const text = element.transcribeText.textContent ?? "";
    if (!text) return;
    void navigator.clipboard.writeText(text);
    element.transcribeCopy.classList.add("is-done");
    element.transcribeCopy.textContent = "Copied";
    setTimeout(() => {
      element.transcribeCopy.classList.remove("is-done");
      element.transcribeCopy.textContent = "Copy";
    }, 900);
  });
  element.transcribeClear.addEventListener("click", clearTranscribeResult);
}

async function transcribeAudioFile(file: File): Promise<void> {
  if (transcribeBusy) return;
  if (!isAudioFile(file)) {
    setTranscribeStatus("That does not look like an audio file.");
    return;
  }

  transcribeBusy = true;
  element.transcribeDrop.classList.add("is-busy");
  element.transcribeDropTitle.textContent = "Transcribing…";
  element.transcribeDropHint.textContent = file.name;
  element.transcribeNote.textContent = "Working…";
  element.transcribeResult.hidden = true;

  try {
    const wav = await audioFileToMonoWav(file);
    const { text } = await host().transcribe(wav);
    const trimmed = text.trim();
    if (!trimmed) {
      setTranscribeStatus("No words found in that recording.");
      resetTranscribeDrop();
      return;
    }

    entries = await host().saveDictation(trimmed, wav);
    freshId = entries[0]?.id ?? null;
    renderHistory();

    element.transcribeFileName.textContent = file.name;
    element.transcribeText.textContent = trimmed;
    element.transcribeResult.hidden = false;
    element.transcribeNote.textContent = "Saved to Transcripts";
    setStatus(`Transcribed ${file.name}`);
    resetTranscribeDrop();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setTranscribeStatus(message);
    setStatus(message);
    resetTranscribeDrop();
  } finally {
    transcribeBusy = false;
    element.transcribeDrop.classList.remove("is-busy");
  }
}

function resetTranscribeDrop(): void {
  element.transcribeDropTitle.textContent = "Drop an audio file here";
  element.transcribeDropHint.textContent =
    "WAV, MP3, M4A, and other formats WebKit can decode. Click to choose a file.";
}

function clearTranscribeResult(): void {
  element.transcribeResult.hidden = true;
  element.transcribeText.textContent = "";
  element.transcribeFileName.textContent = "";
  element.transcribeNote.textContent = "Audio stays on this Mac";
  resetTranscribeDrop();
}

function setTranscribeStatus(message: string): void {
  element.transcribeNote.textContent = message;
  element.transcribeDropHint.textContent = message;
}

function toggleSearch(open: boolean): void {
  searchOpen = open;
  element.search.classList.toggle("is-open", open);
  element.searchButton.setAttribute("aria-expanded", String(open));

  if (open) {
    element.searchField.focus();
    return;
  }
  element.searchField.value = "";
  if (query !== "") {
    query = "";
    renderHistory();
  }
}

/** The day carries the date, so each row only needs its clock time. */
function formatTime(timestamp: number): string {
  return new Date(timestamp)
    .toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    .toLowerCase();
}

function formatDay(timestamp: number): string {
  const when = new Date(timestamp);
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const days = Math.floor((midnight.getTime() - when.getTime()) / 86_400_000) + 1;

  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return when.toLocaleDateString([], { weekday: "long" });
  if (when.getFullYear() === new Date().getFullYear()) {
    return when.toLocaleDateString([], { day: "numeric", month: "long" });
  }
  return when.toLocaleDateString([], { day: "numeric", month: "long", year: "numeric" });
}


function toggleSettings(open: boolean, page = "general"): void {
  if (open && promptEditorKind) togglePromptEditor(false);
  // Settings covers the list, and with it the button that would pause.
  if (open) stopPlayback();
  settingsOpen = open;
  element.settingsPanel.hidden = !open;
  element.scrim.hidden = !open && !promptEditorKind;
  if (!open) return;
  showSettingsPage(page);
  void host().getHotkeyStatus().then((status) => {
    hotkeyStatus = status;
    renderHotkeyStatus();
  });
  void host().getAiStatus().then(renderAiStatus);
}

/**
 * Opens or closes the instruction editor over the settings panel.
 *
 * The cards only show a preview; editing happens here so two long prompts do
 * not take the whole page. Reset puts the selected level's default back into
 * the field; Save is what writes it. Closing without Save leaves the stored
 * prompt alone.
 *
 * The panel is closed underneath rather than stacked with, because two dialogs
 * deep is one too many to find the way out of -- and put back on the way out,
 * since the cards that open this are on one of its pages.
 */
function togglePromptEditor(open: boolean, kind: "transform" | "polish" = "transform"): void {
  if (!open) {
    promptEditorKind = null;
    element.promptEditor.hidden = true;
    if (promptEditorFromSettings) {
      promptEditorFromSettings = false;
      toggleSettings(true, "ai");
      return;
    }
    element.scrim.hidden = !settingsOpen;
    return;
  }
  promptEditorFromSettings = settingsOpen;
  if (settingsOpen) toggleSettings(false);
  promptEditorKind = kind;
  element.promptEditorTitle.textContent = kind === "transform" ? "Dictation" : "Selection";
  element.promptEditorWhere.textContent =
    kind === "transform"
      ? transformPromptWhere(settings.polishLevel)
      : "Used when you polish selected text with the shortcut.";
  element.promptEditorBody.value =
    kind === "transform" ? settings.transformPrompt : settings.polishPrompt;
  element.promptEditor.hidden = false;
  element.scrim.hidden = false;
  element.promptEditorBody.focus();
}

/**
 * Which level the dictation instruction belongs to.
 *
 * At None nothing runs it, and the card says so rather than showing an
 * instruction that reads as though it were in force.
 */
function transformPromptWhere(level: PolishLevel): string {
  if (level === "none") return "Not in use: polish is set to None.";
  return `Used on every dictation, at ${level === "medium" ? "Medium" : "Light"}.`;
}

/** First lines of each prompt on the cards, so the page stays scannable. */
function renderPromptPreviews(next: AppSettings = settings): void {
  element.transformPromptWhere.textContent = transformPromptWhere(next.polishLevel);
  element.transformPromptPreview.textContent = promptPreview(next.transformPrompt);
  element.polishPromptPreview.textContent = promptPreview(next.polishPrompt);
}

function promptPreview(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= 140) return compact;
  return `${compact.slice(0, 139).trimEnd()}…`;
}

/* ==========================================================================
 * The first-run wizard.
 *
 * Five pages, asked once. It exists because the checklist on the Transcripts
 * page -- which is still there, and is where anyone who skips this lands --
 * can only nag about what is missing, and two of the things that decide how
 * the app feels are not missing, they are defaulted: which key you hold, and
 * how much a model may rewrite what you said. Nobody changes a default they
 * were never shown.
 *
 * The order is load-bearing. The model is first because it is the only step
 * that takes real time, and asking it first means the download runs while the
 * other four are answered rather than after them. The key comes before the
 * permission that watches for the key, so the permission prompt is about
 * something already decided.
 *
 * There is no skip. The three macOS permissions are not preferences that can
 * be left at a default -- without them the app cannot hear you, cannot see
 * the key you hold, and cannot type the result -- so the page that asks for
 * them will not advance until they are granted. Every one of them is granted
 * in System Settings and reported back live, so there is always a way
 * forward; there is just no way around.
 * ========================================================================== */

const WIZARD_STEPS = [
  "welcome",
  "voice",
  "shortcut",
  "permissions",
  "polish",
  "ready",
] as const;
type WizardStep = (typeof WIZARD_STEPS)[number];

/**
 * Opens the wizard, if this is the install it was written for.
 *
 * Two conditions, not one. The flag alone is not enough: it arrived after the
 * app did, so every settings file written before it reads as a fresh install,
 * and an existing user would be handed a five-page wizard on the morning they
 * updated. A machine that has already dictated has plainly been through this,
 * so it is marked done without ever being shown.
 */
function maybeOpenWizard(): void {
  if (settings.onboardingCompleted) return;
  if (lifetimeSessions > 0) {
    void patchSettings({ onboardingCompleted: true });
    return;
  }
  openWizard();
}

function openWizard(): void {
  // A model already chosen puts the slider on its rung; anything off the
  // ladder -- a model picked from the catalogue, or a default from an older
  // build -- leaves the slider where it rests.
  ladderIndex = ladderIndexOf(settings.modelId) ?? DEFAULT_LADDER_INDEX;
  element.ladderSlider.max = String(MODEL_LADDER.length - 1);
  element.ladderSlider.value = String(ladderIndex);
  cancelLadderGlide();
  ladderShownRung = -1;
  ladderTouched = false;

  // Anything else modal would be underneath this, which is two dialogs deep
  // with the lower one unreachable.
  if (settingsOpen) toggleSettings(false);
  if (promptEditorKind) togglePromptEditor(false);

  void readWizardFits().then(startPrefetch);
  startPolishDefault();
  renderKeypick();
  showWizardStep("welcome");
}

/**
 * Starts a first run on Light, rewriting here on this Mac.
 *
 * The stored defaults stay where they are, and this is set on the way into
 * the wizard instead, because the two cannot be moved for the same reasons.
 * `polishLevel` could be: a settings file older than the levels carries
 * `transformOnDictate`, so it never falls through to the default. But
 * `polishEngine` has no such fallback -- a file written before that field
 * existed takes whatever the default is, and moving it to "local" would
 * quietly switch everybody already polishing through OpenRouter onto a model
 * they have not downloaded. So the new answer is given to new installs only,
 * which is exactly who is looking at this wizard.
 *
 * Doing it here rather than on the polish page is what gets the model moving:
 * it is a 397 MB download, and starting it four pages early is the same trick
 * the speech models get.
 *
 * Only from the factory settings. Somebody who reached the polish page, chose
 * None and quit has answered this, and reopening must not overrule them.
 */
function startPolishDefault(): void {
  if (settings.polishLevel !== DEFAULT_SETTINGS.polishLevel) return;
  if (settings.polishEngine !== DEFAULT_SETTINGS.polishEngine) return;
  void patchSettings({
    polishLevel: "light",
    transformPrompt: transformPromptFor("light"),
    polishEngine: "local",
  }).then(prefetchPolishModel);
}

/**
 * Fetches the two models almost everybody ends on, before being asked to.
 *
 * Nothing about this is on screen. A first run is four pages of answering
 * questions during which the machine is doing nothing, and the reward for
 * finishing is a wait -- so the wait is moved under the questions. Base goes
 * first because it is 148 MB against 574: it lands while the permissions are
 * still being granted, and from then on there is a working model on the disk
 * whichever way the slider ends up. The recommended one follows.
 *
 * Deliberately not announced. A progress line for a download nobody asked for
 * invites the question of whether it can be stopped, and the honest answer --
 * that it is two files totalling 700 MB fetched on spec -- is a worse first
 * page than silence. What is never hidden is the result: the last page reads
 * the same setup list as everything else, so it says the model is missing
 * whenever it is.
 */
function startPrefetch(): void {
  enqueuePrefetch(DEFAULT_LADDER_MODEL_ID);
  // Unshifted after, so Base ends up in front of it.
  enqueuePrefetch(MODEL_LADDER[0]!.id, { first: true });
  void drainPrefetch();
}

/** Whether a model's weights are on the disk, as of the last catalogue read. */
function isHere(id: SpeechModelId): boolean {
  const model = wizardCatalog.get(id);
  return model !== undefined && model.runtimeInstalled && model.weightsInstalled;
}

/**
 * Puts a model in the queue, or moves it to the front.
 *
 * `first` is for the model the slider actually landed on: it is the one being
 * waited for, so it goes ahead of anything fetched on spec. A download
 * already in flight is left to finish rather than cancelled -- the partial
 * file would be thrown away, and the thing in flight is the small one.
 */
function enqueuePrefetch(id: SpeechModelId, options?: { first: boolean }): void {
  if (isHere(id)) return;
  prefetchQueue = prefetchQueue.filter((queued) => queued !== id);
  if (options?.first) prefetchQueue.unshift(id);
  else prefetchQueue.push(id);
}

/**
 * Runs the queue, one at a time, because the host will not run two.
 *
 * Re-reads the catalogue between items: a download that just landed is the
 * only thing that changes whether the next one is still needed, and the
 * selected model's arrival is also what the last page is waiting on.
 */
async function drainPrefetch(): Promise<void> {
  if (prefetchRunning) return;
  prefetchRunning = true;
  try {
    while (prefetchQueue.length > 0) {
      const id = prefetchQueue.shift();
      if (id === undefined || isHere(id)) continue;
      // Failures are not reported either. Nobody asked for this download, so
      // nobody is owed an error about it; the last page still says the voice
      // is missing, and the checklist behind it still offers to fetch it.
      await downloadModel(id).catch(() => {});
      await readWizardFits();
    }
  } finally {
    prefetchRunning = false;
  }
}

/**
 * Reads each ladder model's fit, so the slider can refuse to recommend one
 * this Mac cannot hold. A catalogue that will not load leaves every fit
 * unknown, and an unknown fit is not a refusal: the slider then offers
 * whatever was asked for, which is what it did before this existed.
 */
async function readWizardFits(): Promise<void> {
  const catalog = await host().getModelCatalog().catch(() => []);
  wizardCatalog = new Map(catalog.map((model) => [model.id, model]));
  // The card's cache is keyed on the rung, and the rung has not moved -- but
  // the sizes, the fit and the model it settles on all just arrived, so the
  // cache has to be dropped rather than trusted.
  ladderShownRung = -1;
  if (wizardStep === "voice") renderLadder();
}

function showWizardStep(step: WizardStep): void {
  wizardStep = step;
  // The frame reads this: the welcome page centres and enlarges its button,
  // which is a property of the page rather than of the button.
  element.wizard.dataset.step = step;
  element.wizard.hidden = false;
  // `aria-modal` tells a screen reader the rest is out of play and does
  // nothing about Tab, which would otherwise walk straight off the wizard
  // into a sidebar and a settings button that are covered but still live.
  element.app.inert = true;
  for (const section of Array.from(
    element.wizard.querySelectorAll<HTMLElement>(".wizard-step"),
  )) {
    section.hidden = section.dataset.step !== step;
  }
  renderWizard();
  // Whatever the step is about should be reachable from the keyboard without
  // first tabbing back through the page behind it.
  element.wizard
    .querySelector<HTMLElement>(`.wizard-step[data-step="${step}"] input, .wizard-step[data-step="${step}"] button`)
    ?.focus();
}

/** Everything on the frame that depends on which step is up. */
function renderWizard(): void {
  if (wizardStep === null) return;
  element.wizardNext.textContent = wizardNextLabel(wizardStep);
  element.wizardNext.disabled = !wizardCanAdvance(wizardStep);

  if (wizardStep === "voice") renderLadder();
  if (wizardStep === "shortcut") renderKeypick();
  if (wizardStep === "permissions") renderWizardChecklist();
  watchPermissions(wizardStep === "permissions");
  if (wizardStep === "polish") renderWizardPolish();
  if (wizardStep === "ready") renderWizardReady();
}

function wizardNextLabel(step: WizardStep): string {
  if (step === "welcome") return "Get started";
  if (step === "ready") return "Start dictating";
  if (step === "voice") {
    // Untouched, the slider is a recommendation rather than a decision, and
    // saying so is more use than naming a model nobody chose. Once it has
    // been moved it is a choice, and the button names what was chosen --
    // which is also the last chance to notice the Mac stepped it down.
    if (!ladderTouched) return "Continue with default model";
    return `Continue with ${chooseModel(ladderIndex, (id) => wizardCatalog.get(id)?.fit ?? null).label}`;
  }
  return "Continue";
}

/**
 * Whether the permissions are being reported at all.
 *
 * The three booleans start false and are filled in by the native helper, so
 * "not granted" and "nobody has told us yet" arrive looking identical. That
 * matters because the page they gate has no way past it: a helper that is
 * not running, or one that cannot read the microphone's status, would hold
 * somebody on page four of a wizard with a disabled button and no
 * explanation -- and every switch already flipped in System Settings.
 *
 * Which is not hypothetical. It happened here: a dev build launched outside
 * LaunchServices had its permissions attributed elsewhere, so the helper
 * reported false for grants that were real, and the wizard would not move.
 */
function permissionsAreKnown(): boolean {
  if (hotkeyStatus === null) return false;
  // `running` is the helper process; without it the two booleans are stale
  // defaults rather than answers.
  if (!hotkeyStatus.running) return false;
  return hotkeyStatus.microphone !== "unknown";
}

/**
 * Whether this step has been answered well enough to leave.
 *
 * Only the permissions can fail it, and only when they are refusing rather
 * than silent. The model has one selected from the moment the page opens,
 * the key has one too, and None is a real answer to the polish question
 * rather than an unanswered one.
 */
function wizardCanAdvance(step: WizardStep): boolean {
  if (step !== "permissions") return true;
  // Gate on denial, never on ignorance. Refusing to advance because nothing
  // answered is the difference between a firm wizard and a trapped one.
  if (!permissionsAreKnown()) return true;
  return permissionSteps().every((one) => one.done);
}

/**
 * The three macOS permissions, named rather than filtered by exception.
 *
 * This used to be the setup list minus "model", which quietly took in every
 * step added afterwards: the polish model turned up on the permissions page
 * -- and, because this list is also the page's gate, made Continue wait on a
 * 397 MB download before it would let anyone past. A download is not a
 * permission, and neither is anything else that might be added here later.
 */
const WIZARD_PERMISSIONS = ["microphone", "accessibility", "input-monitoring"] as const;

function permissionSteps(): SetupStep[] {
  return setupSteps().filter((step) =>
    WIZARD_PERMISSIONS.some((id) => id === step.id),
  );
}

/* -------------------------------------------------------------------------
 * 1. The voice
 * ---------------------------------------------------------------------- */

/**
 * What the slider is currently pointing at, and what that costs.
 *
 * The name under the slider is the rung's name, but the model beside it is
 * what `chooseModel` settled on -- which is a rung lower when this Mac cannot
 * hold what was asked for. The two disagreeing on screen with no explanation
 * is why the note exists.
 */
function renderLadder(): void {
  // The track paints its own filled portion from this, because a range input
  // gives no way to style "everything to the left of the thumb". Written on
  // every frame of a glide, which is what makes the fill move with the thumb.
  const span = Math.max(1, MODEL_LADDER.length - 1);
  element.ladderSlider.style.setProperty(
    "--fill",
    `${(Math.min(span, Math.max(0, ladderIndex)) / span) * 100}%`,
  );

  // Everything below describes a rung, not a position, so it is rebuilt when
  // the rung changes rather than sixty times a second on the way there --
  // replaceChildren on the ticks and the facts every frame is itself enough
  // to make a glide stutter.
  const rung = Math.round(Math.min(span, Math.max(0, ladderIndex)));
  if (rung === ladderShownRung) return;
  ladderShownRung = rung;
  renderVoiceButton();

  const choice = chooseModel(rung, (id) => wizardCatalog.get(id)?.fit ?? null);

  // The name follows the handle, because a label that disagreed with where
  // the slider physically is reads as a broken control. The sentence under it
  // follows the model, because it is a claim about what you will get -- and
  // "near the best transcription there is" over the name of a small model is
  // the one thing on this page that could be flatly untrue.
  element.ladderName.textContent = ladderRung(rung).name;
  element.ladderModel.textContent = choice.label;
  element.ladderTrade.textContent = ladderRung(choice.index).trade;

  renderLadderTicks();
  renderLadderFacts(choice.id);

  element.ladderNote.hidden = choice.askedFor === null;
  element.ladderNote.textContent =
    choice.askedFor === null
      ? ""
      : `${getSpeechModel(choice.askedFor.id).label} wants more memory than this Mac has to spare, so ${choice.label} is the most accurate one that fits.`;

}

/**
 * Moves the slider to a rung over a couple of hundred milliseconds.
 *
 * A range input cannot be asked to animate: the thumb is drawn wherever
 * `value` says, and no CSS transition reaches it -- so clicking the track
 * teleported the thumb to the rung you aimed at. The value itself is tweened
 * instead, which the thumb, the filled track and the notches all follow for
 * free because they are all drawn from it.
 *
 * Not used while dragging. A drag has to stay under the finger, and anything
 * easing its way toward the pointer is lag rather than polish.
 */
function glideLadderTo(target: number): void {
  const span = MODEL_LADDER.length - 1;
  const to = Math.min(span, Math.max(0, target));
  cancelLadderGlide();

  const from = ladderIndex;
  const distance = Math.abs(to - from);
  // Somebody who has asked for less movement has asked for this too.
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced || distance < 0.001) {
    setLadderIndex(to);
    return;
  }

  // Put the thumb back where it was, now, before anything is painted. A
  // click on the track has already moved the input's own value to where it
  // was aimed, and the first eased frame is a whole frame away -- long
  // enough to show the thumb at the destination and then yank it back to
  // start the journey it was supposed to make.
  setLadderIndex(from);

  // Scaled by distance, so a nudge to the next rung is not given the same
  // couple of hundred milliseconds as a jump across the whole ladder, and
  // capped so the long one still feels like a control rather than a tour.
  const duration = Math.min(260, 110 + distance * 55);
  const start = performance.now();

  const frame = (now: number): void => {
    const progress = Math.min(1, (now - start) / duration);
    // Out-cubic: leaves immediately, arrives gently, which is what reads as
    // the thumb being thrown rather than dragged.
    const eased = 1 - (1 - progress) ** 3;
    setLadderIndex(from + (to - from) * eased);
    if (progress < 1) {
      ladderGlide = requestAnimationFrame(frame);
      return;
    }
    ladderGlide = null;
    setLadderIndex(to);
  };
  ladderGlide = requestAnimationFrame(frame);
}

/** The Continue button names the model, so it moves when the slider does. */
function renderVoiceButton(): void {
  if (wizardStep !== "voice") return;
  element.wizardNext.textContent = wizardNextLabel("voice");
}

function cancelLadderGlide(): void {
  if (ladderGlide === null) return;
  cancelAnimationFrame(ladderGlide);
  ladderGlide = null;
}

/** Writes a position to both the control and the card drawn from it. */
function setLadderIndex(value: number): void {
  ladderIndex = value;
  // Assigning `value` does not fire `input`, so this cannot feed back into
  // the handler that started the glide.
  element.ladderSlider.value = String(value);
  renderLadder();
}

/**
 * A notch per rung, under the track.
 *
 * Five positions on a continuous-looking slider is not something anyone
 * discovers by dragging it. The notches say up front that this has stops
 * rather than a range, and how many.
 */
function renderLadderTicks(): void {
  element.ladderTicks.replaceChildren(
    ...MODEL_LADDER.map((rung, index) => {
      const tick = document.createElement("li");
      tick.className = "ladder-tick";
      const at = Math.round(ladderIndex);
      tick.dataset.state = index === at ? "here" : index < at ? "below" : "above";
      tick.title = rung.name;
      return tick;
    }),
  );
}

/**
 * What the chosen model costs, from the catalogue rather than from adjectives.
 *
 * "More accurate" is a promise with nothing behind it until there is a number
 * beside it. These three are the ones that differ down the ladder and that
 * somebody choosing would actually weigh: what it fetches, what it keeps
 * resident, and how often it is wrong.
 */
function renderLadderFacts(id: SpeechModelId): void {
  const model = wizardCatalog.get(id);
  const facts: Array<[string, string]> = [
    ["Download", model?.downloadBytes != null ? formatBytes(model.downloadBytes) : "—"],
    ["Memory", model ? formatMemory(model.memoryMb) : "—"],
    // Word error rate, said as the thing it measures. "WER 2.1" is a term of
    // art; "about 2 words in 100" is the same fact to someone who has never
    // read a speech paper.
    [
      "Gets wrong",
      model?.wer != null ? `~${model.wer.toFixed(1)} words in 100` : "—",
    ],
  ];

  element.ladderFacts.replaceChildren(
    ...facts.map(([term, value]) => {
      const cell = document.createElement("div");
      cell.className = "ladder-fact";
      const label = document.createElement("dt");
      label.textContent = term;
      const detail = document.createElement("dd");
      detail.textContent = value;
      cell.append(label, detail);
      return cell;
    }),
  );
}

/**
 * Selects the model the slider landed on and makes sure it is being fetched.
 *
 * Usually there is nothing to start: the two the queue was primed with are
 * the two most people leave the slider on. A third choice is put at the front
 * of the queue rather than downloaded separately, because the host runs one
 * download at a time and starting a second here would simply be refused.
 */
async function commitLadderChoice(): Promise<void> {
  const choice = chooseModel(ladderIndex, (id) => wizardCatalog.get(id)?.fit ?? null);
  if (choice.id !== settings.modelId) await patchSettings({ modelId: choice.id });
  enqueuePrefetch(choice.id, { first: true });
  void drainPrefetch();
}

/* -------------------------------------------------------------------------
 * 2. The key
 * ---------------------------------------------------------------------- */

/**
 * The two rows of a Mac keyboard that hold every key Waveform can watch.
 *
 * Drawn rather than listed. The whole difference between Left Option and
 * Right Option is which thumb reaches it, and a column of names made you read
 * all six labels to discover that -- while a keyboard says it without a word.
 *
 * `u` is the key's width in twelfths of a letter key -- a grid column count,
 * not a flex weight. Every row sums to 60, so the rows are exactly as wide as
 * each other: with flex and a gap, a row of twelve keys lost twice as much
 * width to gaps as a row of eight and came up visibly short. The keys with no
 * `id` are not offered: Control and the arrows are not held comfortably, the
 * space bar types, and the left Shift has no binding. They are drawn anyway
 * and dimmed, because the ones that can be chosen are only findable relative
 * to the ones that cannot.
 */
interface KeyboardKey {
  id?: HotkeyBindingId;
  glyph: string;
  u: number;
  /** A letter key: drawn as an unlabelled cap, purely to shape the row. */
  filler?: boolean;
}

const KEYBOARD_COLUMNS = 60;

const KEYBOARD_ROWS: readonly (readonly KeyboardKey[])[] = [
  [
    { glyph: "\u21E7", u: 10 },
    ...Array.from({ length: 10 }, () => ({ glyph: "", u: 4, filler: true })),
    { id: "right-shift", glyph: "\u21E7", u: 10 },
  ],
  [
    { id: "fn", glyph: "fn", u: 5 },
    { glyph: "\u2303", u: 5 },
    { id: "left-option", glyph: "\u2325", u: 5 },
    { id: "left-command", glyph: "\u2318", u: 7 },
    { glyph: "", u: 21, filler: true },
    { id: "right-command", glyph: "\u2318", u: 7 },
    { id: "right-option", glyph: "\u2325", u: 5 },
    { glyph: "\u25C0\u25B6", u: 5 },
  ],
];

/**
 * What choosing each key costs you, which the old list did not say at all.
 *
 * Six equally-weighted options with no guidance is not a choice, it is a
 * quiz. These are the reasons somebody would pick one over another.
 */
const KEY_ADVICE: Partial<Record<HotkeyBindingId, string>> = {
  fn: "The default, and the only one here that does nothing else on its own.",
  "left-option": "Option is free on most keyboards, and this one falls under your left thumb.",
  "right-option": "Option is free on most keyboards, and this one falls under your right thumb.",
  "left-command": "Command starts most keyboard shortcuts, so it is the busiest key on this row.",
  "right-command": "Command starts most keyboard shortcuts, so it is the busiest key on this row.",
  "right-shift": "Rarely held on its own, and easy to reach without moving your hand.",
};

/**
 * Draws the keyboard and marks the chosen key.
 *
 * Rebuilt from `KEYBOARD_ROWS` rather than toggled in place: the rows are
 * static, and one function that draws the whole thing is easier to be sure of
 * than one that draws it and another that edits it.
 */
function renderKeypick(): void {
  for (const row of KEYBOARD_ROWS) {
    const width = row.reduce((total, key) => total + key.u, 0);
    // Not a guard against user input -- a guard against editing the table
    // above and quietly pushing a key onto a second line.
    if (width !== KEYBOARD_COLUMNS) {
      void host().log("error", "wizard", `Keyboard row is ${width} of ${KEYBOARD_COLUMNS} columns`);
    }
  }

  element.keyboard.replaceChildren(
    ...KEYBOARD_ROWS.map((row) => {
      const line = document.createElement("div");
      line.className = "keyboard-row";
      line.append(
        ...row.map((key) => {
          const binding = key.id ? getHotkeyBinding(key.id) : null;
          // A key that can be chosen is a button; one that cannot is not,
          // so it is not in the tab order and cannot be clicked at all.
          const cap = document.createElement(binding ? "button" : "span");
          cap.className = "keyboard-key";
          cap.style.gridColumn = `span ${key.u}`;
          cap.textContent = key.glyph;
          if (key.filler) cap.dataset.filler = "true";
          if (!binding) {
            cap.dataset.available = "false";
            return cap;
          }
          (cap as HTMLButtonElement).type = "button";
          cap.dataset.hotkey = binding.id;
          cap.setAttribute("role", "radio");
          cap.setAttribute("aria-checked", String(binding.id === settings.hotkeyId));
          cap.setAttribute("aria-label", binding.label);
          cap.title = binding.label;
          return cap;
        }),
      );
      return line;
    }),
  );

  // The glyphs on the keys are shared -- two Commands, two Options -- so the
  // caption is what says which one is chosen, in words.
  const chosen = getHotkeyBinding(settings.hotkeyId);
  element.keyboardCaption.replaceChildren();
  if (chosen) {
    const name = document.createElement("strong");
    // The glyph as well as the name. The name is what disambiguates the two
    // Commands and the two Options, and the glyph is what is actually
    // printed on the key you are about to go and hold.
    name.textContent = `${chosen.label} (${hotkeyKeycap(chosen)})`;
    element.keyboardCaption.append(name, text(` ${KEY_ADVICE[chosen.id] ?? ""}`));
  } else {
    element.keyboardCaption.append(text("Pick a key to hold while you speak."));
  }

  // Reserved, not removed: see the comment on the note in index.html.
  element.wizardFnNote.classList.toggle("is-reserved", settings.hotkeyId !== "fn");
}

/* -------------------------------------------------------------------------
 * 3. The permissions
 * ---------------------------------------------------------------------- */

/**
 * The same three rows the Setup page draws, from the same list.
 *
 * Built here rather than moved out into a shared helper because the Setup
 * page's version carries the model step and this one must not: the download
 * is already running behind this page, and a row offering to start it again
 * would be a second Download button for a file that is arriving.
 */
function renderWizardChecklist(): void {
  const outstanding = permissionSteps().filter((step) => !step.done);
  // A Continue that is greyed out with no reason beside it is a dead end.
  element.wizardPermissionsNote.textContent =
    outstanding.length === 0
      ? "macOS ties these to the app's signature. If one looks granted but is refused, remove Waveform from the list and add it again."
      : permissionsAreKnown()
        ? "All three are needed before Waveform can dictate, so this is the one page that waits for you."
        : "These cannot be read just now, so this page will not hold you up. The card on Transcripts will keep offering them.";

  element.wizardChecklist.replaceChildren(
    ...permissionSteps().map((step) => {
      const row = document.createElement("li");
      row.className = "check";
      row.dataset.check = step.id;
      row.dataset.done = String(step.done);

      const mark = document.createElement("span");
      mark.className = "check-mark";
      mark.setAttribute("aria-hidden", "true");

      const body = document.createElement("span");
      body.className = "check-body";
      const title = document.createElement("strong");
      title.textContent = step.title;
      body.append(title);

      // A granted permission needs no instructions for granting it. The
      // detail line explains where to find the switch and what macOS calls
      // it, which is worth two lines while it is outstanding and is clutter
      // the moment it is not.
      if (!step.done) {
        const detail = document.createElement("small");
        detail.textContent = step.detail;
        body.append(detail);
      }

      row.append(mark, body);

      if (!step.done) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "pill-button is-primary";
        button.dataset.fix = step.id;
        button.textContent = step.action;
        row.append(button);
      }
      return row;
    }),
  );
}

/**
 * Re-reads the permissions while that page is the one on screen.
 *
 * All three are granted in System Settings, in another window, and two of
 * them never tell this one anything: the native helper notices within a
 * second and a half, but nothing asks it while the click that opened System
 * Settings is the last thing that happened. So the row kept its Allow button
 * long after the switch had been flipped, which reads as a button that does
 * not work.
 *
 * Only while the page is up, and stopped on the way out: this is a poll, and
 * one that outlived the step it belongs to would run for the life of the app.
 */
function watchPermissions(on: boolean): void {
  if (permissionWatch !== null) {
    clearInterval(permissionWatch);
    permissionWatch = null;
  }
  if (!on) return;
  permissionWatch = setInterval(() => {
    void host()
      .getHotkeyStatus()
      .then((status) => {
        // Rendering on every tick would rebuild the rows under the pointer
        // four times a second for no reason.
        if (JSON.stringify(status) === JSON.stringify(hotkeyStatus)) return;
        hotkeyStatus = status;
        renderHotkeyStatus();
      })
      .catch(() => {});
  }, 1_000);
}

/* -------------------------------------------------------------------------
 * 4. The polish level
 * ---------------------------------------------------------------------- */

/**
 * The three levels, and -- above None -- where the rewrite would run.
 *
 * Neither engine is finished being set up here: the local one is a second
 * download and the hosted one is an API key, and both belong on a page that
 * can show a progress bar and a password field. What this page settles is
 * which of those two the answer is, so Settings opens on the right half of
 * the page rather than on a choice nobody knew they had.
 */
function renderWizardPolish(): void {
  for (const card of Array.from(
    element.wizardPolishLevels.querySelectorAll<HTMLElement>("[data-level]"),
  )) {
    card.setAttribute("aria-checked", String(card.dataset.level === settings.polishLevel));
  }

  // Always on screen, whatever the level. It used to appear with the first
  // choice above None and take the key field with it, which moved the three
  // cards -- and the pointer that had just clicked one -- halfway up the
  // window. The page now has one height, and the parts that do not apply yet
  // say so instead of vanishing.
  for (const button of Array.from(
    element.wizardEngine.querySelectorAll<HTMLElement>("[data-engine]"),
  )) {
    button.setAttribute("aria-checked", String(button.dataset.engine === settings.polishEngine));
  }
  element.wizardEngineNote.textContent =
    settings.polishLevel === "none"
      ? "Nothing rewrites at None; this is what would run it."
      : settings.polishEngine === "local"
        ? "A second, smaller model, downloaded here. Your words never leave this Mac."
        : "A hosted model; your dictated text is sent to it. The key is free to create, and can wait until Settings.";

  renderWizardKey();
}

/**
 * The key field, which only exists while the hosted engine is the answer.
 *
 * A saved key is shown as saved rather than as a field to fill in again: the
 * key itself never leaves the host, so there is nothing to put back in the
 * box, and an empty box beside "OpenRouter" reads as work still to do.
 */
function renderWizardKey(): void {
  // Three occupants of one slot. Hidden outright rather than reserved with
  // `visibility`, because the slot itself holds the height -- and a slot that
  // is always occupied does not need anything reserving.
  const off = settings.polishLevel === "none";
  const wanted = !off && settings.polishEngine === "openrouter";
  const local = !off && settings.polishEngine === "local";
  // Nothing rewrites at None, so there is nothing to set up and nothing to
  // describe. The slot closes rather than explaining itself.
  element.wizardEngineDetail.hidden = off;
  element.wizardLocalRow.hidden = !local;
  element.wizardKeyRow.hidden = !wanted;
  if (local) void renderWizardLocal();
  if (!wanted) return;

  const saved = aiStatus?.hasApiKey === true;
  element.wizardKeyState.textContent = saved
    ? aiStatus?.memoryOnly === true
      ? "Saved for this session only"
      : "Saved"
    : "";
  element.wizardKeyState.classList.toggle("key-saved", saved && aiStatus?.memoryOnly !== true);

  // Never overwrite something half-typed; only fill the box the first time.
  if (element.wizardKeyInput.dataset.pristine !== "false") {
    element.wizardKeyInput.value = saved ? KEY_MASK : "";
    element.wizardKeyInput.dataset.pristine = "true";
  }
  syncWizardKeyButton();
}

/**
 * What choosing "This Mac" costs and how far along it is.
 *
 * The slot used to be blank here: the key field is only for the hosted
 * engine, so picking the local one left a rectangle of nothing where the
 * setup for it should be. There is something to say -- a second model is
 * being fetched on the strength of that choice -- and not saying it made the
 * download invisible on the one page it is relevant to.
 */
async function renderWizardLocal(): Promise<void> {
  const catalog = await host().getPolishModelCatalog().catch(() => []);
  const model =
    catalog.find((one) => one.id === settings.localModelId) ??
    catalog.find((one) => one.id === DEFAULT_POLISH_MODEL_ID);
  if (!model) return;

  element.wizardLocalName.textContent = `${model.label} · ${formatBytes(model.downloadBytes)}`;
  const downloading = polishDownloading === model.id;
  element.wizardLocalState.textContent = model.installed
    ? "Ready"
    : downloading
      ? "Downloading…"
      : "Downloads in the background";
  element.wizardLocalState.dataset.state = model.installed
    ? "ready"
    : downloading
      ? "working"
      : "waiting";
  // The bar is only honest while something is moving; a full or empty one
  // sitting under a finished download is a progress bar lying.
  element.wizardLocalTrack.classList.toggle("is-reserved", !downloading);
}

function syncWizardKeyButton(): void {
  const edited = element.wizardKeyInput.dataset.pristine === "false";
  element.wizardKeySave.disabled =
    !edited || element.wizardKeyInput.value.trim().length === 0;
}

function saveWizardApiKey(): void {
  const value = element.wizardKeyInput.value.trim();
  if (element.wizardKeyInput.dataset.pristine === "true" || !value) return;
  void host()
    .setOpenRouterKey(value)
    .then((status) => {
      element.wizardKeyInput.dataset.pristine = "true";
      // Repaints both copies of this row: the one here and the one in
      // Settings, which is the same key.
      renderAiStatus(status);
      renderWizardKey();
      flash(element.wizardKeySave, "Saved");
    });
}

/**
 * Fetches the model that does the rewriting, as soon as rewriting is asked for.
 *
 * Any level above None needs something to run it, and for somebody who has
 * just installed the app that is almost certainly the model on this Mac: the
 * hosted engine cannot rewrite a word until an OpenRouter key has been pasted
 * in, and nobody has one four pages into a first run. So the download starts
 * on the choice rather than on the page in Settings where they would later
 * discover it was needed.
 *
 * Silent, like the speech prefetch, and on a separate lane -- Rust runs one
 * speech download and one polish download, so this does not queue behind the
 * voice still arriving. Whichever local model is selected is the one fetched,
 * which on a fresh install is the smallest.
 */
async function prefetchPolishModel(): Promise<void> {
  if (settings.polishLevel === "none") return;
  if (polishDownloading !== null) return;
  const catalog = await host().getPolishModelCatalog().catch(() => []);
  // Whatever is selected, which on a fresh install is Qwen3 0.6B Q4 -- the
  // lightest, and the only one most Macs need to tidy a paragraph. The
  // fallback covers a stored id the catalogue no longer carries.
  const wanted =
    catalog.find((model) => model.id === settings.localModelId) ??
    catalog.find((model) => model.id === DEFAULT_POLISH_MODEL_ID);
  if (!wanted || wanted.installed) return;
  void renderWizardLocal();
  // Not awaited by the caller and not reported: nobody asked for it, so a
  // failure is not theirs to answer. The AI polish page still offers it.
  await downloadPolishModel(wanted.id).catch(() => {});
}

/* -------------------------------------------------------------------------
 * 5. The gesture
 * ---------------------------------------------------------------------- */

function renderWizardReady(): void {
  const binding = getHotkeyBinding(settings.hotkeyId);
  const glyph = binding ? hotkeyKeycap(binding) : "—";
  element.readyKey.textContent = glyph;
  element.readyKeyTap.textContent = `${glyph} ${glyph}`;

  // Saying "That's everything" over a model that has not arrived is the one
  // way this page can be actively misleading.
  const outstanding = setupSteps().filter((step) => !step.done);
  element.readyTitle.textContent = outstanding.length === 0 ? "That's everything" : "Nearly there";

  void readPolishModel().then(renderReadyProgress);
  renderReadyProgress();
}

/** The polish model as the catalogue last described it. */
async function readPolishModel(): Promise<void> {
  const catalog = await host().getPolishModelCatalog().catch(() => []);
  wizardPolishModel =
    catalog.find((model) => model.id === settings.localModelId) ??
    catalog.find((model) => model.id === DEFAULT_POLISH_MODEL_ID) ??
    null;
}

/**
 * The two downloads, on the one page where whether they have finished is the
 * answer to the question being asked.
 *
 * A row appears only while its model is not here yet, so somebody whose
 * downloads landed during the questions -- which is most people, which is
 * the whole point of starting them early -- sees nothing at all.
 */
function renderReadyProgress(): void {
  const speech = getSpeechModel(settings.modelId);
  const speechPending = !modelInstalled;
  element.readySpeechRow.hidden = !speechPending;
  if (speechPending) {
    element.readySpeechName.textContent = speech.label;
    const busy = downloading !== null;
    element.readySpeechState.textContent = busy ? `${speechPercent}%` : "Waiting to start";
    element.readySpeechBar.style.width = `${busy ? speechPercent : 0}%`;
  }

  // Only when something above None is selected: at None no model rewrites,
  // so one arriving is not something this page is waiting on.
  const polish = wizardPolishModel;
  const polishPending =
    settings.polishLevel !== "none" && polish !== null && !polish.installed;
  element.readyPolishRow.hidden = !polishPending;
  if (polishPending && polish) {
    element.readyPolishName.textContent = `${polish.label} · AI polish`;
    const busy = polishDownloading !== null;
    element.readyPolishState.textContent = busy ? `${polishPercent}%` : "Waiting to start";
    element.readyPolishBar.style.width = `${busy ? polishPercent : 0}%`;
  }

  element.readyProgress.hidden = !speechPending && !polishPending;
}

/* -------------------------------------------------------------------------
 * Moving through it
 * ---------------------------------------------------------------------- */

async function advanceWizard(): Promise<void> {
  if (wizardStep === null) return;
  // Checked here as well as on the button: a disabled button is a rendering
  // of this rule, not the rule itself, and this is also reached from the
  // Return key on the default-model link.
  if (!wizardCanAdvance(wizardStep)) return;
  if (wizardStep === "voice") await commitLadderChoice();
  const at = WIZARD_STEPS.indexOf(wizardStep);
  const next = WIZARD_STEPS[at + 1];
  if (!next) {
    closeWizard();
    return;
  }
  showWizardStep(next);
}

/**
 * Puts the wizard away for good, from the last page.
 *
 * The flag is the only thing written here; everything the wizard asks was
 * saved as it was answered, so quitting halfway through loses nothing and
 * reopens where it stood.
 */
function closeWizard(): void {
  wizardStep = null;
  watchPermissions(false);
  element.wizard.hidden = true;
  element.app.inert = false;
  void patchSettings({ onboardingCompleted: true });
}

function wireWizard(): void {
  element.wizardNext.addEventListener("click", () => void advanceWizard());

  // A click on the track and the first instant of a drag are the same event
  // with the same value. These two tell them apart.
  element.ladderSlider.addEventListener("pointerdown", () => {
    ladderPointerDown = true;
    ladderPointerMoved = false;
  });
  // On the window, not the slider: the pointer is captured by the input for
  // the length of a drag, but a drag that leaves the control still has to
  // count as movement.
  window.addEventListener("pointermove", () => {
    if (!ladderPointerDown || ladderPointerMoved) return;
    ladderPointerMoved = true;
    // From here the thumb belongs to the finger.
    cancelLadderGlide();
  });
  window.addEventListener("pointerup", () => {
    ladderPointerDown = false;
  });

  element.ladderSlider.addEventListener("input", () => {
    const raw = Number(element.ladderSlider.value);
    // Touched by hand: from here the button names the model rather than
    // calling it the default. Written before the branch below, because a
    // click that lands on the rung it was already on changes no rung and so
    // would never reach the card's redraw.
    ladderTouched = true;
    renderVoiceButton();
    if (ladderPointerDown && !ladderPointerMoved) {
      // Pressed somewhere along the track without dragging. The input has
      // already jumped its value there; put it back and travel.
      glideLadderTo(Math.round(raw));
      return;
    }
    cancelLadderGlide();
    ladderIndex = raw;
    renderLadder();
  });

  // Released after a drag: settle onto the rung it is nearest, so the thumb
  // never comes to rest between two notches the card is not describing. A
  // click is already gliding and must not be restarted.
  element.ladderSlider.addEventListener("change", () => {
    if (!ladderPointerMoved) return;
    glideLadderTo(Math.round(Number(element.ladderSlider.value)));
  });
  // `step="any"` is what makes the drag continuous, and it would otherwise
  // make an arrow key move a hundredth of a rung. The keyboard gets the stops
  // the pointer no longer has.
  element.ladderSlider.addEventListener("keydown", (event) => {
    const last = MODEL_LADDER.length - 1;
    const step =
      event.key === "ArrowRight" || event.key === "ArrowUp"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowDown"
          ? -1
          : 0;
    let next = step === 0 ? null : Math.round(ladderIndex) + step;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = last;
    if (next === null) return;
    event.preventDefault();
    ladderTouched = true;
    renderVoiceButton();
    glideLadderTo(next);
  });
  element.keyboard.addEventListener("click", (event) => {
    const option = (event.target as HTMLElement).closest<HTMLElement>("[data-hotkey]");
    const id = option?.dataset.hotkey;
    if (!isHotkeyBindingId(id)) return;
    void patchSettings({ hotkeyId: id });
  });

  element.wizardPolishLevels.addEventListener("click", (event) => {
    const card = (event.target as HTMLElement).closest<HTMLElement>("[data-level]");
    const level = card?.dataset.level;
    if (!isPolishLevel(level)) return;
    // The same write the AI Polish page makes: the level owns the instruction
    // the dictation path runs, so choosing one puts that level's default back.
    void patchSettings({
      polishLevel: level,
      transformPrompt: transformPromptFor(level),
    }).then(prefetchPolishModel);
  });

  element.wizardKeyInput.addEventListener("input", () => {
    element.wizardKeyInput.dataset.pristine = "false";
    syncWizardKeyButton();
  });
  element.wizardKeyInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") saveWizardApiKey();
  });
  element.wizardKeySave.addEventListener("click", saveWizardApiKey);
  element.wizardOpenOpenRouter.addEventListener("click", () => {
    void host().openUrl("https://openrouter.ai/keys");
  });

  element.wizardEngine.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>("[data-engine]");
    const engine = button?.dataset.engine;
    if (engine !== "local" && engine !== "openrouter") return;
    void patchSettings({ polishEngine: engine });
  });

  // The permission rows are rebuilt whenever one is granted, so the button is
  // found on the way up rather than bound to a node that will be replaced.
  element.wizardChecklist.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>("[data-fix]");
    if (button) resolveSetupStep(button.dataset.fix ?? "");
  });
}

function setStatus(message: string): void {
  element.overviewModelState.textContent = message;
}

function requireElement<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
}
