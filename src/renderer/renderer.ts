import type {
  AiStatus,
  AppStats,
  SavedDictation,
  DictationUpdate,
  HotkeyStatus,
  ModelEvent,
  ResourceUsage,
  UiStage,
} from "../shared/contracts";
import {
  HOTKEY_BINDINGS,
  getHotkeyBinding,
  isHotkeyBindingId,
} from "../shared/hotkeys";
import { SPEECH_MODELS, getSpeechModel, isSpeechModelId } from "../shared/models";
import { DEFAULT_SETTINGS, POLISH_SHORTCUTS, type AppSettings } from "../shared/settings";
import {
  DEFAULT_POLISH_PROMPT,
  DEFAULT_TRANSFORM_PROMPT,
  SUGGESTED_MODELS,
} from "../shared/prompts";
import { host } from "./host";
import { installTauriBridge } from "./tauri-bridge";

const element = {
  statusText: requireElement<HTMLElement>("status-text"),
  modelDot: requireElement<HTMLElement>("model-dot"),
  hotkeyDot: requireElement<HTMLElement>("hotkey-dot"),
  hotkeySummary: requireElement<HTMLElement>("hotkey-summary"),
  resourceSummary: requireElement<HTMLElement>("resource-summary"),
  resourceRow: requireElement<HTMLElement>("resource-row"),
  history: requireElement<HTMLElement>("history"),
  emptyState: requireElement<HTMLElement>("empty-state"),
  dictateNote: requireElement<HTMLElement>("dictate-note"),
  shortcutHint: requireElement<HTMLElement>("shortcut-hint"),
  search: requireElement<HTMLElement>("search"),
  searchButton: requireElement<HTMLButtonElement>("search-button"),
  searchField: requireElement<HTMLInputElement>("search-field"),
  settingsButton: requireElement<HTMLButtonElement>("settings-button"),
  settingsPanel: requireElement<HTMLElement>("settings-panel"),
  settingsClose: requireElement<HTMLButtonElement>("settings-close"),
  scrim: requireElement<HTMLElement>("scrim"),
  versionLine: requireElement<HTMLElement>("version-line"),
  modelSelect: requireElement<HTMLSelectElement>("model-select"),
  modelNote: requireElement<HTMLElement>("model-note"),
  hotkeySelect: requireElement<HTMLSelectElement>("hotkey-select"),
  insertToggle: requireElement<HTMLInputElement>("insert-toggle"),
  themeToggle: requireElement<HTMLElement>("theme-toggle"),
  menubarToggle: requireElement<HTMLInputElement>("menubar-toggle"),
  dockToggle: requireElement<HTMLInputElement>("dock-toggle"),
  dockNote: requireElement<HTMLElement>("dock-note"),
  previewButton: requireElement<HTMLButtonElement>("preview-button"),
  resetPositionButton: requireElement<HTMLButtonElement>("reset-position-button"),
  hintKey: requireElement<HTMLElement>("hint-key"),
  emptyHeadline: requireElement<HTMLElement>("empty-headline"),
  emptyHint: requireElement<HTMLElement>("empty-hint"),
  starter: requireElement<HTMLElement>("starter"),
  starterKey: document.querySelector<HTMLElement>(".starter-key")!,
  gestureKeyHold: requireElement<HTMLElement>("gesture-key-hold"),
  gestureKeyTap: requireElement<HTMLElement>("gesture-key-tap"),
  fnNote: requireElement<HTMLElement>("fn-note"),
  setupBanner: requireElement<HTMLElement>("setup-banner"),
  bannerTitle: requireElement<HTMLElement>("banner-title"),
  bannerDetail: requireElement<HTMLElement>("banner-detail"),
  bannerAction: requireElement<HTMLButtonElement>("banner-action"),
  setupBadge: requireElement<HTMLElement>("setup-badge"),
  setupLede: requireElement<HTMLElement>("setup-lede"),
  checkEngineNote: requireElement<HTMLElement>("check-engine-note"),
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
  keyState: requireElement<HTMLElement>("key-state"),
  aiModel: requireElement<HTMLInputElement>("ai-model"),
  modelSuggestions: requireElement<HTMLElement>("model-suggestions"),
  transformToggle: requireElement<HTMLInputElement>("transform-toggle"),
  transformPrompt: requireElement<HTMLTextAreaElement>("transform-prompt"),
  polishPrompt: requireElement<HTMLTextAreaElement>("polish-prompt"),
  polishShortcut: requireElement<HTMLSelectElement>("polish-shortcut"),
  polishNow: requireElement<HTMLButtonElement>("polish-now"),
};

