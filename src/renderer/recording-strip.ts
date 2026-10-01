import { host } from "./host";
import { openView } from "./navigation";
import { openRecordingMeeting, stopRecording } from "./pages/meetings";
import { requireElement } from "./ui/dom";
import { clock } from "./ui/format";

/**
 * While a meeting records, every page but Meetings shows a strip with the
 * clock and Stop, and the sidebar item carries a dot. A live microphone is
 * never a surprise.
 */

let recordingStrip: { title: string; since: number } | null = null;
let stripTicker: number | null = null;

export function bindRecordingStrip(): void {
  requireElement<HTMLButtonElement>("recording-strip-stop").addEventListener("click", () => {
    void stopRecording();
  });
  requireElement<HTMLButtonElement>("recording-strip-open").addEventListener("click", () => {
    openView("meetings");
    openRecordingMeeting();
  });
  host().onMeetingState((event) => {
    recordingStrip = event.recording
      ? { title: event.title ?? "Meeting", since: event.startedAt ?? Date.now() }
      : null;
    renderRecordingStrip();
  });
  void host()
    .meetingRecorderStatus()
    .then((status) => {
      if (status.recording) {
        recordingStrip = { title: "Meeting", since: Date.now() };
        renderRecordingStrip();
      }
    })
    .catch(() => {});
}

export function renderRecordingStrip(): void {
  const strip = requireElement<HTMLElement>("recording-strip");
  const dot = requireElement<HTMLElement>("meetings-dot");
  const onMeetings = !requireElement<HTMLElement>("view-meetings").hidden;
  dot.hidden = recordingStrip === null;
  strip.hidden = recordingStrip === null || onMeetings;
  if (recordingStrip === null) {
    if (stripTicker !== null) window.clearInterval(stripTicker);
    stripTicker = null;
    return;
  }
  requireElement<HTMLElement>("recording-strip-text").textContent =
    `Recording “${recordingStrip.title}” · ${clock(Date.now() - recordingStrip.since)}`;
  if (stripTicker === null) stripTicker = window.setInterval(renderRecordingStrip, 500);
}
