import type {
  AiStatus,
  AppStats,
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
  transcript: requireElement<HTMLElement>("transcript"),
  emptyState: requireElement<HTMLElement>("empty-state"),
  dictateNote: requireElement<HTMLElement>("dictate-note"),
  actionButton: requireElement<HTMLButtonElement>("action-button"),
  actionLabel: requireElement<HTMLElement>("action-label"),
  copyButton: requireElement<HTMLButtonElement>("copy-button"),
  clearButton: requireElement<HTMLButtonElement>("clear-button"),
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
  gestureKeyHold: requireElement<HTMLElement>("gesture-key-hold"),
  gestureKeyTap: requireElement<HTMLElement>("gesture-key-tap"),
  fnNote: requireElement<HTMLElement>("fn-note"),
  accessibilityRow: requireElement<HTMLElement>("permission-accessibility"),
  setupBanner: requireElement<HTMLElement>("setup-banner"),
  bannerTitle: requireElement<HTMLElement>("banner-title"),
  bannerDetail: requireElement<HTMLElement>("banner-detail"),
  bannerAction: requireElement<HTMLButtonElement>("banner-action"),
  setupBadge: requireElement<HTMLElement>("setup-badge"),
  setupLede: requireElement<HTMLElement>("setup-lede"),
  checkEngineNote: requireElement<HTMLElement>("check-engine-note"),
  checklist: requireElement<HTMLElement>("checklist"),
  inputMonitoringRow: requireElement<HTMLElement>("permission-input-monitoring"),
  statWords: requireElement<HTMLElement>("stat-words"),
  statPhrases: requireElement<HTMLElement>("stat-phrases"),
  statSessions: requireElement<HTMLElement>("stat-sessions"),
  activityModel: requireElement<HTMLElement>("activity-model"),
  activityModelState: requireElement<HTMLElement>("activity-model-state"),
  activityCpu: requireElement<HTMLElement>("activity-cpu"),
  activityMemory: requireElement<HTMLElement>("activity-memory"),
  activityEngineMemory: requireElement<HTMLElement>("activity-engine-memory"),
  keyInput: requireElement<HTMLInputElement>("key-input"),
  keySave: requireElement<HTMLButtonElement>("key-save"),
  keyClear: requireElement<HTMLButtonElement>("key-clear"),
  keyState: requireElement<HTMLElement>("key-state"),
  aiModel: requireElement<HTMLInputElement>("ai-model"),
  modelSuggestions: requireElement<HTMLElement>("model-suggestions"),
  transformToggle: requireElement<HTMLInputElement>("transform-toggle"),
  transformPrompt: requireElement<HTMLTextAreaElement>("transform-prompt"),
  polishPrompt: requireElement<HTMLTextAreaElement>("polish-prompt"),
  polishShortcut: requireElement<HTMLSelectElement>("polish-shortcut"),
  polishNow: requireElement<HTMLButtonElement>("polish-now"),
  actionHint: requireElement<HTMLElement>("action-hint"),
};

let settings: AppSettings = DEFAULT_SETTINGS;
let hotkeyStatus: HotkeyStatus | null = null;
let modelReady = false;
let modelLoading = false;
let listening = false;
let settingsOpen = false;
let phraseCount = 0;
let listeningSince = 0;
let elapsedTimer: number | null = null;

// Supplies window.waveform under Tauri; a no-op under Electron.
installTauriBridge();

void bootstrap();

