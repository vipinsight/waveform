import type {
  DiarizerInstallEvent,
  Meeting,
  MeetingDetail,
  MeetingLine,
  MeetingSummary,
  RecorderStatus,
} from "../shared/contracts";
import { host } from "./host";

/**
 * The Meetings page: a list of recordings, and one open at a time with its
 * summary and transcript.
 *
 * The host does the recording and transcribing; this file only shows what
 * it reports and asks it for changes. Nothing here has to survive the
 * window closing, because nothing here is the recording.
 */

interface Options {
  /** Opens another page, for "add a key in AI Polish". */
  openView(view: string): void;
}

const element = {
  view: byId<HTMLElement>("view-meetings"),
  search: byId<HTMLInputElement>("meetings-search"),
  record: byId<HTMLButtonElement>("meeting-record"),
  setup: byId<HTMLElement>("meetings-setup"),
  list: byId<HTMLElement>("meetings-list"),
  empty: byId<HTMLElement>("meetings-empty"),
  detail: byId<HTMLElement>("meeting-detail"),
  back: byId<HTMLButtonElement>("meeting-back"),
  title: byId<HTMLInputElement>("meeting-title"),
  meta: byId<HTMLElement>("meeting-meta"),
  stop: byId<HTMLButtonElement>("meeting-stop"),
  discard: byId<HTMLButtonElement>("meeting-discard"),
  play: byId<HTMLButtonElement>("meeting-play"),
  copyTranscript: byId<HTMLButtonElement>("meeting-copy-transcript"),
  remove: byId<HTMLButtonElement>("meeting-delete"),
  stage: byId<HTMLElement>("meeting-stage"),
  summary: byId<HTMLElement>("meeting-summary"),
  find: byId<HTMLInputElement>("meeting-find"),
  speakers: byId<HTMLElement>("meeting-speakers"),
  lines: byId<HTMLOListElement>("meeting-lines"),
};

let options: Options = { openView: () => {} };
let status: RecorderStatus | null = null;
let meetings: Meeting[] = [];
let openId: string | null = null;
let detail: MeetingDetail | null = null;
let playback: { audio: HTMLAudioElement; url: string } | null = null;
let ticker: number | null = null;
let installing: DiarizerInstallEvent | null = null;

export function bindMeetings(given: Options): void {
  options = given;

  element.record.addEventListener("click", () => void record());
  element.stop.addEventListener("click", () => void stop());
  element.discard.addEventListener("click", () => void discard());
  element.remove.addEventListener("click", () => void remove());
  element.back.addEventListener("click", () => openMeeting(null));
  element.play.addEventListener("click", () => void togglePlay());
  element.copyTranscript.addEventListener("click", () => {
    if (!detail) return;
    void navigator.clipboard.writeText(transcriptText(detail));
    flash(element.copyTranscript, "Copied");
  });
  element.title.addEventListener("change", () => {
    if (!openId) return;
    void host()
      .renameMeeting(openId, element.title.value)
      .then(applyMeeting)
      .catch(showError);
  });
  element.title.addEventListener("keydown", (event) => {
    if (event.key === "Enter") element.title.blur();
  });
  element.search.addEventListener("input", renderList);
  element.find.addEventListener("input", renderLines);

  host().onMeetingLine(({ meetingId, line }) => {
    if (!detail || detail.meeting.id !== meetingId) return;
    detail.lines.push(line);
    detail.lines.sort((a, b) => a.startMs - b.startMs || a.idx - b.idx);
    renderLines();
    renderSpeakers();
  });
  host().onMeetingChanged((meeting) => {
    applyMeeting(meeting);
    // Processing finished or the summary landed: the detail has more now.
    if (detail && detail.meeting.id === meeting.id && meeting.state !== "recording") {
      void reloadDetail();
    }
    void refreshStatus();
  });
  host().onMeetingsChanged(() => void refreshList());
  host().onDiarizerInstall((event) => {
    installing = event.stage === "downloading" ? event : null;
    if (event.stage !== "downloading") void refreshStatus();
    renderSetup();
  });

  void refreshStatus();
  void refreshList();
}

/** Called when the page is shown, so what it shows is current. */
export function showMeetings(): void {
  void refreshStatus();
  void refreshList();
  if (openId) void reloadDetail();
}

