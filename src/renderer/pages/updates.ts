import type { UpdateEvent } from "../../shared/contracts";
import { host } from "../host";
import { requireElement } from "../ui/dom";
import { patchSettings, state } from "../state";
import { toggleSettings } from "./settings-panel";

/**
 * Finding and installing a new version: the button on the About page, the
 * pill in the sidebar, and the line that says what happened.
 */

const element = {
  updateToggle: requireElement<HTMLInputElement>("update-toggle"),
  updateCheck: requireElement<HTMLButtonElement>("update-check"),
  updatePill: requireElement<HTMLButtonElement>("update-pill"),
  updatePillTitle: requireElement<HTMLElement>("update-pill-title"),
  updatePillAction: requireElement<HTMLElement>("update-pill-action"),
  updateHint: requireElement<HTMLElement>("update-hint"),
  updateHintText: requireElement<HTMLElement>("update-hint-text"),
  updateNotes: requireElement<HTMLButtonElement>("update-notes"),
};

/** Whether the About button is asking for a check or installing one. */
let updateAction: "check" | "install" = "check";
/** The release the status line's "What's new" opens. */
let updateNotesVersion: string | null = null;

export function bindUpdates(): void {
  host().onUpdateEvent(handleUpdateEvent);
  // A check that ran before this window loaded already found it.
  void host()
    .getUpdateAvailable()
    .then((version) => {
      if (version) {
        handleUpdateEvent({
          stage: "available",
          message: `Waveform ${version} is available`,
          version,
        });
      }
    })
    .catch(() => {});

  element.updateToggle.addEventListener("change", () => {
    void patchSettings({ automaticUpdateCheck: element.updateToggle.checked });
  });
  element.updateCheck.addEventListener("click", () => {
    if (updateAction === "install") {
      // Painted here, before the host answers: its first event follows a
      // network round trip, and a button that does not change on a press
      // reads as broken.
      setUpdateButton("Preparing…", { busy: true, install: true });
      void installUpdate();
      return;
    }
    void checkForUpdate();
  });
  element.updatePill.addEventListener("click", () => {
    if (element.updatePill.dataset.state !== "available" && element.updatePill.dataset.state !== "error") {
      return;
    }
    renderUpdatePill({ stage: "downloading", message: "Preparing the update…" });
    void installUpdate();
  });
  element.updateNotes.addEventListener("click", () => {
    if (updateNotesVersion) {
      void host().openUrl(
        `https://github.com/vipinsight/waveform/releases/tag/v${updateNotesVersion}`,
      );
    }
  });
}

export function renderUpdateToggle(automatic: boolean): void {
  element.updateToggle.checked = automatic;
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
  options?: { busy?: boolean; install?: boolean },
): void {
  element.updateCheck.textContent = label;
  element.updateCheck.disabled = Boolean(options?.busy);
  element.updateCheck.setAttribute("aria-busy", options?.busy ? "true" : "false");
  element.updateCheck.classList.toggle("is-primary", Boolean(options?.install));
  updateAction = options?.install ? "install" : "check";
}

/**
 * The button carries the action; the line above it says what is happening.
 *
 * A label alone had to hold both, so the version and any error lived in a
 * tooltip, and "Update and Restart" followed by a fast relaunch looked like a
 * press that did nothing. The line sits on its own row, above the copyright,
 * so a long message cannot shove anything sideways.
 */