async function bootstrap(): Promise<void> {
  populateSelects();
  wireEvents();

  applySettings(await host().getSettings());
  renderStats(await host().getStats());
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

  bindGroup(".nav[aria-label='Sections'] [data-view]", (button) =>
    showView(button.dataset.view ?? "dictate"),
  );
  bindGroup(".modal-nav [data-page]", (button) =>
    showSettingsPage(button.dataset.page ?? "general"),
  );

  element.actionButton.addEventListener("click", () => {
    if (element.actionButton.disabled) return;
    void host().toggleDictation();
  });
  element.clearButton.addEventListener("click", clearTranscript);
  element.copyButton.addEventListener("click", copyTranscript);

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
  // The key is write-only from here: it is sent to main and never read back.
  element.keySave.addEventListener("click", () => {
    const key = element.keyInput.value;
    if (!key.trim()) return;
    void host().setOpenRouterKey(key).then((status) => {
      element.keyInput.value = "";
      renderAiStatus(status);
    });
  });
  element.keyClear.addEventListener("click", () => {
    void host().clearOpenRouterKey().then(renderAiStatus);
  });
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

  for (const button of Array.from(
    document.querySelectorAll<HTMLButtonElement>("[data-scope]"),
  )) {
    button.addEventListener("click", () => {
      const scope = button.dataset.scope;
      if (scope !== "accessibility" && scope !== "input-monitoring") return;
      if (isScopeGranted(scope)) return;
      void host().requestHotkeyPermission(scope);
      // The system prompt only appears once per install; the pane always works.
      void host().openPrivacySettings(scope);
    });
  }
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
  for (const id of ["dictate", "activity"]) {
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
  element.activityModel.textContent = model.label;
  element.versionLine.textContent = `Waveform · ${model.shortLabel}`;

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

function renderAiStatus(status: AiStatus): void {
  element.keyClear.hidden = !status.hasApiKey;
  element.keySave.textContent = status.hasApiKey ? "Replace" : "Save";
  element.keyInput.placeholder = status.hasApiKey ? "Saved" : "sk-or-v1-…";
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

  element.polishNow.disabled = !status.hasApiKey;
  element.transformToggle.disabled = !status.hasApiKey;
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
          ? "How"
          : "Grant";
    }
  }

  element.setupBadge.hidden = outstanding.length === 0;
  element.setupLede.textContent =
    outstanding.length === 0
      ? "Everything is in place. Hold your shortcut anywhere and speak."
      : "Waveform needs a few things from macOS before it can listen anywhere and type for you.";

  element.checkEngineNote.textContent = `${getSpeechModel(settings.modelId).label} · runs offline on this Mac`;

  // The banner names what is missing rather than saying "setup incomplete",
  // so the next action is obvious without opening anything.
  element.setupBanner.hidden = outstanding.length === 0;
  if (outstanding.length > 0) {
    element.bannerTitle.textContent =
      outstanding.length === 1 ? "One thing left" : `${outstanding.length} things left`;
    element.bannerDetail.textContent = `Waveform still needs ${listPhrase(
      outstanding.map((step) => step.label),
    )}.`;
  }
}