async function refreshStatus(): Promise<void> {
  try {
    status = await host().meetingRecorderStatus();
  } catch {
    status = null;
  }
  renderSetup();
  renderRecordButton();
}

async function refreshList(): Promise<void> {
  try {
    meetings = await host().listMeetings();
  } catch (error) {
    showError(error);
    return;
  }
  renderList();
  if (openId && !meetings.some((meeting) => meeting.id === openId)) openMeeting(null);
}

async function reloadDetail(): Promise<void> {
  if (!openId) return;
  try {
    const next = await host().getMeeting(openId);
    if (next.meeting.id !== openId) return;
    detail = next;
    renderDetail();
  } catch (error) {
    showError(error);
  }
}

function applyMeeting(meeting: Meeting): void {
  const index = meetings.findIndex((entry) => entry.id === meeting.id);
  if (index === -1) meetings.unshift(meeting);
  else meetings[index] = meeting;
  meetings.sort((a, b) => b.createdAt - a.createdAt);
  renderList();
  if (detail && detail.meeting.id === meeting.id) {
    detail.meeting = meeting;
    renderHead();
    renderSpeakers();
    renderLines();
    renderSummary();
  }
  renderRecordButton();
}

// --- Recording -------------------------------------------------------------

async function record(): Promise<void> {
  element.record.disabled = true;
  try {
    const meeting = await host().startMeeting();
    applyMeeting(meeting);
    detail = { meeting, lines: [], summary: null };
    openId = meeting.id;
    renderDetail();
    element.title.focus();
    element.title.select();
  } catch (error) {
    showError(error);
  } finally {
    renderRecordButton();
  }
}

async function stop(): Promise<void> {
  element.stop.disabled = true;
  element.stop.textContent = "Stopping…";
  try {
    applyMeeting(await host().stopMeeting());
  } catch (error) {
    showError(error);
  } finally {
    element.stop.disabled = false;
    element.stop.textContent = "Stop";
  }
}

async function discard(): Promise<void> {
  if (!detail || detail.meeting.state !== "recording") return;
  if (!window.confirm("Stop recording and throw this meeting away?")) return;
  try {
    await host().cancelMeeting();
    openMeeting(null);
    await refreshList();
  } catch (error) {
    showError(error);
  }
}

async function remove(): Promise<void> {
  if (!detail) return;
  if (!window.confirm(`Delete "${detail.meeting.title}" and its recording? This cannot be undone.`)) {
    return;
  }
  try {
    await host().deleteMeeting(detail.meeting.id);
    openMeeting(null);
    await refreshList();
  } catch (error) {
    showError(error);
  }
}

// --- Setup notes -------------------------------------------------------------

/** What is missing before a meeting records as well as it could. */
function renderSetup(): void {
  element.setup.replaceChildren();
  if (!status) {
    element.setup.hidden = true;
    return;
  }
  const notes: HTMLElement[] = [];

  if (status.systemAudio !== "available") {
    notes.push(
      setupRow(
        status.systemAudio === "unsupported"
          ? "Only your microphone is recorded on this version of macOS."
          : "Only your microphone is recorded in this build.",
        status.systemAudio === "unsupported"
          ? "Hearing the other side of a call needs macOS 14.2 or later."
          : "The system-audio helper was not built; see docs/building.md.",
      ),
    );
  }

  if (!status.diarizerInstalled) {
    const row = setupRow(
      "Tell remote speakers apart",
      installing
        ? installing.message
        : `A ${megabytes(status.diarizerBytes)} download, kept on this Mac. Without it every remote line is one speaker.`,
    );
    const action = document.createElement("button");
    action.type = "button";
    action.className = "pill-button is-primary";
    if (installing) {
      action.textContent = `${Math.round(installing.progress * 100)}% · Cancel`;
      action.addEventListener("click", () => void host().cancelDiarizerInstall());
    } else {
      action.textContent = "Download";
      action.addEventListener("click", () => {
        installing = { stage: "downloading", message: "Starting…", progress: 0 };
        renderSetup();
        void host()
          .installDiarizer()
          .catch(showError)
          .finally(() => void refreshStatus());
      });
    }
    row.append(action);
    notes.push(row);
  }

  if (!status.hasOpenRouterKey) {
    const row = setupRow(
      "Summaries need an OpenRouter key",
      "Transcription stays on this Mac. Writing the summary sends the transcript text to the model you chose in AI Polish.",
    );
    const action = document.createElement("button");
    action.type = "button";
    action.className = "pill-button";
    action.textContent = "Open AI Polish";
    action.addEventListener("click", () => options.openView("ai"));
    row.append(action);
    notes.push(row);
  }

  element.setup.hidden = notes.length === 0;
  element.setup.append(...notes);
}

