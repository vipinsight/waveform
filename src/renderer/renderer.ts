import type {
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
import { DEFAULT_SETTINGS, type AppSettings } from "../shared/settings";

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
  previewButton: requireElement<HTMLButtonElement>("preview-button"),
  resetPositionButton: requireElement<HTMLButtonElement>("reset-position-button"),
  hintKey: requireElement<HTMLElement>("hint-key"),
  gestureKeyHold: requireElement<HTMLElement>("gesture-key-hold"),
  gestureKeyTap: requireElement<HTMLElement>("gesture-key-tap"),
  fnNote: requireElement<HTMLElement>("fn-note"),
  accessibilityRow: requireElement<HTMLElement>("permission-accessibility"),
  inputMonitoringRow: requireElement<HTMLElement>("permission-input-monitoring"),
  statWords: requireElement<HTMLElement>("stat-words"),
  statPhrases: requireElement<HTMLElement>("stat-phrases"),
  statSessions: requireElement<HTMLElement>("stat-sessions"),
  activityModel: requireElement<HTMLElement>("activity-model"),
  activityModelState: requireElement<HTMLElement>("activity-model-state"),
  activityCpu: requireElement<HTMLElement>("activity-cpu"),
  activityMemory: requireElement<HTMLElement>("activity-memory"),
  activityEngineMemory: requireElement<HTMLElement>("activity-engine-memory"),
  meterBars: Array.from(document.querySelectorAll<HTMLElement>(".meter-bar")),
};

let settings: AppSettings = DEFAULT_SETTINGS;
let hotkeyStatus: HotkeyStatus | null = null;
let modelReady = false;
let modelLoading = true;
let listening = false;
let settingsOpen = false;
let phraseCount = 0;

void bootstrap();

async function bootstrap(): Promise<void> {
  populateSelects();
  wireEvents();

  applySettings(await window.waveform.getSettings());
  renderStats(await window.waveform.getStats());
  // Pull the engine's current stage: any event it pushed while this window was
  // still loading is already gone.
  handleModelEvent(await window.waveform.getModelState());

  hotkeyStatus = await window.waveform.getHotkeyStatus();
  renderHotkeyStatus();
}

function wireEvents(): void {
  window.waveform.onModelEvent(handleModelEvent);
  window.waveform.onSettingsChanged(applySettings);
  window.waveform.onHotkeyStatusChanged((next) => {
    hotkeyStatus = next;
    renderHotkeyStatus();
  });
  window.waveform.onDictationUpdate(handleDictationUpdate);
  window.waveform.onResourceUsage(renderResourceUsage);
  window.waveform.onStatsChanged(renderStats);

  bindGroup(".nav[aria-label='Sections'] [data-view]", (button) =>
    showView(button.dataset.view ?? "dictate"),
  );
  bindGroup(".modal-nav [data-page]", (button) =>
    showSettingsPage(button.dataset.page ?? "general"),
  );

  element.actionButton.addEventListener("click", () => {
    if (element.actionButton.disabled) return;
    void window.waveform.toggleDictation();
  });
  element.clearButton.addEventListener("click", clearTranscript);
  element.copyButton.addEventListener("click", copyTranscript);

  element.settingsButton.addEventListener("click", () => toggleSettings(!settingsOpen));
  element.scrim.addEventListener("click", () => toggleSettings(false));
  element.settingsClose.addEventListener("click", () => toggleSettings(false));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && settingsOpen) toggleSettings(false);
  });

  element.modelSelect.addEventListener("change", () => {
    if (!isSpeechModelId(element.modelSelect.value)) return;
    void window.waveform.selectModel(element.modelSelect.value);
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
  element.previewButton.addEventListener("click", () => {
    void window.waveform.previewIndicator();
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
      void window.waveform.requestHotkeyPermission(scope);
      // The system prompt only appears once per install; the pane always works.
      void window.waveform.openPrivacySettings(scope);
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
  applySettings(await window.waveform.updateSettings(patch));
}

function applySettings(next: AppSettings): void {
  settings = next;
  if (next.theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = next.theme;

  element.modelSelect.value = next.modelId;
  element.hotkeySelect.value = next.hotkeyId;
  element.insertToggle.checked = next.insertIntoFocusedApp;
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
}

function describeHotkey(status: HotkeyStatus | null, label: string | null): string {
  if (status?.supported === false) return "Shortcut unavailable on this build";
  if (!label) return "Shortcut off";
  if (status?.inputMonitoring === false) return `${label} — needs Input Monitoring`;
  if (status?.running === false) return `${label} — helper not running`;
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
  } else {
    modelLoading = true;
  }

  setStatus(event.message, event.stage);
  renderActionState();
}

function handleDictationUpdate(update: DictationUpdate): void {
  const { status, phrase } = update;
  listening = status.state === "listening" || status.state === "transcribing";

  if (phrase) appendPhrase(phrase.text);

  if (status.state === "error" && status.message) setStatus(status.message, "error");
  else if (status.state === "listening") setStatus("Listening", "ready");
  else if (status.state === "transcribing") setStatus("Transcribing…", "transcribing");
  else if (modelReady) setStatus(`${getSpeechModel(settings.modelId).shortLabel} ready`, "ready");

  renderActionState();
}

function renderActionState(): void {
  const disabled = modelLoading && !listening;
  element.actionButton.disabled = disabled;
  element.actionButton.classList.toggle("is-busy", disabled);
  element.actionButton.classList.toggle("is-listening", listening);
  element.actionButton.setAttribute("aria-pressed", String(listening));
  element.actionLabel.textContent = listening
    ? "Stop listening"
    : modelLoading
      ? "Loading model"
      : modelReady
        ? "Start listening"
        : "Load model & start";

  element.copyButton.disabled = phraseCount === 0;
  element.clearButton.disabled = phraseCount === 0;
  if (!listening) for (const bar of element.meterBars) bar.style.height = "";
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
  void window.waveform.getHotkeyStatus().then((status) => {
    hotkeyStatus = status;
    renderHotkeyStatus();
  });
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
