import type {
  DictationUpdate,
  HotkeyStatus,
  ModelEvent,
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
  status: requireElement<HTMLElement>("status"),
  statusText: requireElement<HTMLElement>("status-text"),
  transcript: requireElement<HTMLElement>("transcript"),
  emptyState: requireElement<HTMLElement>("empty-state"),
  actionButton: requireElement<HTMLButtonElement>("action-button"),
  actionLabel: requireElement<HTMLElement>("action-label"),
  copyButton: requireElement<HTMLButtonElement>("copy-button"),
  clearButton: requireElement<HTMLButtonElement>("clear-button"),
  settingsButton: requireElement<HTMLButtonElement>("settings-button"),
  settingsClose: requireElement<HTMLButtonElement>("settings-close"),
  previewButton: requireElement<HTMLButtonElement>("preview-button"),
  resetPositionButton: requireElement<HTMLButtonElement>("reset-position-button"),
  footerResources: requireElement<HTMLElement>("footer-resources"),
  settingsPanel: requireElement<HTMLElement>("settings-panel"),
  scrim: requireElement<HTMLElement>("scrim"),
  modelSelect: requireElement<HTMLSelectElement>("model-select"),
  hotkeySelect: requireElement<HTMLSelectElement>("hotkey-select"),
  insertToggle: requireElement<HTMLInputElement>("insert-toggle"),
  themeToggle: requireElement<HTMLElement>("theme-toggle"),
  footerModel: requireElement<HTMLElement>("footer-model"),
  footerHotkey: requireElement<HTMLElement>("footer-hotkey"),
  hintKey: requireElement<HTMLElement>("hint-key"),
  gestureKeyHold: requireElement<HTMLElement>("gesture-key-hold"),
  gestureKeyTap: requireElement<HTMLElement>("gesture-key-tap"),
  fnNote: requireElement<HTMLElement>("fn-note"),
  accessibilityRow: requireElement<HTMLElement>("permission-accessibility"),
  inputMonitoringRow: requireElement<HTMLElement>("permission-input-monitoring"),
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

  settings = await window.waveform.getSettings();
  applySettings(settings);

  hotkeyStatus = await window.waveform.getHotkeyStatus();
  renderHotkeyStatus();
}

function wireEvents(): void {
  window.waveform.onModelEvent(handleModelEvent);
  window.waveform.onSettingsChanged((next) => applySettings(next));
  window.waveform.onHotkeyStatusChanged((next) => {
    hotkeyStatus = next;
    renderHotkeyStatus();
  });
  window.waveform.onDictationUpdate(handleDictationUpdate);
  window.waveform.onResourceUsage(renderResourceUsage);

  element.actionButton.addEventListener("click", () => {
    if (element.actionButton.disabled) return;
    void window.waveform.toggleDictation();
  });

  element.clearButton.addEventListener("click", clearTranscript);
  element.copyButton.addEventListener("click", copyTranscript);

  element.settingsButton.addEventListener("click", () => toggleSettings(!settingsOpen));
  element.scrim.addEventListener("click", () => toggleSettings(false));
  element.settingsClose.addEventListener("click", () => toggleSettings(false));
  element.previewButton.addEventListener("click", () => {
    void window.waveform.previewIndicator();
  });
  element.resetPositionButton.addEventListener("click", () => {
    void patchSettings({ overlayX: null, overlayY: null });
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && settingsOpen) toggleSettings(false);
  });

  element.modelSelect.addEventListener("change", () => {
    if (!isSpeechModelId(element.modelSelect.value)) return;
    void window.waveform.selectModel(element.modelSelect.value);
  });

  element.hotkeySelect.addEventListener("change", () => {
    const value = element.hotkeySelect.value;
    if (!isHotkeyBindingId(value)) return;
    void patchSettings({ hotkeyId: value });
  });

  element.insertToggle.addEventListener("change", () => {
    void patchSettings({ insertIntoFocusedApp: element.insertToggle.checked });
  });

  element.themeToggle.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>("[data-theme-value]");
    const theme = button?.dataset.themeValue;
    if (theme !== "system" && theme !== "light" && theme !== "dark") return;
    void patchSettings({ theme });
  });

  for (const button of Array.from(
    document.querySelectorAll<HTMLButtonElement>("[data-scope]"),
  )) {
    button.addEventListener("click", () => {
      const scope = button.dataset.scope;
      if (scope !== "accessibility" && scope !== "input-monitoring") return;
      if (isScopeGranted(scope)) return;
      void window.waveform.requestHotkeyPermission(scope);
      // The prompt only appears once per install; the pane is the reliable route.
      void window.waveform.openPrivacySettings(scope);
    });
  }
}

