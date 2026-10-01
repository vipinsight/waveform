import { requireElement } from "./ui/dom";
import { showMeetings } from "./pages/meetings";
import { stopPlayback } from "./pages/history";
import { refreshModelsView } from "./pages/models";
import { renderAiStatus } from "./pages/polish";
import { isSettingsOpen, refreshMicrophones, toggleSettings } from "./pages/settings-panel";
import { renderRecordingStrip } from "./recording-strip";
import { host } from "./host";

/**
 * Moving between the window's sections. Each page owns what it shows; this
 * only decides which one is on screen and gives it the chance to re-read
 * what may have changed while it was closed.
 */

const VIEWS = ["dictate", "dictation", "dictionary", "meetings", "overview", "models", "ai"];

export function showView(view: string): void {
  // Recordings play from the Transcripts list; leaving it leaves them.
  if (view !== "dictate") stopPlayback();
  for (const button of Array.from(
    document.querySelectorAll<HTMLElement>(".nav[aria-label='Sections'] [data-view]"),
  )) {
    const active = button.dataset.view === view;
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  for (const id of VIEWS) {
    requireElement<HTMLElement>(`view-${id}`).hidden = id !== view;
  }
  if (view === "models") refreshModelsView();
  // The levels say what they need before they can run, and what they need is
  // a key or a download that could have arrived while the section was closed.
  if (view === "ai") void host().getAiStatus().then(renderAiStatus);
  // Labels are what name the devices, and WebKit hands them over only once
  // the microphone has been asked for.
  if (view === "dictation") void refreshMicrophones(true);
  if (view === "meetings") showMeetings();
  renderRecordingStrip();
}

/** Shows a section of the window, closing Settings if it is over it. */
export function openView(view: string): void {
  if (isSettingsOpen()) toggleSettings(false);
  showView(view);
}
