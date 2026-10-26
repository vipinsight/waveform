import type { MeetingLevelEvent, MeetingLine } from "../shared/contracts";
import { host } from "./host";
import { installTauriBridge } from "./tauri-bridge";
import { MAX_LINES, clock, isFollowing, mergeLines, speakerName, voiceOf } from "./meeting-feed";

/**
 * The live transcript beside the screen edge, opened from the HUD's meeting
 * pill. It shows the meeting that is recording and nothing else: there is
 * only ever one, and the host closes the panel when it stops.
 */

/** How long the panel takes to slide out, from `meeting-panel.css`, plus a frame. */
const CLOSE_MS = 160;
/** How long the other side may stay silent before that reads as a missing permission. */
const UNHEARD_AFTER_MS = 5_000;

installTauriBridge();

const panel = requireElement<HTMLElement>("panel");
const titleText = requireElement<HTMLElement>("panel-title");
const clockText = requireElement<HTMLElement>("panel-clock");
const micMeter = requireElement<HTMLElement>("meter-mic");
const systemMeter = requireElement<HTMLElement>("meter-system");
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
let speakers: Record<string, string> = {};
let localName: string | null = null;
let hasOther = false;
let lines: MeetingLine[] = [];
let level: MeetingLevelEvent | null = null;
/** Whether new lines scroll into view; off while the reader has scrolled up. */
let following = true;
let ticker: number | null = null;
let hideTimer: number | null = null;

// --- Opening and closing ------------------------------------------------------

function open(): void {
  if (hideTimer !== null) {
    window.clearTimeout(hideTimer);
    hideTimer = null;
  }
  void load();
  // Next frame, so a panel that was just shown starts from off screen.
  requestAnimationFrame(() => {
    panel.dataset.open = "true";
  });
  if (ticker === null) ticker = window.setInterval(renderClock, 1_000);
}

function close(): void {
  panel.dataset.open = "false";
  if (ticker !== null) {
    window.clearInterval(ticker);
    ticker = null;
  }
  if (hideTimer !== null) window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => {
    hideTimer = null;
    void host().hideMeetingPanel();
  }, CLOSE_MS);
}

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
    showConfirm(false);
  }
  localName = status.localName || null;
  hasOther = status.systemAudio === "available" && detail.meeting.hasSystemAudio;
  startedAt = detail.meeting.createdAt;
  speakers = detail.meeting.speakers;
  titleText.textContent = detail.meeting.title;
  stopButton.disabled = false;
  lines = mergeLines(lines, detail.lines);
  renderClock();
  renderLevels();
  renderLines();
}

// --- Rendering ------------------------------------------------------------------

function renderClock(): void {
  clockText.textContent = clock(Date.now() - startedAt);
}

function renderLevels(): void {
  systemMeter.hidden = !hasOther;
  setLevel(micMeter, level?.mic ?? 0);
  setLevel(systemMeter, level?.system ?? 0);

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

/** Same curve as the meeting page, so a normal voice fills most of the bar. */
function setLevel(meter: HTMLElement, value: number): void {
  meter.style.setProperty("--level", String(Math.min(1, Math.sqrt(Math.min(1, value * 4)))));
}

function renderLines(): void {
  if (lines.length === 0) {
    const empty = document.createElement("li");
    empty.className = "panel-empty";
    empty.textContent = "Listening. Lines appear a few seconds after each sentence ends.";
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
  if (line.speaker === "me" || (!line.speaker && line.track === "mic")) item.classList.add("is-me");
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

requireElement<HTMLButtonElement>("panel-close").addEventListener("click", close);
requireElement<HTMLButtonElement>("panel-open").addEventListener("click", () => {
  void host().showMeetings();
  close();
});
stopButton.addEventListener("click", () => {
  stopButton.disabled = true;
  // The host closes the panel once the recording has stopped.
  void host()
    .stopMeeting()
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

host().onMeetingPanel((action) => (action === "open" ? open() : close()));
host().onMeetingState((event) => {
  if (event.recording && event.meetingId !== meetingId) void load();
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
  renderLevels();
});
host().onMeetingChanged((meeting) => {
  if (meeting.id !== meetingId) return;
  titleText.textContent = meeting.title;
  speakers = meeting.speakers;
});

// The window is built on the first open, after the host has already asked it
// to slide in, so the first open comes from here.
open();

function requireElement<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
}