async function patchSettings(patch: Partial<AppSettings>): Promise<void> {
  settings = await window.waveform.updateSettings(patch);
  applySettings(settings);
}

function applySettings(next: AppSettings): void {
  settings = next;
  document.documentElement.dataset.theme = next.theme === "system" ? "" : next.theme;
  if (next.theme === "system") delete document.documentElement.dataset.theme;

  element.modelSelect.value = next.modelId;
  element.hotkeySelect.value = next.hotkeyId;
  element.insertToggle.checked = next.insertIntoFocusedApp;
  renderThemeToggle(next.theme);

  element.footerModel.textContent = getSpeechModel(next.modelId).label;

  renderHotkeyLabels();
  renderHotkeyStatus();
}

function renderResourceUsage(usage: {
  cpuPercent: number;
  memoryMb: number;
  engineMemoryMb: number | null;
}): void {
  const memory =
    usage.memoryMb >= 1024
      ? `${(usage.memoryMb / 1024).toFixed(1)} GB`
      : `${usage.memoryMb} MB`;
  element.footerResources.textContent = `${usage.cpuPercent}% CPU · ${memory}`;
  element.footerResources.title =
    usage.engineMemoryMb === null
      ? "Waveform only; the speech engine is not running"
      : `Speech engine using ${usage.engineMemoryMb} MB of that`;
}

function renderThemeToggle(theme: AppSettings["theme"]): void {
  for (const button of Array.from(
    element.themeToggle.querySelectorAll<HTMLElement>("[data-theme-value]"),
  )) {
    button.setAttribute("aria-checked", String(button.dataset.themeValue === theme));
  }
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

function renderHotkeyLabels(): void {
  const binding = getHotkeyBinding(settings.hotkeyId);
  const glyph = binding?.glyph ?? "—";
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
    status?.supported === true &&
    status.running &&
    status.inputMonitoring &&
    binding !== null;

  element.footerHotkey.dataset.armed = String(armed);
  element.footerHotkey.textContent = describeHotkey(status, binding?.label ?? null);
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
  row.dataset.granted = String(granted);
  const button = row.querySelector("button");
  if (button) button.textContent = granted ? "Granted" : "Grant";
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

  if (status.state === "error" && status.message) {
    setStatus(status.message, "error");
  } else if (status.state === "listening") {
    setStatus("Listening — pause to transcribe", "ready");
  } else if (status.state === "transcribing") {
    setStatus("Transcribing locally…", "transcribing");
  } else if (modelReady) {
    setStatus(`${getSpeechModel(settings.modelId).shortLabel} ready`, "ready");
  }

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
  if (!listening) resetMeter();
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
  element.settingsButton.setAttribute("aria-expanded", String(open));
  if (open) {
    void window.waveform.getHotkeyStatus().then((status) => {
      hotkeyStatus = status;
      renderHotkeyStatus();
    });
  }
}

function setStatus(message: string, stage: UiStage): void {
  element.statusText.textContent = message;
  element.status.dataset.stage = stage;
}

function resetMeter(): void {
  for (const bar of element.meterBars) bar.style.height = "";
}

function requireElement<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
}

