import { host } from "./host";
import { installTauriBridge } from "./tauri-bridge";
import { clock } from "./meeting-feed";

/**
 * The meeting pill: its own floating window, apart from the dictation Wave
 * Bar, up only while a meeting records. It shows the clock and the title;
 * clicking it opens the live transcript, dragging it moves it, and the host
 * remembers where it was left.
 */

/** Movement past this, in points, is a drag rather than a click. */
const DRAG_THRESHOLD = 3;

installTauriBridge();

const pill = requireElement<HTMLElement>("pill");
const time = requireElement<HTMLElement>("pill-time");
const title = requireElement<HTMLElement>("pill-title");
const stopButton = requireElement<HTMLButtonElement>("pill-stop");

let meetingId: string | null = null;
let startedAt: number | null = null;
let ticker: number | null = null;

function render(): void {
  if (startedAt === null) {
    if (ticker !== null) {
      window.clearInterval(ticker);
      ticker = null;
    }
    return;
  }
  time.textContent = clock(Date.now() - startedAt);
  if (ticker === null) ticker = window.setInterval(render, 1_000);
}

function begin(id: string, since: number, name: string | null): void {
  meetingId = id;
  startedAt = since;
  title.textContent = name ?? "";
  stopButton.disabled = false;
  render();
}

host().onMeetingState((event) => {
  if (event.recording && event.meetingId) {
    begin(event.meetingId, event.startedAt ?? Date.now(), event.title);
  } else {
    meetingId = null;
    startedAt = null;
    render();
  }
});
host().onMeetingChanged((meeting) => {
  if (meeting.id === meetingId) title.textContent = meeting.title;
});
// The window is built when the first recording starts, after that recording
// was announced, so it catches up here.
void host()
  .meetingRecorderStatus()
  .then(async (status) => {
    if (!status.recording) return;
    const detail = await host().getMeeting(status.recording);
    begin(detail.meeting.id, detail.meeting.createdAt, detail.meeting.title);
  })
  .catch(() => {});

stopButton.addEventListener("click", () => {
  stopButton.disabled = true;
  time.textContent = "Saving…";
  // The host takes the pill down once the recording has stopped.
  void host()
    .stopMeeting()
    .catch(() => {
      stopButton.disabled = false;
      render();
    });
});

// --- Click or drag ----------------------------------------------------------------
//
// The whole pill is both: a press that stays put opens the transcript, and one
// that moves carries the window with it, one host move per frame as the HUD
// does (see `overlay.ts`).

let origin: { x: number; y: number } | null = null;
let dragging = false;
let pending: { x: number; y: number } | null = null;
let frame = 0;

const flush = (): void => {
  frame = 0;
  if (!pending) return;
  host().moveMeetingPill(pending.x, pending.y);
  pending = null;
};

pill.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  if ((event.target as HTMLElement).closest("button")) return;
  origin = { x: event.screenX, y: event.screenY };
  dragging = false;
  pill.setPointerCapture(event.pointerId);
});

pill.addEventListener("pointermove", (event) => {
  if (!origin) return;
  const x = event.screenX - origin.x;
  const y = event.screenY - origin.y;
  if (!dragging) {
    if (Math.hypot(x, y) < DRAG_THRESHOLD) return;
    dragging = true;
    pill.dataset.dragging = "true";
    host().beginMeetingPillDrag();
  }
  pending = { x, y };
  if (frame === 0) frame = requestAnimationFrame(flush);
});

const end = (event: PointerEvent): void => {
  if (!origin) return;
  const last = { x: event.screenX - origin.x, y: event.screenY - origin.y };
  origin = null;
  pill.releasePointerCapture(event.pointerId);
  if (!dragging) {
    if (event.type === "pointerup") void host().toggleMeetingPanel();
    return;
  }
  if (frame !== 0) cancelAnimationFrame(frame);
  frame = 0;
  pending = null;
  dragging = false;
  pill.dataset.dragging = "false";
  host().endMeetingPillDrag(last.x, last.y);
};
pill.addEventListener("pointerup", end);
pill.addEventListener("pointercancel", end);

function requireElement<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
}
