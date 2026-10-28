import type { Meeting, MeetingLevelEvent, MeetingLine } from "../shared/contracts";
import type { AppSettings } from "../shared/settings";
import { host } from "./host";
import { installTauriBridge } from "./tauri-bridge";
import { MAX_LINES, clock, isFollowing, mergeLines, speakerName, voiceOf } from "./meeting-feed";

/**
 * The live transcript window, opened from the meeting pill. It shows the
 * meeting that is recording; there is only ever one. Stop leaves the window
 * open on that meeting so it can still be read while Waveform finishes the
 * notes. Closing the window only hides it, and a discard takes it away.
 */

/** How long the other side may stay silent before that reads as a missing permission. */
const UNHEARD_AFTER_MS = 5_000;

installTauriBridge();

const panel = requireElement<HTMLElement>("panel");
const titleText = requireElement<HTMLElement>("panel-title");
const statusText = requireElement<HTMLElement>("panel-status");
const clockText = requireElement<HTMLElement>("panel-clock");
const note = requireElement<HTMLElement>("panel-note");
const list = requireElement<HTMLOListElement>("panel-lines");
const jump = requireElement<HTMLButtonElement>("panel-jump");
const actions = requireElement<HTMLElement>("panel-actions");
const confirm = requireElement<HTMLElement>("panel-confirm");
const stopButton = requireElement<HTMLButtonElement>("panel-stop");
const discardButton = requireElement<HTMLButtonElement>("panel-discard");
const confirmDiscardButton = requireElement<HTMLButtonElement>("panel-confirm-discard");

let meetingId: string | null = null;
let startedAt = Date.now();
/** Set once the recording has stopped: the length the clock holds. */
let stoppedAfter: number | null = null;
let speakers: Record<string, string> = {};
let localName: string | null = null;
let hasOther = false;
let lines: MeetingLine[] = [];
let level: MeetingLevelEvent | null = null;
/** Whether new lines scroll into view; off while the reader has scrolled up. */
let following = true;

// --- Opening ------------------------------------------------------------------

/** The host shows the window; the page catches up on whatever it missed. */
function open(): void {
  void load();
}

window.setInterval(renderClock, 1_000);

/** Catches up on the recording: its title, who is on it, and the lines so far. */
async function load(): Promise<void> {
  const status = await host().meetingRecorderStatus().catch(() => null);
  if (!status?.recording) return;
  const detail = await host().getMeeting(status.recording).catch(() => null);
  if (!detail) return;
  if (detail.meeting.id !== meetingId) {
    meetingId = detail.meeting.id;
    lines = [];
    level = null;
    following = true;
  }
  setRecording();
  localName = status.localName || null;
  hasOther = status.systemAudio === "available" && detail.meeting.hasSystemAudio;
  startedAt = detail.meeting.createdAt;
  speakers = detail.meeting.speakers;
  titleText.textContent = detail.meeting.title;
  lines = mergeLines(lines, detail.lines);
  renderClock();
  renderNote();
  renderLines();
}

// --- Rendering ------------------------------------------------------------------

function renderClock(): void {
  clockText.textContent = clock(stoppedAfter ?? Date.now() - startedAt);
}

/** Back to a live recording, as for a meeting just started. */
function setRecording(): void {
  stoppedAfter = null;
  panel.dataset.state = "recording";
  stopButton.disabled = false;
  showConfirm(false);
  statusText.hidden = true;
}

/** The recording ended: keep the transcript up, and say what happens now. */
function setStopped(durationMs: number | null): void {
  if (stoppedAfter === null) stoppedAfter = durationMs ?? Date.now() - startedAt;
  panel.dataset.state = "stopped";
  confirm.hidden = true;
  actions.hidden = true;
  note.hidden = true;
  statusText.hidden = false;
  if (statusText.textContent === "") statusText.textContent = "Stopped. Waveform is writing the notes.";
  renderClock();
  if (lines.length === 0) renderLines();
}

/** What became of a stopped meeting: its notes written, or a failure. */
function renderOutcome(meeting: Meeting): void {
  if (meeting.state === "ready") statusText.textContent = "Stopped. The notes are ready in Waveform.";
  else if (meeting.state === "failed") statusText.textContent = "Stopped, but the notes could not be written. Open Waveform to retry.";
  else statusText.textContent = "Stopped. Waveform is writing the notes.";
}

/** Says so when only one side is being recorded, or the other side is silent. */
function renderNote(): void {
  if (stoppedAfter !== null) return;
  const unheard = hasOther && level !== null && !level.otherHeard && level.elapsedMs > UNHEARD_AFTER_MS;
  note.classList.toggle("is-warn", unheard);
  if (!hasOther) {
    note.textContent = "Only your microphone is being recorded.";
  } else if (unheard) {
    note.textContent = "Waveform can't hear the other side yet. Open Waveform to allow it.";
  } else {
    note.textContent = "";
  }
  note.hidden = note.textContent === "";
}

