import type {
  AiStatus,
  AppStats,
  SavedDictation,
  DictationUpdate,
  HotkeyStatus,
  MicrophoneDevice,
  LogLine,
  ModelEvent,
  ModelFit,
  ModelStatus,
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
import {
  DEFAULT_POLISH_PROMPT,
  DEFAULT_TRANSFORM_PROMPT,
  SUGGESTED_MODELS,
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
  modelList: requireElement<HTMLElement>("model-list"),
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
  updateState: requireElement<HTMLElement>("update-state"),
  updateCheck: requireElement<HTMLButtonElement>("update-check"),
  updateInstall: requireElement<HTMLButtonElement>("update-install"),
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
  setupBanner: requireElement<HTMLElement>("setup-banner"),
  bannerTitle: requireElement<HTMLElement>("banner-title"),
  bannerDetail: requireElement<HTMLElement>("banner-detail"),
  bannerAction: requireElement<HTMLButtonElement>("banner-action"),
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
  transformToggle: requireElement<HTMLInputElement>("transform-toggle"),
  transformPrompt: requireElement<HTMLTextAreaElement>("transform-prompt"),
  polishPrompt: requireElement<HTMLTextAreaElement>("polish-prompt"),
  polishShortcut: requireElement<HTMLSelectElement>("polish-shortcut"),
};

let settings: AppSettings = DEFAULT_SETTINGS;
let hotkeyStatus: HotkeyStatus | null = null;
let modelReady = false;
let modelLoading = false;
/** The model whose weights are being fetched, so a second press does nothing. */
let downloading: SpeechModelId | null = null;
/** Whether the models page is listing every size, or only the useful few. */
let showEveryModel = false;
/** The version the app is running, for the line that reports updates. */
let appVersion = "";
/** Everything the log has said this session, oldest first. */
let logLines: LogLine[] = [];
let settingsOpen = false;
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
  element.versionLine.textContent = appVersion ? `Waveform ${appVersion}` : "Waveform";
  element.updateState.textContent = appVersion ? `Waveform ${appVersion}` : "Waveform";
  // Pull the engine's current stage: any event it pushed while this window was
  // still loading is already gone.
  handleModelEvent(await host().getModelState());

  hotkeyStatus = await host().getHotkeyStatus();
  renderHotkeyStatus();
  renderAiStatus(await host().getAiStatus());
}