function setupRow(title: string, detailText: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "row";
  const label = document.createElement("span");
  label.className = "row-label";
  label.append(title);
  const small = document.createElement("small");
  small.textContent = detailText;
  label.append(small);
  row.append(label);
  return row;
}

function renderRecordButton(): void {
  const recording = Boolean(status?.recording);
  element.record.disabled = recording;
  element.record.textContent = recording ? "Recording…" : "Record";
}

// --- The list ----------------------------------------------------------------

function renderList(): void {
  const query = element.search.value.trim().toLowerCase();
  const shown = query
    ? meetings.filter(
        (meeting) =>
          meeting.title.toLowerCase().includes(query) ||
          (meeting.summary ?? "").toLowerCase().includes(query),
      )
    : meetings;

  element.empty.hidden = meetings.length > 0;
  element.empty.textContent =
    meetings.length === 0
      ? "No meetings yet. Press Record before a call; Waveform transcribes as it goes and writes the summary when you stop."
      : "";
  if (meetings.length > 0 && shown.length === 0) {
    element.empty.hidden = false;
    element.empty.textContent = "No meeting matches that.";
  }

  element.list.replaceChildren(...shown.map(renderListRow));
  element.list.hidden = openId !== null;
  element.empty.hidden = element.empty.hidden || openId !== null;
}

function renderListRow(meeting: Meeting): HTMLElement {
  const row = document.createElement("button");
  row.type = "button";
  row.className = `meeting-row is-${meeting.state}`;
  row.addEventListener("click", () => openMeeting(meeting.id));

  const title = document.createElement("span");
  title.className = "meeting-row-title";
  title.textContent = meeting.title;

  const meta = document.createElement("span");
  meta.className = "meeting-row-meta";
  meta.textContent = [
    new Date(meeting.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }),
    duration(meeting.durationMs),
    stateWord(meeting),
  ]
    .filter(Boolean)
    .join(" · ");

  const lede = document.createElement("span");
  lede.className = "meeting-row-lede";
  lede.textContent = meeting.summary?.split("\n")[0] ?? (meeting.stage ?? "");

  row.append(title, meta, lede);
  return row;
}

function stateWord(meeting: Meeting): string {
  switch (meeting.state) {
    case "recording":
      return "Recording";
    case "processing":
      return meeting.stage ?? "Processing";
    case "failed":
      return "Stopped early";
    default:
      return "";
  }
}

// --- One meeting -------------------------------------------------------------

function openMeeting(id: string | null): void {
  stopPlayback();
  openId = id;
  detail = null;
  element.detail.hidden = id === null;
  element.list.hidden = id !== null;
  element.find.value = "";
  renderList();
  if (id) {
    const known = meetings.find((meeting) => meeting.id === id);
    if (known) {
      detail = { meeting: known, lines: [], summary: null };
      renderDetail();
    }
    void reloadDetail();
  } else {
    stopTicker();
  }
}

function renderDetail(): void {
  if (!detail) return;
  renderHead();
  renderSpeakers();
  renderLines();
  renderSummary();
}

function renderHead(): void {
  if (!detail) return;
  const { meeting } = detail;
  if (document.activeElement !== element.title) element.title.value = meeting.title;

  const recording = meeting.state === "recording";
  element.stop.hidden = !recording;
  element.discard.hidden = !recording;
  element.play.hidden = recording;
  element.copyTranscript.hidden = recording;
  element.remove.hidden = recording;

  if (recording) startTicker();
  else stopTicker();
  renderMeta();

  element.stage.hidden = !meeting.stage && meeting.state !== "recording";
  element.stage.className = `meeting-stage is-${meeting.state}`;
  element.stage.textContent =
    meeting.state === "recording"
      ? "Recording. Lines appear as phrases finish; speakers are tagged and the summary written when you stop."
      : (meeting.stage ?? "");
}