function renderLines(): void {
  if (lines.length === 0) {
    const empty = document.createElement("li");
    empty.className = "panel-empty";
    empty.textContent =
      stoppedAfter === null ? "Listening. Lines appear a few seconds after each sentence ends." : "Nothing was transcribed.";
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(...lines.map((line, index) => lineItem(line, lines[index - 1])));
  if (following) scrollToLatest();
}

/** Adds lines that arrived after the last one shown, without redrawing the rest. */
function appendLines(added: MeetingLine[]): void {
  if (list.querySelector(".panel-empty")) {
    renderLines();
    return;
  }
  for (const line of added) {
    const previous = lines[lines.indexOf(line) - 1];
    list.append(lineItem(line, previous));
  }
  while (list.children.length > MAX_LINES) list.firstElementChild?.remove();
  if (following) scrollToLatest();
  else jump.hidden = false;
}

function lineItem(line: MeetingLine, previous: MeetingLine | undefined): HTMLLIElement {
  const item = document.createElement("li");
  item.className = "panel-line";
  item.classList.add(voiceClass(line));
  if (previous && voiceOf(previous) === voiceOf(line)) item.classList.add("is-continued");

  const time = document.createElement("span");
  time.className = "panel-line-time";
  time.textContent = clock(line.startMs);

  const who = document.createElement("span");
  who.className = "panel-line-speaker";
  who.textContent = speakerName(line, speakers, localName);

  const text = document.createElement("p");
  text.className = "panel-line-text";
  text.textContent = line.text;

  item.append(time, who, text);
  return item;
}

/** The same hue for a voice as on the Meetings page. */
function voiceClass(line: MeetingLine): string {
  if (line.speaker === "me" || (!line.speaker && line.track === "mic")) return "is-me";
  const match = /^speaker_(\d+)$/.exec(line.speaker ?? "");
  return match ? `is-s${Number(match[1]) % 6}` : "is-them";
}

/** Light or dark as the app is set; "system" leaves it to macOS. */
function applyTheme(theme: AppSettings["theme"]): void {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

function scrollToLatest(): void {
  list.scrollTop = list.scrollHeight;
  following = true;
  jump.hidden = true;
}

function showConfirm(asking: boolean): void {
  confirm.hidden = !asking;
  actions.hidden = asking;
  confirmDiscardButton.disabled = false;
}

// --- Events ---------------------------------------------------------------------

list.addEventListener("scroll", () => {
  following = isFollowing(list.scrollTop, list.clientHeight, list.scrollHeight);
  if (following) jump.hidden = true;
});
jump.addEventListener("click", scrollToLatest);

requireElement<HTMLButtonElement>("panel-open").addEventListener("click", () => void host().showMeetings());
stopButton.addEventListener("click", () => {
  stopButton.disabled = true;
  // The window stays open on the stopped meeting, so it can still be read.
  void host()
    .stopMeeting()
    .then((meeting) => {
      setStopped(meeting.durationMs || null);
      renderOutcome(meeting);
    })
    .catch(() => {
      stopButton.disabled = false;
    });
});
discardButton.addEventListener("click", () => showConfirm(true));
requireElement<HTMLButtonElement>("panel-confirm-keep").addEventListener("click", () => showConfirm(false));
confirmDiscardButton.addEventListener("click", () => {
  confirmDiscardButton.disabled = true;
  void host()
    .cancelMeeting()
    .catch(() => showConfirm(false));
});

host().onMeetingPanel(open);
host().onSettingsChanged((settings) => applyTheme(settings.theme));
void host()
  .getSettings()
  .then((settings) => applyTheme(settings.theme))
  .catch(() => {});
host().onMeetingState((event) => {
  if (event.recording && event.meetingId !== meetingId) void load();
  // Stopped elsewhere too: from the pill, the menu bar or the main window.
  if (!event.recording && meetingId !== null) setStopped(null);
});
host().onMeetingLine((event) => {
  if (event.meetingId !== meetingId) return;
  const last = lines.at(-1)?.idx ?? -1;
  lines = mergeLines(lines, [event.line]);
  if (event.line.idx > last) appendLines([event.line]);
  else renderLines();
});
host().onMeetingLevel((event) => {
  if (event.meetingId !== meetingId) return;
  level = event;
  renderNote();
});
host().onMeetingChanged((meeting) => {
  if (meeting.id !== meetingId) return;
  titleText.textContent = meeting.title;
  speakers = meeting.speakers;
  if (stoppedAfter !== null) renderOutcome(meeting);
});

// The window is built on the first open, after the host has already said so,
// so the first catch-up comes from here.
open();

function requireElement<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
}