/** Joins labels the way a sentence would: "a, b and c". */
function listPhrase(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function resolveSetupStep(id: string): void {
  if (id === "engine") {
    showSettingsPage("general");
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

  setPermissionRow(element.accessibilityRow, status?.accessibility === true);
  setPermissionRow(element.inputMonitoringRow, status?.inputMonitoring === true);

  const armed =
    status?.supported === true && status.running && status.inputMonitoring && !!binding;
  element.hotkeyDot.dataset.armed = String(armed);

  const summary = describeHotkey(status, binding?.label ?? null);
  element.hotkeySummary.textContent = summary;
  element.dictateNote.textContent = armed ? summary : "";
  renderSetup();
}

function describeHotkey(status: HotkeyStatus | null, label: string | null): string {
  if (status?.supported === false) return "Shortcut unavailable on this build";
  if (!label) return "Shortcut off";
  if (status?.inputMonitoring === false) return `${label} — needs Input Monitoring`;
  if (status?.running === false) return `${label} — helper not running`;
  // Dictation works without this, but the text silently stays in the app,
  // which is the more confusing failure of the two.
  if (settings.insertIntoFocusedApp && status?.accessibility === false) {
    return `${label} — needs Accessibility to paste`;
  }
  return `Hold ${label} to dictate`;
}

function isScopeGranted(scope: "accessibility" | "input-monitoring"): boolean {
  if (!hotkeyStatus) return false;
  return scope === "accessibility"
    ? hotkeyStatus.accessibility
    : hotkeyStatus.inputMonitoring;
}

function setPermissionRow(row: HTMLElement, granted: boolean): void {
  const button = row.querySelector("button");
  if (!button) return;
  button.textContent = granted ? "Granted" : "Grant";
  button.classList.toggle("is-done", granted);
  button.classList.toggle("is-primary", !granted);
}

function renderStats(stats: AppStats): void {
  element.statWords.textContent = stats.words.toLocaleString();
  element.statPhrases.textContent = stats.phrases.toLocaleString();
  element.statSessions.textContent = stats.sessions.toLocaleString();
}

function renderResourceUsage(usage: ResourceUsage): void {
  const memory = formatMemory(usage.memoryMb);
  element.resourceSummary.textContent = `${usage.cpuPercent}% CPU · ${memory}`;
  element.activityCpu.textContent = `${usage.cpuPercent}%`;
  element.activityMemory.textContent = memory;
  element.activityEngineMemory.textContent =
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
  renderActionState();
}

function handleDictationUpdate(update: DictationUpdate): void {
  const { status, phrase } = update;
  const wasListening = listening;
  listening =
    status.state === "listening" ||
    status.state === "transcribing" ||
    status.state === "rewriting";
  if (listening && !wasListening) listeningSince = Date.now();
  syncElapsedTimer();

  if (phrase) appendPhrase(phrase.text);

  if (status.state === "error" && status.message) setStatus(status.message, "error");
  else if (status.state === "listening") setStatus("Listening", "ready");
  else if (status.state === "transcribing") setStatus("Transcribing…", "transcribing");
  else if (status.state === "rewriting") setStatus("Rewriting with AI…", "transcribing");
  else if (modelReady) setStatus(`${getSpeechModel(settings.modelId).shortLabel} ready`, "ready");

  renderActionState();
}

function renderActionState(): void {
  // Never disabled while the engine loads. Recording starts immediately and the
  // first phrase waits for the model, which beats a dead button that gives no
  // way to begin.
  element.actionButton.classList.toggle("is-listening", listening);
  element.actionButton.classList.toggle("is-warming", modelLoading && !listening);
  element.actionButton.setAttribute("aria-pressed", String(listening));
  element.actionLabel.textContent = listening ? "Stop listening" : "Start listening";

  if (listening) {
    const elapsed = formatElapsed(Date.now() - listeningSince);
    element.actionHint.textContent = modelLoading
      ? `${elapsed} · preparing the model…`
      : elapsed;
  } else if (modelLoading) {
    element.actionHint.textContent = "Preparing the model…";
  } else {
    element.actionHint.textContent = shortcutHint();
  }

  element.copyButton.disabled = phraseCount === 0;
  element.clearButton.disabled = phraseCount === 0;
}

/** Reminds the user the button is not the only way in. */
function shortcutHint(): string {
  const binding = getHotkeyBinding(settings.hotkeyId);
  if (!binding || hotkeyStatus?.supported === false) return "";
  return `or hold ${binding.label}`;
}

function formatElapsed(milliseconds: number): string {
  const total = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Ticks the elapsed readout only while a session is actually running. */
function syncElapsedTimer(): void {
  if (listening && elapsedTimer === null) {
    listeningSince = listeningSince || Date.now();
    elapsedTimer = window.setInterval(renderActionState, 1000);
    return;
  }
  if (!listening && elapsedTimer !== null) {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
    listeningSince = 0;
  }
}

function appendPhrase(text: string): void {
  element.emptyState.remove();
  const phrase = document.createElement("span");
  phrase.className = "phrase";
  phrase.textContent = `${text} `;
  element.transcript.append(phrase);
  element.transcript.scrollTop = element.transcript.scrollHeight;
  phraseCount += 1;
  renderActionState();
}

function clearTranscript(): void {
  element.transcript.replaceChildren(element.emptyState);
  element.emptyState.hidden = false;
  phraseCount = 0;
  renderActionState();
}

async function copyTranscript(): Promise<void> {
  const text = Array.from(element.transcript.querySelectorAll(".phrase"))
    .map((node) => node.textContent ?? "")
    .join("")
    .trim();
  if (!text) return;

  await navigator.clipboard.writeText(text);
  element.copyButton.textContent = "Copied";
  setTimeout(() => {
    element.copyButton.textContent = "Copy";
  }, 1_400);
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
  element.activityModelState.textContent = message;
}

function requireElement<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
}