function renderMeta(): void {
  if (!detail) return;
  const { meeting } = detail;
  const parts = [
    new Date(meeting.createdAt).toLocaleString([], { dateStyle: "full", timeStyle: "short" }),
    meeting.state === "recording"
      ? `${duration(Date.now() - meeting.createdAt)} so far`
      : duration(meeting.durationMs),
  ];
  const speakers = new Set(detail.lines.map((line) => line.speaker).filter(Boolean));
  if (speakers.size > 0) parts.push(`${speakers.size} ${speakers.size === 1 ? "speaker" : "speakers"}`);
  if (!meeting.hasSystemAudio) parts.push("microphone only");
  element.meta.textContent = parts.join(" · ");
}

function startTicker(): void {
  if (ticker !== null) return;
  ticker = window.setInterval(renderMeta, 1_000);
}

function stopTicker(): void {
  if (ticker === null) return;
  window.clearInterval(ticker);
  ticker = null;
}

// --- Speakers --------------------------------------------------------------

function speakerName(label: string | null, meeting: Meeting): string {
  if (!label) return "Speaker";
  const named = meeting.speakers[label];
  if (named) return named;
  if (label === "me") return status?.localName ?? "Me";
  const match = /^speaker_(\d+)$/.exec(label);
  return match ? `Speaker ${Number(match[1]) + 1}` : label;
}

function renderSpeakers(): void {
  if (!detail) return;
  const { meeting } = detail;
  const labels = Array.from(
    new Set(detail.lines.map((line) => line.speaker).filter((label): label is string => Boolean(label))),
  );
  element.speakers.replaceChildren(
    ...labels.map((label) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = `speaker-chip ${speakerClass(label)}`;
      chip.textContent = speakerName(label, meeting);
      chip.title = "Click to rename";
      chip.addEventListener("click", () => renameSpeaker(label, chip));
      return chip;
    }),
  );
  element.speakers.hidden = labels.length === 0;
}

/** Turns the chip into a field; Enter or blur saves, Esc cancels. */
function renameSpeaker(label: string, chip: HTMLButtonElement): void {
  if (!detail) return;
  const meeting = detail.meeting;
  const field = document.createElement("input");
  field.className = `speaker-chip is-editing ${speakerClass(label)}`;
  field.value = speakerName(label, meeting);
  field.setAttribute("aria-label", "Speaker name");
  chip.replaceWith(field);
  field.focus();
  field.select();
  let settled = false;
  const finish = (save: boolean) => {
    if (settled) return;
    settled = true;
    const name = field.value.trim();
    field.replaceWith(chip);
    if (!save || name === speakerName(label, meeting)) return;
    void host()
      .renameMeetingSpeaker(meeting.id, label, name)
      .then(applyMeeting)
      .catch(showError);
  };
  field.addEventListener("keydown", (event) => {
    if (event.key === "Enter") finish(true);
    if (event.key === "Escape") finish(false);
  });
  field.addEventListener("blur", () => finish(true));
}

function speakerClass(label: string): string {
  if (label === "me") return "is-me";
  const match = /^speaker_(\d+)$/.exec(label);
  return match ? `is-s${Number(match[1]) % 6}` : "";
}

// --- Transcript --------------------------------------------------------------

