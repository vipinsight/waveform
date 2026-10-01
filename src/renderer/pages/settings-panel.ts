import type { MicrophoneDevice } from "../../shared/contracts";
import { microphoneDevices } from "../../shared/microphones";
import type { AppSettings } from "../../shared/settings";
import { host } from "../host";
import { bindGroup, requireElement } from "../ui/dom";
import { patchSettings, state } from "../state";
import { stopPlayback } from "./history";
import { loadLogs } from "./logs";
import { isPromptEditorOpen, renderAiStatus, togglePromptEditor } from "./polish";
import { renderHotkeyStatus } from "./setup";

/**
 * The Settings dialog: its pages, the switches on General and Audio, the
 * About page's links, and the microphone list both it and the host read.
 */

const element = {
  settingsButton: requireElement<HTMLButtonElement>("settings-button"),
  settingsPanel: requireElement<HTMLElement>("settings-panel"),
  scrim: requireElement<HTMLElement>("scrim"),
  microphoneSelect: requireElement<HTMLSelectElement>("microphone-select"),
  themeToggle: requireElement<HTMLElement>("theme-toggle"),
  menubarToggle: requireElement<HTMLInputElement>("menubar-toggle"),
  launchAtLoginToggle: requireElement<HTMLInputElement>("launch-at-login-toggle"),
  flowBarToggle: requireElement<HTMLInputElement>("flow-bar-toggle"),
  dockToggle: requireElement<HTMLInputElement>("dock-toggle"),
  transcribeDropToggle: requireElement<HTMLInputElement>("transcribe-drop-toggle"),
  overlayPreview: requireElement<HTMLButtonElement>("overlay-preview"),
  overlayReset: requireElement<HTMLButtonElement>("overlay-reset"),
  aboutVersion: requireElement<HTMLElement>("about-version"),
  openRepository: requireElement<HTMLButtonElement>("open-repository"),
  openProfile: requireElement<HTMLButtonElement>("open-profile"),
  openDonate: requireElement<HTMLButtonElement>("open-donate"),
  openSite: requireElement<HTMLButtonElement>("open-site"),
};

let settingsOpen = false;
let microphones: MicrophoneDevice[] = [];

export function isSettingsOpen(): boolean {
  return settingsOpen;
}

/** The devices WebKit last reported, for the page that names the chosen one. */
export function knownMicrophones(): MicrophoneDevice[] {
  return microphones;
}

export function bindSettingsPanel(): void {
  element.settingsButton.addEventListener("click", () => toggleSettings(!settingsOpen));
  element.scrim.addEventListener("click", () => {
    if (isPromptEditorOpen()) togglePromptEditor(false);
    else toggleSettings(false);
  });
  bindGroup(".modal-nav [data-page]", (button) =>
    showSettingsPage(button.dataset.page ?? "general"),
  );

  element.microphoneSelect.addEventListener("change", () => {
    const id = element.microphoneSelect.value;
    const device = microphones.find((candidate) => candidate.id === id);
    void patchSettings({
      microphoneDeviceId: id,
      microphoneDeviceName: device?.label ?? "",
    });
  });
  element.themeToggle.addEventListener("click", (event) => {
    const theme = (event.target as HTMLElement).closest<HTMLElement>("[data-theme-value]")
      ?.dataset.themeValue;
    if (theme === "system" || theme === "light" || theme === "dark") {
      void patchSettings({ theme });
    }
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
  element.transcribeDropToggle.addEventListener("change", () => {
    void patchSettings({ transcribeOnDrop: element.transcribeDropToggle.checked });
  });
  element.dockToggle.addEventListener("change", () => {
    void patchSettings({ hideDockWhenClosed: !element.dockToggle.checked });
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
  // Both were documented and neither existed. Between them they are the only
  // way to find a Wave Bar that has been dragged somewhere unfortunate, or to
  // see what it looks like without holding the key and saying something.
  element.overlayPreview.addEventListener("click", () => {
    void host().previewIndicator();
  });
  element.overlayReset.addEventListener("click", () => {
    void patchSettings({ overlayX: null, overlayY: null, overlayCx: null, overlayCy: null });
  });

  navigator.mediaDevices?.addEventListener("devicechange", () => void refreshMicrophones());
}

export function toggleSettings(open: boolean, page = "general"): void {
  if (open && isPromptEditorOpen()) togglePromptEditor(false);
  // Settings covers the list, and with it the button that would pause.
  if (open) stopPlayback();
  settingsOpen = open;
  element.settingsPanel.hidden = !open;
  element.scrim.hidden = !open && !isPromptEditorOpen();
  if (!open) return;
  showSettingsPage(page);
  void host().getHotkeyStatus().then((status) => {
    state.hotkeyStatus = status;
    renderHotkeyStatus();
  });
  void host().getAiStatus().then(renderAiStatus);
}

/** Shows or hides the scrim on the prompt editor's behalf, which shares it. */
export function setScrimHidden(hidden: boolean): void {
  element.scrim.hidden = hidden;
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
  // Lines pushed while the page was closed are in the buffer, not on screen.
  if (page === "logs") void loadLogs();
}

/** The switches on General and Audio, and the theme, from the settings. */
export function renderSettingsPanel(next: AppSettings): void {
  renderMicrophoneSelect();
  element.menubarToggle.checked = next.menuBarIcon;
  element.launchAtLoginToggle.checked = next.launchAtLogin;
  element.flowBarToggle.checked = next.showFlowBarAlways;
  element.transcribeDropToggle.checked = next.transcribeOnDrop;
  element.dockToggle.checked = !next.hideDockWhenClosed;
  // Without a menu bar icon there would be no way back to the window.
  element.dockToggle.disabled = !next.menuBarIcon;
}

export function renderThemeToggle(theme: AppSettings["theme"]): void {
  for (const button of Array.from(
    element.themeToggle.querySelectorAll<HTMLElement>("[data-theme-value]"),
  )) {
    button.setAttribute("aria-checked", String(button.dataset.themeValue === theme));
  }
}

export function renderAboutVersion(text: string): void {
  element.aboutVersion.textContent = text;
}

/**
 * Browser media APIs own device enumeration; Rust receives this list for tray
 * controls. When `requestLabels` is true, getUserMedia is what surfaces the
 * macOS microphone prompt — opening Privacy settings alone never asks.
 */
export async function refreshMicrophones(requestLabels = false): Promise<boolean> {
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
  const { settings } = state;
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