function wireEvents(): void {
  host().onModelEvent(handleModelEvent);
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
  element.scrim.addEventListener("click", () => toggleSettings(false));
  element.bannerAction.addEventListener("click", () => {
    toggleSettings(true, "setup");
  });
  element.deckSettings.addEventListener("click", () => {
    toggleSettings(true, setupSteps().some((step) => !step.done) ? "setup" : "dictation");
  });

  for (const button of Array.from(
    document.querySelectorAll<HTMLButtonElement>("[data-fix]"),
  )) {
    button.addEventListener("click", () => resolveSetupStep(button.dataset.fix ?? ""));
  }
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && settingsOpen) toggleSettings(false);
  });

  element.modelList.addEventListener("click", (event) => {
    const more = (event.target as HTMLElement).closest<HTMLElement>("[data-show-all]");
    if (more) {
      showEveryModel = more.dataset.showAll === "true";
      void renderModels();
      return;
    }
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-model]");
    const id = row?.dataset.model;
    if (!id || !isSpeechModelId(id)) return;
    // A row whose weights the app can fetch is a download button until it has
    // them, and only then the radio it looks like.
    if (row?.dataset.download === "true") {
      void downloadModel(id);
      return;
    }
    if (row?.getAttribute("aria-disabled") === "true") return;
    void host().selectModel(id);
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
  element.transformToggle.addEventListener("change", () => {
    void patchSettings({ transformOnDictate: element.transformToggle.checked });
  });
  element.transformPrompt.addEventListener("change", () => {
    void patchSettings({ transformPrompt: element.transformPrompt.value });
  });
  element.polishPrompt.addEventListener("change", () => {
    void patchSettings({ polishPrompt: element.polishPrompt.value });
  });
  element.polishShortcut.addEventListener("change", () => {
    void patchSettings({ polishShortcut: element.polishShortcut.value });
  });
  for (const button of Array.from(
    document.querySelectorAll<HTMLButtonElement>("[data-reset]"),
  )) {
    button.addEventListener("click", () => {
      if (button.dataset.reset === "transform") {
        void patchSettings({ transformPrompt: DEFAULT_TRANSFORM_PROMPT });
      } else {
        void patchSettings({ polishPrompt: DEFAULT_POLISH_PROMPT });
      }
    });
  }

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
    void checkForUpdate();
  });
  element.updateInstall.addEventListener("click", () => {
    void installUpdate();
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
  for (const id of ["dictate", "overview"]) {
    requireElement<HTMLElement>(`view-${id}`).hidden = id !== view;
  }
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
  // Runtimes and weights arrive from a terminal, not from here, so the list is
  // re-read each time the page is opened rather than trusted from startup.
  if (page === "models") void renderModels();
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
  element.transformToggle.checked = next.transformOnDictate;
  element.transformPrompt.value = next.transformPrompt;
  element.polishPrompt.value = next.polishPrompt;
  element.polishShortcut.value = next.polishShortcut;
  renderThemeToggle(next.theme);

  const model = getSpeechModel(next.modelId);
  element.overviewModel.textContent = model.label;


  renderHotkeyLabels();
  renderHotkeyStatus();
  renderDictationDeck();
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

/** Browser media APIs own device enumeration; Rust receives this list for tray controls. */
async function refreshMicrophones(requestLabels = false): Promise<void> {
  try {
    if (requestLabels) {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
    }
    const devices = await navigator.mediaDevices.enumerateDevices();
    microphones = microphoneDevices(devices);
    renderMicrophoneSelect();
    await host().setAvailableMicrophones(microphones);
  } catch {
    // Device enumeration is unavailable until WebKit can access media devices.
    // The system-default option remains usable and capture will request access.
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
  // Never overwrite an edit in progress: reopening settings used to discard a
  // key that had been typed but not yet saved.
  if (element.keyInput.dataset.pristine !== "false") {
    element.keyInput.value = status.hasApiKey ? KEY_MASK : "";
    element.keyInput.dataset.pristine = "true";
  }
  element.keyState.classList.toggle("key-saved", status.hasApiKey && !status.memoryOnly);

  if (!status.hasApiKey) {
    element.keyState.textContent =
      "Stored in your login keychain, never in plain text.";
  } else if (status.memoryOnly) {
    element.keyState.textContent =
      "Saved for this session only: the keychain was unavailable.";
  } else {
    element.keyState.textContent = "Saved to your login keychain.";
  }

  element.keyRemove.hidden = !status.hasApiKey;
  syncKeyButtons();

  element.transformToggle.disabled = !status.hasApiKey;
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

/**
 * The steps that have to be complete before dictation works end to end.
 *
 * Ordered the way a person hits them: hear you, understand you, notice the
 * shortcut, type the result.
 */
function setupSteps(): { id: string; done: boolean; label: string }[] {
  const status = hotkeyStatus;
  return [
    {
      id: "microphone",
      done: status?.microphone === "granted",
      label: "microphone access",
    },
    {
      id: "input-monitoring",
      done: status?.inputMonitoring === true,
      label: "Input Monitoring",
    },
    {
      id: "accessibility",
      done: status?.accessibility === true,
      label: "Accessibility",
    },
  ];
}

function renderSetup(): void {
  const steps = setupSteps();
  const outstanding = steps.filter((step) => !step.done);

  for (const step of steps) {
    const row = element.checklist.querySelector<HTMLElement>(`[data-check="${step.id}"]`);
    if (!row) continue;
    row.dataset.done = String(step.done);
    const button = row.querySelector("button");
    if (button) {
      // A granted step already carries its tick. A button reading "Done" says
      // the same thing a second time, and looks like something to press.
      button.hidden = step.done;
      if (!step.done) button.textContent = "Grant";
    }
  }

  element.setupBadge.hidden = outstanding.length === 0;
  element.setupLede.textContent =
    outstanding.length === 0
      ? "Everything is in place. Hold your shortcut anywhere and speak."
      : "Enable the macOS permissions Waveform needs to dictate in any app.";

  // The banner names what is missing rather than saying "setup incomplete",
  // so the next action is obvious without opening anything.
  renderEmptyState();
  // Dictation deck is the single source of next action. Repeating the same
  // warning below it pushed actual history out of the window.
  element.setupBanner.hidden = true;
  if (outstanding.length > 0) {
    element.bannerTitle.textContent =
      outstanding.length === 1 ? "One thing left" : `${outstanding.length} things left`;
    element.bannerDetail.textContent = `Waveform still needs ${listPhrase(
      outstanding.map((step) => step.label),
    )}.`;
  }
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
 * A model that cannot run is still listed rather than hidden: the point of the
 * page is to say what is available, and what it would take to have it.
 *
 * Sixteen of them is too many to read at once, though, so all but a handful
 * start folded away. What stays out is what someone would actually act on: the
 * one recommended for this Mac, the one in use, and anything already
 * downloaded. `Show every size` brings out the rest.
 */
async function renderModels(): Promise<void> {
  const catalog = await host().getModelCatalog().catch(() => []);
  // What is folded away is the long tail of Whisper weight files, which is
  // exactly the set the app can fetch itself. A model it cannot fetch is one of
  // a small handful, and each is a different engine rather than another size of
  // the same one, so those always show.
  const featured = (model: ModelStatus): boolean =>
    model.recommended ||
    model.selected ||
    model.weightsInstalled ||
    model.downloadBytes === null;
  const hidden = catalog.filter((model) => !featured(model)).length;

  // Group headings come from the catalogue in its own order, so the interface
  // does not hold a second opinion about which groups exist.
  const groups = catalog.reduce<{ heading: string; models: ModelStatus[] }[]>((all, model) => {
    const group = all.find((candidate) => candidate.heading === model.group);
    if (group) group.models.push(model);
    else all.push({ heading: model.group, models: [model] });
    return all;
  }, []);

  const sections: HTMLElement[] = groups.flatMap(({ heading, models }) => {
    const shown = models.filter((model) => showEveryModel || featured(model));
    if (shown.length === 0) return [];

    const title = document.createElement("h2");
    title.className = "model-group";
    title.textContent = heading;

    const rows = document.createElement("div");
    rows.className = "model-list";
    // One radio group per heading: arrow keys then move within a group rather
    // than sweeping through fourteen Whisper sizes to reach Parakeet.
    rows.setAttribute("role", "radiogroup");
    rows.setAttribute("aria-label", heading);
    rows.append(...shown.map(modelRow));
    return [title, rows];
  });

  if (hidden > 0) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "model-more";
    more.dataset.showAll = String(!showEveryModel);
    more.textContent = showEveryModel
      ? "Show fewer"
      : `Show every size and quantization (${hidden} more)`;
    sections.push(more);
  }

  element.modelList.replaceChildren(...sections);
}

/** One model: what it is, what it needs, and what it would take to have it. */
function modelRow(model: ModelStatus): HTMLButtonElement {
  const ready = model.runtimeInstalled && model.weightsInstalled;
  const fetchable = !ready && model.downloadBytes !== null;
  const row = document.createElement("button");
  row.type = "button";
  row.className = "model-row";
  row.dataset.model = model.id;
  row.setAttribute("role", "radio");
  row.setAttribute("aria-checked", String(model.selected));
  if (fetchable) row.dataset.download = "true";
  // Disabled only when there is nothing the button could do. A model the
  // app can fetch is not disabled: pressing it is how the weights arrive.
  if (!ready && !fetchable) row.setAttribute("aria-disabled", "true");

  const name = document.createElement("strong");
  name.textContent = model.label;

  // What it is, before what state it is in: someone reading this list is
  // choosing between models, not auditing an installation.
  const detail = document.createElement("small");
  detail.className = "model-detail";
  detail.textContent = model.detail;

  const state = document.createElement("small");
  state.textContent = [
    ready
      ? "Downloaded"
      : fetchable
        ? `${formatBytes(model.downloadBytes ?? 0)} to download — no setup needed`
        : !model.runtimeInstalled
          ? `Not installed — run ${model.setupCommand}`
          : `Runtime ready, weights missing — run ${model.setupCommand}`,
    `about ${formatMemory(model.memoryMb)} of memory while loaded`,
    fitPhrase(model.fit),
  ]
    .filter((part) => part !== "")
    .join(" · ");

  const body = document.createElement("span");
  body.className = "model-body";
  body.append(name, detail, state);

  const tag = document.createElement("span");
  tag.className = "model-tag";
  tag.dataset.ready = String(ready);
  // The recommendation is the more useful thing to say about a row that is
  // neither in use nor downloaded, which is what every row starts as.
  tag.textContent = model.selected
    ? ready
      ? "In use"
      : "Selected"
    : model.recommended
      ? "Recommended"
      : ready
        ? "Ready"
        : fetchable
          ? "Download"
          : "Available";
  if (model.recommended && !model.selected) tag.dataset.recommended = "true";

  row.append(body, tag);
  return row;
}

/**
 * What a model's memory means on this Mac.
 *
 * Comfortable is left unsaid: it is the ordinary case, and a list where every
 * row carries a verdict is a list where none of them stand out.
 */
function fitPhrase(fit: ModelFit | null): string {
  if (fit === "tight") return "tight on this Mac";
  if (fit === "too-large") return "more memory than this Mac has to spare";
  return "";
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
  try {
    await host().downloadModel(id);
  } catch {
    // The failure already arrived as an error event, which is what says why.
  } finally {
    downloading = null;
    await renderModels();
  }
}

/**
 * Writes progress into the row itself rather than rebuilding the list.
 *
 * A rebuild four times a second would ask the host for the whole catalogue
 * each time, and replace the button under the pointer that started it.
 */
function showDownloadProgress(event: ModelEvent): void {
  const row = element.modelList.querySelector<HTMLElement>(
    `[data-model="${event.modelId}"]`,
  );
  if (!row) return;
  const state = row.querySelector("small");
  if (state) state.textContent = event.message;
  const tag = row.querySelector<HTMLElement>(".model-tag");
  if (tag) {
    tag.textContent = `${Math.round((event.progress ?? 0) * 100)}%`;
  }
}

/**
 * Asks whether there is a newer version, and says so either way.
 *
 * A check with no visible outcome reads as broken, which is why "up to date" is
 * a result rather than silence.
 */
async function checkForUpdate(): Promise<void> {
  element.updateCheck.disabled = true;
  try {
    const update = await host().checkForUpdate();
    element.updateInstall.hidden = update === null;
    // The event carried the message already; this only has to leave the button
    // in a state that matches it.
  } catch {
    // Reported as an error event, which is what says why.
  } finally {
    element.updateCheck.disabled = false;
  }
}

/**
 * Installs the newer version. Does not return: the app relaunches into it.
 */
async function installUpdate(): Promise<void> {
  element.updateInstall.disabled = true;
  element.updateCheck.disabled = true;
  try {
    await host().installUpdate();
  } catch {
    element.updateInstall.disabled = false;
    element.updateCheck.disabled = false;
  }
}

/** Every stage of an update lands in the one line under Version. */
function handleUpdateEvent(event: UpdateEvent): void {
  element.updateState.textContent =
    event.stage === "downloading" && event.progress !== undefined
      ? `${event.message} ${Math.round(event.progress * 100)}%`
      : event.message;
  if (event.stage === "available") element.updateInstall.hidden = false;
  if (event.stage === "current" || event.stage === "error") {
    element.updateInstall.hidden = true;
  }
}

function formatBytes(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
}

function renderLanguageSelect(): void {
  if (element.speechLanguage.options.length === 0) {
    element.speechLanguage.append(
      ...SPEECH_LANGUAGES.map(({ code, label }) => new Option(label, code)),
    );
  }
  element.speechLanguage.value = settings.speechLanguage;
}

/** Joins labels the way a sentence would: "a, b and c". */
function listPhrase(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function resolveSetupStep(id: string): void {
  if (id === "microphone") {
    void host().openPrivacySettings("microphone");
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

  if (outstanding.length > 0) {
    element.emptyHeadline.textContent = "Almost ready.";
    element.emptyHint.textContent =
      "Finish the steps above and your words will appear here, and wherever your cursor is.";
    element.starter.hidden = true;
    return;
  }

  element.starter.hidden = !firstRun;
  element.starterKey.textContent = glyph;

  if (firstRun) {
    element.emptyHeadline.textContent = "Try it now.";
    element.emptyHint.textContent = "Speak once and Waveform will type it for you.";
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

  element.deckKey.textContent = key;
  if (outstanding.length > 0) {
    element.deckStatus.textContent = "Setup needed";
    element.deckTitle.textContent = "Finish setup, then dictate anywhere";
    element.deckDescription.textContent = `Waveform still needs ${listPhrase(
      outstanding.map((step) => step.label),
    )}.`;
    element.deckSettings.textContent = "Finish setup";
    return;
  }

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
  if (status.state === "error" && status.message) setStatus(status.message);
  else if (modelReady) setStatus(`${getSpeechModel(settings.modelId).label} ready`);
}

/** The shortcut is the way in, so the sidebar says which one to hold. */
function renderShortcutCard(): void {
  const hint = element.shortcutHint;
  hint.replaceChildren();

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

  element.history.replaceChildren(element.dictationDeck);
  element.history.classList.toggle("is-empty", matches.length === 0);

  if (matches.length === 0 && query !== "") {
    const note = document.createElement("p");
    note.className = "no-matches";
    note.textContent = `Nothing matches \u201c${query}\u201d.`;
    element.history.append(note);
  } else if (matches.length === 0) {
    element.emptyState.hidden = false;
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
  settingsOpen = open;
  element.settingsPanel.hidden = !open;
  element.scrim.hidden = !open;
  if (!open) return;
  showSettingsPage(page);
  void host().getHotkeyStatus().then((status) => {
    hotkeyStatus = status;
    renderHotkeyStatus();
  });
  void host().getAiStatus().then(renderAiStatus);
}

function setStatus(message: string): void {
  element.overviewModelState.textContent = message;
}

function requireElement<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
}