function renderLines(): void {
  if (!detail) return;
  const { meeting } = detail;
  const query = element.find.value.trim().toLowerCase();
  const shown = query ? detail.lines.filter((line) => line.text.toLowerCase().includes(query)) : detail.lines;

  element.lines.replaceChildren(
    ...shown.map((line) => {
      const item = document.createElement("li");
      item.className = `meeting-line ${speakerClass(line.speaker ?? "")}`;

      const time = document.createElement("button");
      time.type = "button";
      time.className = "meeting-line-time";
      time.textContent = clock(line.startMs);
      time.title = "Play from here";
      time.disabled = meeting.state === "recording";
      time.addEventListener("click", () => void playFrom(line.startMs));

      const who = document.createElement("span");
      who.className = "meeting-line-speaker";
      who.textContent = speakerName(line.speaker, meeting);

      const text = document.createElement("p");
      text.className = "meeting-line-text";
      text.append(...highlight(line.text, query));

      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "meeting-line-copy";
      copy.textContent = "Copy";
      copy.title = "Copy this line";
      copy.addEventListener("click", () => {
        void navigator.clipboard.writeText(line.text);
        flash(copy, "Copied");
      });

      item.append(time, who, text, copy);
      return item;
    }),
  );
  if (detail.lines.length === 0) {
    const empty = document.createElement("li");
    empty.className = "meeting-line is-empty";
    empty.textContent =
      meeting.state === "recording" ? "Listening…" : "Nothing was transcribed in this meeting.";
    element.lines.append(empty);
  } else if (shown.length === 0) {
    const empty = document.createElement("li");
    empty.className = "meeting-line is-empty";
    empty.textContent = "No line matches that.";
    element.lines.append(empty);
  }
  // A live transcript keeps the newest line in view.
  if (meeting.state === "recording" && !query) {
    element.lines.lastElementChild?.scrollIntoView({ block: "nearest" });
  }
}

/** The text with every match wrapped, as nodes rather than markup. */
function highlight(text: string, query: string): (string | HTMLElement)[] {
  if (!query) return [text];
  const parts: (string | HTMLElement)[] = [];
  const lowered = text.toLowerCase();
  let from = 0;
  while (from < text.length) {
    const at = lowered.indexOf(query, from);
    if (at === -1) break;
    parts.push(text.slice(from, at));
    const mark = document.createElement("mark");
    mark.textContent = text.slice(at, at + query.length);
    parts.push(mark);
    from = at + query.length;
  }
  parts.push(text.slice(from));
  return parts;
}

function transcriptText(given: MeetingDetail): string {
  return given.lines
    .map((line) => `[${clock(line.startMs)}] ${speakerName(line.speaker, given.meeting)}: ${line.text}`)
    .join("\n");
}

// --- Summary -----------------------------------------------------------------

function renderSummary(): void {
  if (!detail) return;
  const { meeting, summary } = detail;
  element.summary.replaceChildren();
  if (meeting.state === "recording") {
    element.summary.hidden = true;
    return;
  }
  element.summary.hidden = false;

  const head = document.createElement("div");
  head.className = "meeting-summary-head";
  const heading = document.createElement("h2");
  heading.className = "section-label";
  heading.textContent = "Summary";
  head.append(heading);

  if (summary) {
    const copyAll = document.createElement("button");
    copyAll.type = "button";
    copyAll.className = "pill-button is-small";
    copyAll.textContent = "Copy summary";
    copyAll.addEventListener("click", () => {
      void navigator.clipboard.writeText(meeting.summary ?? summaryText(summary));
      flash(copyAll, "Copied");
    });
    head.append(copyAll);
  }
  const again = document.createElement("button");
  again.type = "button";
  again.className = "pill-button is-small";
  again.textContent = summary ? "Regenerate" : "Summarise";
  again.disabled = meeting.state === "processing" || !status?.hasOpenRouterKey;
  again.title = status?.hasOpenRouterKey
    ? summary
      ? "Write the summary again, with the current speaker names"
      : "Write the summary"
    : "Add an OpenRouter API key in AI Polish first";
  again.addEventListener("click", () => {
    again.disabled = true;
    void host()
      .summarizeMeeting(meeting.id)
      .then((next) => {
        if (openId === next.meeting.id) {
          detail = next;
          renderDetail();
        }
      })
      .catch(showError)
      .finally(() => void reloadDetail());
  });
  head.append(again);
  element.summary.append(head);

  if (!summary) {
    const note = document.createElement("p");
    note.className = "meeting-summary-note";
    note.textContent =
      meeting.state === "processing"
        ? (meeting.stage ?? "Working…")
        : meeting.summary
          ? "The summary did not come back in the expected shape. The raw text is below."
          : status?.hasOpenRouterKey
            ? "No summary yet."
            : "Add an OpenRouter API key in AI Polish, then press Summarise.";
    element.summary.append(note);
    if (meeting.summary) {
      const raw = document.createElement("pre");
      raw.className = "meeting-summary-raw";
      raw.textContent = meeting.summary;
      element.summary.append(raw);
    }
    return;
  }

  const overview = document.createElement("p");
  overview.className = "meeting-overview";
  overview.textContent = summary.overview;
  element.summary.append(summarySection(null, [summary.overview], overview));

  for (const topic of summary.topics) {
    element.summary.append(summarySection(topic.heading, topic.points));
  }
  element.summary.append(summarySection("Next Steps", summary.nextSteps));
  element.summary.append(summarySection("Decisions Made", summary.decisions));
}

