import type {
  AiStatus,
  AppStats,
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
} from "../shared/hotkeys";
import {
  getSpeechModel,
  isSpeechModelId,
  type SpeechModelId,
} from "../shared/models";
import { SPEECH_LANGUAGES, isSpeechLanguage } from "../shared/languages";
import { microphoneDevices } from "../shared/microphones";
import { DEFAULT_SETTINGS, POLISH_SHORTCUTS, type AppSettings } from "../shared/settings";
import { isPolishLevel, type PolishLevel } from "../shared/polish-levels";
import { isPolishModelId } from "../shared/polish-models";
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
let lifetimeSessions = 0;
let searchOpen = false;
let query = "";
let microphones: MicrophoneDevice[] = [];

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
  element.versionLine.textContent = appVersion ? `${appName} ${appVersion}` : appName;
  element.aboutVersion.textContent = appVersion ? `${appName} ${appVersion}` : appName;
  // Pull the engine's current stage: any event it pushed while this window was
  // still loading is already gone.
  handleModelEvent(await host().getModelState());

  hotkeyStatus = await host().getHotkeyStatus();
  renderHotkeyStatus();
  renderAiStatus(await host().getAiStatus());
  await refreshModelInstalled();
}

function wireEvents(): void {
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
    void host().openUrl("https://github.com/vipiny35/waveform");
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
  for (const button of Array.from(
    document.querySelectorAll<HTMLElement>(".nav[aria-label='Sections'] [data-view]"),
  )) {
    const active = button.dataset.view === view;
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  for (const id of ["dictate", "overview", "models", "ai"]) {
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
  }
}

/** Progress written next to Cancel — the facts line stays as size and RAM. */
function showPolishDownloadProgress(event: ModelEvent): void {
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
 * Ordered the way a person hits them: hear you, notice the shortcut, type the
 * result, and have something to do the listening with.
 *
 * The voice is a step like any other because it is one. Weights are not
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
      id: "input-monitoring",
      done: status?.inputMonitoring === true,
      title: "Let it watch for your shortcut",
      detail: "Input Monitoring — so your key works in every app, not just this one",
      action: "Allow",
      label: "Input Monitoring",
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
      id: "model",
      done: modelInstalled,
      title: "Download a voice",
      detail: `${model.label}${modelDownloadSize === "" ? "" : ` · ${modelDownloadSize}`} — the part that turns speech into words`,
      action: "Download",
      label: "a voice to listen with",
    },
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
  if (id === "microphone") {
    // Same path as opening Dictation: getUserMedia shows the allow prompt.
    // If macOS already refused, only System Settings can flip it back on.
    void refreshMicrophones(true).then((ok) => {
      if (!ok) void host().openPrivacySettings("microphone");
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
  const matches =
    query === ""
      ? entries
      : entries.filter((entry) => entry.text.toLowerCase().includes(query.toLowerCase()));

  // Both cards stay in the tree; renderDictationDeck decides which is showing.
  element.history.replaceChildren(element.onboard, element.dictationDeck);
  element.history.classList.toggle("is-empty", matches.length === 0);

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
  article.className = entry.id === freshId ? "entry is-fresh" : "entry";

  const time = document.createElement("span");
  time.className = "entry-time";
  time.textContent = formatTime(entry.createdAt);
  time.title = new Date(entry.createdAt).toLocaleString();

  const text = document.createElement("p");
  text.className = "entry-text";
  text.textContent = entry.text;

  const actions = document.createElement("span");
  actions.className = "entry-actions";
  actions.append(
    iconButton("Copy", COPY_ICON, "", () => {
      void navigator.clipboard.writeText(entry.text);
    }),
    iconButton("Delete", TRASH_ICON, "is-danger", () => {
      void host().deleteDictation(entry.id).then((next) => {
        entries = next;
        freshId = null;
        renderHistory();
      });
    }),
  );

  article.append(time, text, actions);
  return article;
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
  button.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  button.addEventListener("click", () => {
    onClick();
    if (label === "Copy") {
      button.classList.add("is-done");
      setTimeout(() => button.classList.remove("is-done"), 900);
    }
  });
  return button;
}

/* Lucide, like the rest; see the note in index.html. */
const COPY_ICON = '<rect width="14" height="14" x="8" y="8" rx="2" ry="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />';

const TRASH_ICON = '<path d="M10 11v6" /><path d="M14 11v6" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />';

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

function setStatus(message: string): void {
  element.overviewModelState.textContent = message;
}

function requireElement<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
}