let settings: AppSettings = DEFAULT_SETTINGS;
let hotkeyStatus: HotkeyStatus | null = null;
let modelReady = false;
let modelLoading = false;
let settingsOpen = false;
let entries: SavedDictation[] = [];
let freshId: string | null = null;
let lifetimeSessions = 0;
let searchOpen = false;
let query = "";

// Supplies window.waveform under Tauri; a no-op under Electron.
installTauriBridge();

void bootstrap();

async function bootstrap(): Promise<void> {
  populateSelects();
  wireEvents();

  applySettings(await host().getSettings());
  renderStats(await host().getStats());
  entries = await host().getHistory();
  renderHistory();
  // Falls back to the bare name: a version that failed to load should not be
  // rendered as "Waveform null".
  const version = await host().getAppVersion().catch(() => "");
  element.versionLine.textContent = version ? `Waveform ${version}` : "Waveform";
  // Pull the engine's current stage: any event it pushed while this window was
  // still loading is already gone.
  handleModelEvent(await host().getModelState());

  hotkeyStatus = await host().getHotkeyStatus();
  renderHotkeyStatus();
  renderAiStatus(await host().getAiStatus());
}

function wireEvents(): void {
  host().onModelEvent(handleModelEvent);
  host().onSettingsChanged(applySettings);
  host().onHotkeyStatusChanged((next) => {
    hotkeyStatus = next;
    renderHotkeyStatus();
  });
  host().onDictationUpdate(handleDictationUpdate);
  host().onResourceUsage(renderResourceUsage);
  host().onOpenSettings(() => toggleSettings(true));
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
  element.scrim.addEventListener("click", () => toggleSettings(false));
  element.settingsClose.addEventListener("click", () => toggleSettings(false));
  element.bannerAction.addEventListener("click", () => {
    toggleSettings(true);
    showSettingsPage("setup");
  });

  for (const button of Array.from(
    document.querySelectorAll<HTMLButtonElement>("[data-fix]"),
  )) {
    button.addEventListener("click", () => resolveSetupStep(button.dataset.fix ?? ""));
  }
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && settingsOpen) toggleSettings(false);
  });

  element.modelSelect.addEventListener("change", () => {
    if (!isSpeechModelId(element.modelSelect.value)) return;
    void host().selectModel(element.modelSelect.value);
  });
  element.hotkeySelect.addEventListener("change", () => {
    const value = element.hotkeySelect.value;
    if (isHotkeyBindingId(value)) void patchSettings({ hotkeyId: value });
  });
  element.insertToggle.addEventListener("change", () => {
    void patchSettings({ insertIntoFocusedApp: element.insertToggle.checked });
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
  });
  // Save is the only way the key changes. Typing edits the field and nothing
  // more, so a half-pasted key cannot be committed by a stray keystroke.
  element.keySave.addEventListener("click", saveApiKey);
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
  element.polishNow.addEventListener("click", () => {
    void host().polishSelection();
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
  element.dockToggle.addEventListener("change", () => {
    void patchSettings({ hideDockWhenClosed: element.dockToggle.checked });
  });
  element.previewButton.addEventListener("click", () => {
    void host().previewIndicator();
  });
  element.resetPositionButton.addEventListener("click", () => {
    void patchSettings({ overlayX: null, overlayY: null });
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
}

async function patchSettings(patch: Partial<AppSettings>): Promise<void> {
  applySettings(await host().updateSettings(patch));
}

function applySettings(next: AppSettings): void {
  settings = next;
  if (next.theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = next.theme;

  element.modelSelect.value = next.modelId;
  element.hotkeySelect.value = next.hotkeyId;
  element.insertToggle.checked = next.insertIntoFocusedApp;
  element.menubarToggle.checked = next.menuBarIcon;
  element.dockToggle.checked = next.hideDockWhenClosed;
  // Without a menu bar icon there would be no way back to the window.
  element.dockToggle.disabled = !next.menuBarIcon;
  element.dockNote.textContent = next.menuBarIcon
    ? "Runs from the menu bar alone. Closing the window never quits Waveform."
    : "Needs the menu bar icon, so there is a way back to the window.";
  element.aiModel.value = next.openRouterModel;
  element.transformToggle.checked = next.transformOnDictate;
  element.transformPrompt.value = next.transformPrompt;
  element.polishPrompt.value = next.polishPrompt;
  element.polishShortcut.value = next.polishShortcut;
  renderThemeToggle(next.theme);

  const model = getSpeechModel(next.modelId);
  element.modelNote.textContent = `${model.modelId} · runs on this Mac`;
  element.overviewModel.textContent = model.label;


  renderHotkeyLabels();
  renderHotkeyStatus();
}

function populateSelects(): void {
  for (const model of SPEECH_MODELS) {
    element.modelSelect.append(new Option(model.shortLabel, model.id));
  }
  element.hotkeySelect.append(new Option("Off", "none"));
  for (const binding of HOTKEY_BINDINGS) {
    element.hotkeySelect.append(new Option(binding.label, binding.id));
  }

  for (const accelerator of POLISH_SHORTCUTS) {
    element.polishShortcut.append(
      new Option(describeAccelerator(accelerator), accelerator),
    );
  }
  for (const model of SUGGESTED_MODELS) {
    element.modelSuggestions.append(new Option(model, model));
  }
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
    element.keyState.textContent =
      "Saved to your login keychain. Clear the field and save to remove it.";
  }

  element.polishNow.disabled = !status.hasApiKey;
  element.transformToggle.disabled = !status.hasApiKey;
}

/** Saves, replaces or removes the key depending on what the field holds. */
function saveApiKey(): void {
  if (element.keyInput.dataset.pristine === "true") return;

  const value = element.keyInput.value.trim();
  const request = value ? host().setOpenRouterKey(value) : host().clearOpenRouterKey();

  void request.then((status) => {
    renderAiStatus(status);
    flash(element.keySave, value ? "Saved" : "Removed");
  });
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
  const glyph = getHotkeyBinding(settings.hotkeyId)?.glyph ?? "—";
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
      id: "engine",
      done: status?.engineInstalled === true,
      label: "the speech model",
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
      button.textContent = step.done
        ? "Done"
        : step.id === "engine"
          ? "Copy command"
          : "Grant";
    }
  }

  element.setupBadge.hidden = outstanding.length === 0;
  element.setupLede.textContent =
    outstanding.length === 0
      ? "Everything is in place. Hold your shortcut anywhere and speak."
      : "Three of these are permissions macOS has to grant. The fourth is the model that does the transcribing, which runs on this Mac.";

  const model = getSpeechModel(settings.modelId);
  const engineInstalled = hotkeyStatus?.engineInstalled === true;
  element.checkEngineNote.textContent = engineInstalled
    ? `${model.label} · runs offline on this Mac`
    : `${model.label} is not installed. Run ${engineSetupCommand()} in the project folder.`;

  // The banner names what is missing rather than saying "setup incomplete",
  // so the next action is obvious without opening anything.
  renderEmptyState();
  element.setupBanner.hidden = outstanding.length === 0;
  if (outstanding.length > 0) {
    element.bannerTitle.textContent =
      outstanding.length === 1 ? "One thing left" : `${outstanding.length} things left`;
    element.bannerDetail.textContent = `Waveform still needs ${listPhrase(
      outstanding.map((step) => step.label),
    )}.`;
  }
}

/** The command that installs the runtime for the selected model. */
function engineSetupCommand(): string {
  return getSpeechModel(settings.modelId).engine === "qwen"
    ? "pnpm setup:qwen"
    : "pnpm setup:model";
}

/** Joins labels the way a sentence would: "a, b and c". */
function listPhrase(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function resolveSetupStep(id: string): void {
  if (id === "engine") {
    // The app cannot install a runtime for itself, so the useful thing it can
    // do is hand over the exact command rather than send the user to a page
    // that does not explain anything.
    void navigator.clipboard.writeText(engineSetupCommand());
    const button = element.checklist.querySelector<HTMLButtonElement>('[data-fix="engine"]');
    if (button) flash(button, "Copied");
    return;
  }
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
  const status = hotkeyStatus;
  const binding = getHotkeyBinding(settings.hotkeyId);

  const armed =
    status?.supported === true && status.running && status.inputMonitoring && !!binding;
  element.hotkeyDot.dataset.armed = String(armed);

  // The sidebar states the binding; anything wrong with it is the banner's
  // job. Saying it in three places at once made the window look alarmed.
  element.hotkeySummary.textContent = binding
    ? `${binding.glyph} ${binding.label}`
    : "Shortcut off";
  // The sidebar card names the same binding, so it is rendered from here
  // rather than from anything that could describe a different one.
  renderShortcutCard();
  renderSetup();
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
  const glyph = getHotkeyBinding(settings.hotkeyId)?.glyph ?? "your shortcut";
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

function renderStats(stats: AppStats): void {
  lifetimeSessions = stats.sessions;
  element.statWords.textContent = stats.words.toLocaleString();
  element.statPhrases.textContent = stats.phrases.toLocaleString();
  element.statSessions.textContent = stats.sessions.toLocaleString();
  renderEmptyState();
}

function renderResourceUsage(usage: ResourceUsage): void {
  const memory = formatMemory(usage.memoryMb);
  element.resourceRow.hidden = false;
  element.resourceSummary.textContent = `${usage.cpuPercent}% CPU · ${memory}`;
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
  if (event.modelId !== settings.modelId) return;

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

  setStatus(event.message, event.stage);
}

function handleDictationUpdate(update: DictationUpdate): void {
  // The pill outside the app is the listening indicator, and it is the one you
  // can actually see while dictating into another window. Mirroring its state
  // in here gave two things to watch that could disagree, so the sidebar
  // carries only the engine: which model, ready or not, and anything that
  // went wrong.
  const { status } = update;
  if (status.state === "error" && status.message) setStatus(status.message, "error");
  else if (modelReady) setStatus(`${getSpeechModel(settings.modelId).shortLabel} ready`, "ready");
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
    key(binding.glyph),
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

  element.history.replaceChildren();
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
  button.innerHTML = `<svg viewBox="0 0 20 20" fill="none" aria-hidden="true">${path}</svg>`;
  button.addEventListener("click", () => {
    onClick();
    if (label === "Copy") {
      button.classList.add("is-done");
      setTimeout(() => button.classList.remove("is-done"), 900);
    }
  });
  return button;
}

const COPY_ICON =
  '<rect x="7" y="7" width="9.5" height="9.5" rx="2.2" stroke="currentColor" stroke-width="1.4"/>' +
  '<path d="M13 7V5.5A2.2 2.2 0 0 0 10.8 3.3H5.5A2.2 2.2 0 0 0 3.3 5.5v5.3A2.2 2.2 0 0 0 5.5 13H7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>';

const TRASH_ICON =
  '<path d="M4.6 6.2h10.8M8.2 6.2V4.9c0-.6.5-1.1 1.1-1.1h1.4c.6 0 1.1.5 1.1 1.1v1.3M6.1 6.2l.6 8.6c.05.7.6 1.2 1.3 1.2h4c.7 0 1.25-.5 1.3-1.2l.6-8.6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>';

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


function toggleSettings(open: boolean): void {
  settingsOpen = open;
  element.settingsPanel.hidden = !open;
  element.scrim.hidden = !open;
  if (!open) return;
  void host().getHotkeyStatus().then((status) => {
    hotkeyStatus = status;
    renderHotkeyStatus();
  });
  void host().getAiStatus().then(renderAiStatus);
}

function setStatus(message: string, stage: UiStage): void {
  element.statusText.textContent = message;
  element.modelDot.dataset.stage = stage;
  element.overviewModelState.textContent = message;
}

function requireElement<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
}