/** A heading, its points, and a copy button for just this part. */
function summarySection(heading: string | null, points: string[], body?: HTMLElement): HTMLElement {
  const section = document.createElement("section");
  section.className = "summary-section";
  const top = document.createElement("div");
  top.className = "summary-section-head";
  if (heading) {
    const title = document.createElement("h3");
    title.textContent = heading;
    top.append(title);
  }
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "meeting-line-copy";
  copy.textContent = "Copy";
  copy.title = heading ? `Copy ${heading}` : "Copy the overview";
  copy.addEventListener("click", () => {
    const text = heading ? `${heading}\n${points.map((point) => `- ${point}`).join("\n")}` : points.join("\n");
    void navigator.clipboard.writeText(text);
    flash(copy, "Copied");
  });
  top.append(copy);
  section.append(top);
  if (body) {
    section.append(body);
  } else {
    const list = document.createElement("ul");
    for (const point of points) {
      const item = document.createElement("li");
      item.textContent = point;
      list.append(item);
    }
    section.append(list);
  }
  return section;
}

function summaryText(summary: MeetingSummary): string {
  const blocks = [summary.overview];
  for (const topic of summary.topics) {
    blocks.push(`${topic.heading}\n${topic.points.map((point) => `- ${point}`).join("\n")}`);
  }
  blocks.push(`Next Steps\n${summary.nextSteps.map((step) => `- ${step}`).join("\n")}`);
  blocks.push(`Decisions Made\n${summary.decisions.map((decision) => `- ${decision}`).join("\n")}`);
  return blocks.join("\n\n");
}

// --- Playback ----------------------------------------------------------------

async function ensurePlayback(): Promise<HTMLAudioElement | null> {
  if (!detail) return null;
  if (playback) return playback.audio;
  const bytes = await host().getMeetingAudio(detail.meeting.id);
  const copy = new Uint8Array(bytes);
  const url = URL.createObjectURL(new Blob([copy], { type: "audio/wav" }));
  const audio = new Audio(url);
  audio.addEventListener("ended", () => {
    element.play.textContent = "Play";
  });
  audio.addEventListener("pause", () => {
    element.play.textContent = "Play";
  });
  audio.addEventListener("play", () => {
    element.play.textContent = "Pause";
  });
  playback = { audio, url };
  return audio;
}

async function togglePlay(): Promise<void> {
  try {
    const audio = await ensurePlayback();
    if (!audio) return;
    if (audio.paused) await audio.play();
    else audio.pause();
  } catch (error) {
    showError(error);
  }
}

async function playFrom(ms: number): Promise<void> {
  try {
    const audio = await ensurePlayback();
    if (!audio) return;
    audio.currentTime = ms / 1_000;
    await audio.play();
  } catch (error) {
    showError(error);
  }
}

function stopPlayback(): void {
  if (!playback) return;
  playback.audio.pause();
  URL.revokeObjectURL(playback.url);
  playback = null;
  element.play.textContent = "Play";
}

// --- Helpers -----------------------------------------------------------------

function showError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  element.stage.hidden = false;
  element.stage.className = "meeting-stage is-failed";
  element.stage.textContent = message;
}

function flash(button: HTMLButtonElement, text: string): void {
  const was = button.textContent;
  button.textContent = text;
  button.disabled = true;
  setTimeout(() => {
    button.textContent = was;
    button.disabled = false;
  }, 1_100);
}

function clock(ms: number): string {
  const seconds = Math.floor(ms / 1_000);
  const h = Math.floor(seconds / 3_600);
  const m = Math.floor((seconds % 3_600) / 60);
  const s = seconds % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${String(s).padStart(2, "0")}` : `${mm}:${String(s).padStart(2, "0")}`;
}

function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return `${Math.round(ms / 1_000)} s`;
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
}

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
}

export type { MeetingLine };