function handleUpdateEvent(event: UpdateEvent): void {
  renderUpdatePill(event);
  const version = event.version ?? null;
  const { appVersion } = state;
  switch (event.stage) {
    case "checking":
      setUpdateButton("Checking…", { busy: true });
      setUpdateHint(null);
      return;
    case "current":
      setUpdateButton("Up to date");
      setUpdateHint(appVersion ? `Waveform ${appVersion} is the latest version.` : null);
      return;
    case "available":
      setUpdateButton(version ? `Update to ${version}` : "Update", { install: true });
      setUpdateHint(`${event.message}. Waveform restarts to finish.`, version);
      return;
    case "downloading": {
      const percent =
        event.progress !== undefined ? ` ${Math.round(event.progress * 100)}%` : "";
      setUpdateButton(version ? `Downloading…${percent}` : "Preparing…", {
        busy: true,
        install: true,
      });
      setUpdateHint(event.message, version);
      return;
    }
    case "installing":
      setUpdateButton("Installing…", { busy: true, install: true });
      setUpdateHint(event.message, version);
      return;
    case "installed":
      setUpdateButton("Restarting…", { busy: true, install: true });
      setUpdateHint(
        version
          ? `Waveform ${version} is installed. Restarting now.`
          : "Installed. Restarting now.",
        version,
      );
      return;
    case "error":
      setUpdateButton(updateAction === "install" ? "Try Again" : "Check Again", {
        install: updateAction === "install",
      });
      setUpdateHint(event.message);
      return;
    default: {
      const _exhaustive: never = event.stage;
      return _exhaustive;
    }
  }
}

/**
 * The sidebar's update pill: hidden until a check finds something, then the
 * version and the one action, then how far installing has got.
 */
function renderUpdatePill(event: UpdateEvent): void {
  const pill = element.updatePill;
  if (event.version) pill.dataset.version = event.version;
  const version = pill.dataset.version ?? "";
  switch (event.stage) {
    case "checking":
      return;
    case "current":
      pill.hidden = true;
      return;
    case "available":
      pill.dataset.state = "available";
      element.updatePillTitle.textContent = version
        ? `Waveform ${version} is ready`
        : "Update available";
      element.updatePillAction.textContent = "Restart to update";
      break;
    case "downloading":
      pill.dataset.state = "working";
      element.updatePillTitle.textContent = "Updating Waveform";
      element.updatePillAction.textContent =
        event.progress !== undefined
          ? `Downloading… ${Math.round(event.progress * 100)}%`
          : "Preparing…";
      break;
    case "installing":
      pill.dataset.state = "working";
      element.updatePillTitle.textContent = "Updating Waveform";
      element.updatePillAction.textContent = "Installing…";
      break;
    case "installed":
      pill.dataset.state = "working";
      element.updatePillTitle.textContent = "Updating Waveform";
      element.updatePillAction.textContent = "Restarting…";
      break;
    case "error":
      // A failed check is the About page's to report; only a failed install
      // belongs on a pill that offered to install.
      if (pill.hidden) return;
      pill.dataset.state = "error";
      element.updatePillTitle.textContent = "Update didn't finish";
      element.updatePillAction.textContent = "Try again";
      pill.title = event.message;
      break;
  }
  pill.hidden = false;
  pill.disabled = pill.dataset.state === "working";
  pill.setAttribute(
    "aria-label",
    `${element.updatePillTitle.textContent}. ${element.updatePillAction.textContent}`,
  );
}

/** The status line above the button; `null` blanks it (its space stays). */
function setUpdateHint(message: string | null, notesFor: string | null = null): void {
  element.updateHintText.textContent = message ?? "";
  element.updateHint.title = message ?? "";
  updateNotesVersion = notesFor;
  element.updateNotes.hidden = notesFor === null;
}

/**
 * Says so after a relaunch into a new version.
 *
 * The restart is quick and the window comes back looking the same, so an
 * update that worked read as one that had not. The last version seen is a
 * per-machine convenience; when storage is unavailable nothing is said,
 * which is how it behaved before.
 */
export function announceUpdateIfNew(): void {
  const { appVersion } = state;
  if (!appVersion) return;
  let previous: string | null = null;
  try {
    previous = localStorage.getItem("waveform.lastVersion");
    localStorage.setItem("waveform.lastVersion", appVersion);
  } catch {
    return;
  }
  if (!previous || previous === appVersion) return;
  toggleSettings(true, "about");
  setUpdateButton("Up to date");
  setUpdateHint(`Updated to Waveform ${appVersion}.`, appVersion);
}
