import type {
  DiarizerInstallEvent,
  Meeting,
  MeetingDetail,
  MeetingLevelEvent,
  MeetingNote,
  MeetingSummary,
  RecorderStatus,
} from "../../shared/contracts";
import { host } from "../host";
import { requireElement } from "../ui/dom";
import { clock, duration, formatBytes } from "../ui/format";

/**
 * The Meetings page: a list of recordings, and one open at a time with its
 * summary and transcript.
 *
 * The host does the recording and transcribing; this file only shows what
 * it reports and asks it for changes. Nothing here has to survive the
 * window closing, because nothing here is the recording.
 *
 * One rule shapes the page: a live microphone is never a surprise. While a
 * meeting records, the header button is Stop with a running clock, the list
 * pins the recording row with its own Stop, and the detail shows that audio
 * is actually being heard.
 */

interface Options {
  /** Opens another page, for "add a key in AI Polish". */
  openView(view: string): void;
  /** Says something briefly, at the bottom of the window. */
  toast(message: string, options?: { tone?: "error"; action?: { label: string; run(): void } }): void;
  /** Whether the first-run note has been shown, and marking it so. */
  introSeen(): boolean;
  markIntroSeen(): void;
}

const element = {
  search: requireElement<HTMLInputElement>("meetings-search"),
  record: requireElement<HTMLButtonElement>("meeting-record"),
  intro: requireElement<HTMLElement>("meeting-intro"),
  introStart: requireElement<HTMLButtonElement>("meeting-intro-start"),
  introCancel: requireElement<HTMLButtonElement>("meeting-intro-cancel"),
  empty: requireElement<HTMLElement>("meetings-empty"),
  emptyRecord: requireElement<HTMLButtonElement>("meetings-empty-record"),
  emptySetup: requireElement<HTMLElement>("meetings-empty-setup"),
  list: requireElement<HTMLElement>("meetings-list"),
  noMatch: requireElement<HTMLElement>("meetings-no-match"),
  detail: requireElement<HTMLElement>("meeting-detail"),
  back: requireElement<HTMLButtonElement>("meeting-back"),
  title: requireElement<HTMLInputElement>("meeting-title"),
  band: requireElement<HTMLElement>("meeting-band"),
  banners: requireElement<HTMLElement>("meeting-banners"),
  summary: requireElement<HTMLElement>("meeting-summary"),
  transcriptHead: requireElement<HTMLElement>("meeting-transcript-head"),
  transcriptNote: requireElement<HTMLElement>("meeting-transcript-note"),
  find: requireElement<HTMLInputElement>("meeting-find"),
  speakers: requireElement<HTMLElement>("meeting-speakers"),
  speakersPrompt: requireElement<HTMLElement>("meeting-speakers-prompt"),
  lines: requireElement<HTMLOListElement>("meeting-lines"),
};

let options: Options = {
  openView: () => {},
  toast: () => {},
  introSeen: () => true,
  markIntroSeen: () => {},
};
let status: RecorderStatus | null = null;
let meetings: Meeting[] = [];
let openId: string | null = null;
let detail: MeetingDetail | null = null;
let playback: { audio: HTMLAudioElement; url: string } | null = null;
let ticker: number | null = null;
let installing: DiarizerInstallEvent | null = null;
let level: MeetingLevelEvent | null = null;
/** When the recording began, by the host's clock, for the live timer. */
let recordingSince: number | null = null;
/** Whether the "names changed, rewrite?" bar should show. */
let namesChanged = false;
/** Set while Stop is in flight so the button cannot be pressed twice. */
let stopping = false;

export function bindMeetings(given: Options): void {
  options = given;

  element.record.addEventListener("click", () => void onRecordButton());
  element.emptyRecord.addEventListener("click", () => void onRecordButton());
  element.introStart.addEventListener("click", () => {
    options.markIntroSeen();
    hideIntro();
    void record();
  });
  element.introCancel.addEventListener("click", hideIntro);
  element.back.addEventListener("click", () => openMeeting(null));
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
  host().onMeetingLevel((event) => {
    level = event;
    if (detail && detail.meeting.id === event.meetingId && detail.meeting.state === "recording") {
      renderBand();
    }
  });
  host().onMeetingState((event) => {
    recordingSince = event.recording ? (event.startedAt ?? Date.now()) : null;
    if (!event.recording) level = null;
    renderRecordButton();
    renderList();
  });
  host().onDiarizerInstall((event) => {
    installing = event.stage === "downloading" ? event : null;
    if (event.stage === "ready") {
      options.toast("Speaker tagging is ready.");
    } else if (event.stage === "error") {
      options.toast(event.message, { tone: "error" });
    }
    if (event.stage !== "downloading") void refreshStatus();
    renderEmpty();
    renderBanners();
    renderTranscriptNote();
  });
  host().onOpenMeetings((mode) => {
    if (mode === "record") {
      void onRecordButton();
    } else if (status?.recording) {
      openMeeting(status.recording);
    }
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

/** For the strip on other pages: open the live meeting. */
export function openRecordingMeeting(): void {
  if (status?.recording) openMeeting(status.recording);
}

/** For the strip and the HUD: stop whatever is recording. */
export async function stopRecording(): Promise<void> {
  await stop();
}

// --- Data --------------------------------------------------------------------

async function refreshStatus(): Promise<void> {
  try {
    status = await host().meetingRecorderStatus();
    if (status.recording) {
      const known = meetings.find((meeting) => meeting.id === status?.recording);
      recordingSince = recordingSince ?? known?.createdAt ?? Date.now();
    } else {
      recordingSince = null;
    }
  } catch {
    status = null;
  }
  renderRecordButton();
  renderEmpty();
  renderBanners();
  renderTranscriptNote();
  renderSummary();
}

async function refreshList(): Promise<void> {
  try {
    meetings = await host().listMeetings();
  } catch (error) {
    showError(error);
    return;
  }
  renderList();
  renderEmpty();
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
  renderEmpty();
  if (detail && detail.meeting.id === meeting.id) {
    detail.meeting = meeting;
    renderDetail();
  }
  renderRecordButton();
}

// --- Recording ---------------------------------------------------------------

async function onRecordButton(): Promise<void> {
  if (status?.recording) {
    await stop();
    return;
  }
  if (!options.introSeen()) {
    showIntro();
    return;
  }
  await record();
}

function showIntro(): void {
  element.intro.hidden = false;
  element.introStart.focus();
}

function hideIntro(): void {
  element.intro.hidden = true;
}

async function record(): Promise<void> {
  element.record.disabled = true;
  try {
    const meeting = await host().startMeeting();
    recordingSince = meeting.createdAt;
    applyMeeting(meeting);
    detail = { meeting, lines: [], summary: null };
    openId = meeting.id;
    namesChanged = false;
    openMeeting(meeting.id);
    element.title.focus();
  } catch (error) {
    showError(error);
  } finally {
    element.record.disabled = false;
    renderRecordButton();
  }
}

async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  renderRecordButton();
  renderBand();
  try {
    applyMeeting(await host().stopMeeting());
  } catch (error) {
    showError(error);
  } finally {
    stopping = false;
    renderRecordButton();
    renderBand();
  }
}

async function discard(): Promise<void> {
  if (!detail || detail.meeting.state !== "recording") return;
  const elapsed = recordingSince ? clock(Date.now() - recordingSince) : "";
  if (!window.confirm(`Throw this recording away?${elapsed ? ` The ${elapsed} recorded so far will be deleted.` : ""}`)) {
    return;
  }
  try {
    await host().cancelMeeting();
    openMeeting(null);
    await refreshList();
  } catch (error) {
    showError(error);
  }
}

async function remove(meeting: Meeting): Promise<void> {
  if (!window.confirm(`Delete “${meeting.title}” and its recording? This cannot be undone.`)) return;
  try {
    await host().deleteMeeting(meeting.id);
    if (openId === meeting.id) openMeeting(null);
    await refreshList();
  } catch (error) {
    showError(error);
  }
}

// --- Header ------------------------------------------------------------------

function renderRecordButton(): void {
  const recording = Boolean(status?.recording);
  element.record.classList.toggle("is-stop", recording);
  element.record.classList.toggle("is-primary", !recording);
  element.record.disabled = stopping;
  element.record.textContent = stopping
    ? "Stopping…"
    : recording
      ? `■ Stop ${recordingSince ? clock(Date.now() - recordingSince) : ""}`.trim()
      : "Record";
  element.record.title = recording ? "Stop recording and keep it" : "Record a meeting";
  if (recording) startTicker();
  else if (!detail || detail.meeting.state !== "recording") stopTicker();
}

function startTicker(): void {
  if (ticker !== null) return;
  ticker = window.setInterval(() => {
    renderRecordButton();
    if (detail?.meeting.state === "recording") renderBand();
    renderList();
  }, 500);
}

function stopTicker(): void {
  if (ticker === null) return;
  window.clearInterval(ticker);
  ticker = null;
}

// --- Empty state / first run -------------------------------------------------

function renderEmpty(): void {
  const show = meetings.length === 0 && openId === null;
  element.empty.hidden = !show;
  if (!show) return;
  element.emptySetup.replaceChildren();
  if (!status) return;

  const rows: HTMLElement[] = [];
  if (status.systemAudio === "available") {
    rows.push(
      setupRow(
        "Hear the other side of the call",
        "macOS asks once, the first time you record. Allow Waveform under Screen & System Audio Recording.",
      ),
    );
  } else if (status.systemAudio === "unsupported") {
    rows.push(
      setupRow(
        "Hear the other side of the call",
        "Needs macOS 14.2 or later; until then only your microphone is recorded.",
      ),
    );
  } else {
    rows.push(setupRow("Your microphone only", "This copy of Waveform can only record your microphone."));
  }
  if (!status.diarizerInstalled) {
    rows.push(diarizerRow("Tell speakers apart", `A ${formatBytes(status.diarizerBytes)} download, kept on this Mac. Without it, everyone else on the call is one voice.`));
  }
  if (!status.hasOpenRouterKey) {
    const row = setupRow(
      "Write a summary",
      "Summaries use OpenRouter and need a key. Transcripts never leave this Mac; the summary sends only the text.",
    );
    row.append(linkButton("Add key", () => options.openView("ai")));
    rows.push(row);
  }
  element.emptySetup.append(...rows);
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

/** The speaker-tool row, with its download button or progress. */
function diarizerRow(title: string, detailText: string): HTMLElement {
  const row = setupRow(title, installing ? installing.message : detailText);
  row.append(diarizerButton());
  return row;
}

function diarizerButton(): HTMLButtonElement {
  const action = document.createElement("button");
  action.type = "button";
  action.className = "pill-button is-primary";
  if (installing) {
    action.textContent = `${Math.round(installing.progress * 100)}% · Cancel`;
    action.classList.remove("is-primary");
    action.addEventListener("click", () => void host().cancelDiarizerInstall());
  } else {
    action.textContent = "Download";
    action.addEventListener("click", () => {
      installing = { stage: "downloading", message: "Starting…", progress: 0 };
      renderEmpty();
      renderBanners();
      renderTranscriptNote();
      void host()
        .installDiarizer()
        .catch(showError)
        .finally(() => void refreshStatus());
    });
  }
  return action;
}

function linkButton(label: string, run: () => void, primary = false): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = primary ? "pill-button is-primary" : "pill-button";
  button.textContent = label;
  button.addEventListener("click", run);
  return button;
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
  // The recording row first, whatever the dates say.
  const ordered = [...shown].sort((a, b) => Number(b.state === "recording") - Number(a.state === "recording"));

  element.list.replaceChildren(...ordered.map(renderListRow));
  element.list.hidden = openId !== null || meetings.length === 0;
  element.noMatch.hidden = openId !== null || meetings.length === 0 || shown.length > 0;
}

function renderListRow(meeting: Meeting): HTMLElement {
  const row = document.createElement("div");
  row.className = `meeting-row is-${meeting.state}`;
  row.tabIndex = 0;
  row.setAttribute("role", "button");
  const open = () => openMeeting(meeting.id);
  row.addEventListener("click", open);
  row.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open();
    }
  });

  const title = document.createElement("span");
  title.className = "meeting-row-title";
  if (meeting.state === "recording") {
    const dot = document.createElement("span");
    dot.className = "recording-dot";
    title.append(dot);
  }
  title.append(meeting.title);

  const meta = document.createElement("span");
  meta.className = "meeting-row-meta";
  meta.textContent = rowMeta(meeting);

  const lede = document.createElement("span");
  lede.className = "meeting-row-lede";
  lede.textContent = rowLede(meeting);

  row.append(title, meta, lede);

  if (meeting.state === "recording") {
    const stopButton = linkButton("Stop", () => void stop());
    stopButton.className = "pill-button is-stop is-small";
    stopButton.addEventListener("click", (event) => event.stopPropagation());
    row.append(stopButton);
  } else {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "meeting-row-more";
    more.title = "Delete";
    more.setAttribute("aria-label", `Delete ${meeting.title}`);
    more.textContent = "Delete";
    more.addEventListener("click", (event) => {
      event.stopPropagation();
      void remove(meeting);
    });
    row.append(more);
  }
  return row;
}

function rowMeta(meeting: Meeting): string {
  const when = new Date(meeting.createdAt).toLocaleString([], {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  });
  if (meeting.state === "recording") {
    return `Recording · ${clock(Date.now() - (recordingSince ?? meeting.createdAt))}`;
  }
  return [when, duration(meeting.durationMs)].join(" · ");
}

function rowLede(meeting: Meeting): string {
  switch (meeting.state) {
    case "recording":
      return "";
    case "processing":
      return "Finishing up…";
    case "failed":
      return meeting.notes.some((note) => note.kind === "interrupted") ? "Interrupted" : (meeting.stage ?? "Stopped early");
    default: {
      const overview = meeting.summary?.split("\n").find((line) => line.trim());
      if (overview) return overview;
      if (meeting.notes.some((note) => note.kind === "other-side-not-heard")) return "Your side only";
      if (meeting.notes.some((note) => note.kind === "nothing-said")) return "Nothing was picked up";
      return "";
    }
  }
}

// --- One meeting -------------------------------------------------------------

function openMeeting(id: string | null): void {
  stopPlayback();
  openId = id;
  detail = null;
  namesChanged = false;
  element.detail.hidden = id === null;
  element.find.value = "";
  renderList();
  renderEmpty();
  if (id) {
    const known = meetings.find((meeting) => meeting.id === id);
    if (known) {
      detail = { meeting: known, lines: [], summary: null };
      renderDetail();
    }
    void reloadDetail();
  } else if (!status?.recording) {
    stopTicker();
  }
}

function renderDetail(): void {
  if (!detail) return;
  if (document.activeElement !== element.title) element.title.value = detail.meeting.title;
  renderBand();
  renderBanners();
  renderSummary();
  renderTranscriptNote();
  renderSpeakers();
  renderLines();
  if (detail.meeting.state === "recording") startTicker();
}

/** The band under the title: the one place that says what is happening. */
function renderBand(): void {
  if (!detail) return;
  const { meeting } = detail;
  const band = element.band;
  band.replaceChildren();
  band.className = `meeting-band is-${meeting.state}`;

  if (meeting.state === "recording") {
    const elapsed = clock(Date.now() - (recordingSince ?? meeting.createdAt));
    const left = document.createElement("div");
    left.className = "band-left";
    const dot = document.createElement("span");
    dot.className = "recording-dot";
    const label = document.createElement("strong");
    label.textContent = `Recording · ${elapsed}`;
    left.append(dot, label);

    const meters = document.createElement("div");
    meters.className = "band-meters";
    meters.append(meter("You", level?.mic ?? 0));
    if (status?.systemAudio === "available" && meeting.hasSystemAudio) {
      meters.append(meter("Other side", level?.system ?? 0, level ? !level.otherHeard && level.elapsedMs > 5_000 : false));
    } else {
      const only = document.createElement("span");
      only.className = "band-note";
      only.textContent = "Only your microphone is being recorded.";
      meters.append(only);
    }

    const actions = document.createElement("div");
    actions.className = "band-actions";
    const stopButton = linkButton(stopping ? "Stopping…" : "■ Stop", () => void stop());
    stopButton.className = "pill-button is-stop";
    stopButton.disabled = stopping;
    const discardButton = document.createElement("button");
    discardButton.type = "button";
    discardButton.className = "link band-discard";
    discardButton.textContent = "Discard";
    discardButton.addEventListener("click", () => void discard());
    actions.append(stopButton, discardButton);
    band.append(left, meters, actions);
    return;
  }

  if (meeting.state === "processing") {
    const steps = ["Finishing the last phrases", "Tagging speakers", "Preparing playback", "Writing the summary"];
    const current = (meeting.stage ?? "").replace(/…$/, "");
    const currentIndex = steps.findIndex((step) => current.startsWith(step));
    const list = document.createElement("ol");
    list.className = "band-steps";
    steps.forEach((step, index) => {
      const item = document.createElement("li");
      const state = currentIndex === -1 ? "pending" : index < currentIndex ? "done" : index === currentIndex ? "now" : "pending";
      item.dataset.state = state;
      item.textContent = state === "done" ? `✓ ${step}` : state === "now" ? `${step}…` : step;
      list.append(item);
    });
    const sub = document.createElement("span");
    sub.className = "band-note";
    sub.textContent = "Usually under a minute. You can leave this page.";
    band.append(list, sub);
    return;
  }

  // Ready or failed: facts and actions.
  const facts = document.createElement("span");
  facts.className = "band-facts";
  const speakers = new Set(detail.lines.map((line) => line.speaker).filter(Boolean));
  facts.textContent = [
    duration(meeting.durationMs),
    speakers.size > 0 ? `${speakers.size} ${speakers.size === 1 ? "speaker" : "speakers"}` : null,
    new Date(meeting.createdAt).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }),
  ]
    .filter(Boolean)
    .join(" · ");

  const actions = document.createElement("div");
  actions.className = "band-actions";
  const play = linkButton(playback && !playback.audio.paused ? "❚❚ Pause" : "▶ Play", () => void togglePlay());
  play.id = "meeting-play";
  const copy = copyMenu();
  const more = dropdown("…", "More", [
    { label: "Rename", run: () => { element.title.focus(); element.title.select(); } },
    { label: "Rewrite summary", run: () => void rewriteSummary(), disabled: !status?.hasOpenRouterKey },
    { label: "Delete meeting…", run: () => void remove(meeting), danger: true },
  ]);
  actions.append(play, copy, more);
  band.append(facts, actions);
}

interface DropdownItem {
  label: string;
  run(): void;
  disabled?: boolean;
  danger?: boolean;
}

/** A pill that opens a small menu beneath it; closes on choice or click away. */
function dropdown(label: string, aria: string, items: DropdownItem[]): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "copy-menu";
  const button = linkButton(label, () => wrap.classList.toggle("is-open"));
  button.setAttribute("aria-label", aria);
  button.setAttribute("aria-haspopup", "menu");
  const menu = document.createElement("div");
  menu.className = "copy-menu-list";
  menu.setAttribute("role", "menu");
  for (const item of items) {
    const entry = document.createElement("button");
    entry.type = "button";
    entry.setAttribute("role", "menuitem");
    entry.textContent = item.label;
    entry.disabled = Boolean(item.disabled);
    if (item.danger) entry.classList.add("is-danger");
    entry.addEventListener("click", () => {
      wrap.classList.remove("is-open");
      item.run();
    });
    menu.append(entry);
  }
  wrap.append(button, menu);
  document.addEventListener(
    "click",
    (event) => {
      if (!wrap.contains(event.target as Node)) wrap.classList.remove("is-open");
    },
    { capture: true },
  );
  return wrap;
}

/** A labelled level bar; `warn` marks a track that should be heard and is not. */
function meter(label: string, value: number, warn = false): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = `band-meter${warn ? " is-warn" : ""}`;
  const name = document.createElement("span");
  name.className = "band-meter-label";
  name.textContent = label;
  const track = document.createElement("span");
  track.className = "band-meter-track";
  const fill = document.createElement("span");
  fill.className = "band-meter-fill";
  // RMS to a bar: speech sits around 0.02–0.1, so a square root gives it room.
  fill.style.width = `${Math.min(100, Math.round(Math.sqrt(Math.min(1, value * 4)) * 100))}%`;
  track.append(fill);
  wrap.append(name, track);
  return wrap;
}

/** Copy ▾: summary, transcript, or both. */
function copyMenu(): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "copy-menu";
  const button = linkButton("Copy ▾", () => {
    wrap.classList.toggle("is-open");
  });
  const menu = document.createElement("div");
  menu.className = "copy-menu-list";
  menu.setAttribute("role", "menu");
  const item = (label: string, text: () => string | null) => {
    const entry = document.createElement("button");
    entry.type = "button";
    entry.setAttribute("role", "menuitem");
    entry.textContent = label;
    const value = text();
    entry.disabled = value === null;
    entry.addEventListener("click", () => {
      wrap.classList.remove("is-open");
      const current = text();
      if (current === null) return;
      void navigator.clipboard.writeText(current);
      options.toast(`${label.replace("Copy ", "")} copied`);
    });
    return entry;
  };
  menu.append(
    item("Copy summary", () => (detail?.meeting.summary ? summaryTextOf(detail) : null)),
    item("Copy transcript", () => (detail && detail.lines.length > 0 ? transcriptText(detail) : null)),
    item("Copy both", () =>
      detail && detail.lines.length > 0
        ? [detail.meeting.summary ? summaryTextOf(detail) : null, "Transcript", transcriptText(detail)].filter(Boolean).join("\n\n")
        : null,
    ),
  );
  wrap.append(button, menu);
  document.addEventListener(
    "click",
    (event) => {
      if (!wrap.contains(event.target as Node)) wrap.classList.remove("is-open");
    },
    { capture: true },
  );
  return wrap;
}

// --- Banners from notes --------------------------------------------------------

function renderBanners(): void {
  if (!detail) return;
  const { meeting } = detail;
  element.banners.replaceChildren();
  if (meeting.state === "recording") return;

  for (const note of meeting.notes) {
    const banner = bannerFor(note, meeting);
    if (banner) element.banners.append(banner);
  }
  if (meeting.state === "failed" && !meeting.notes.some((note) => note.kind === "interrupted")) {
    element.banners.append(
      banner("error", "Something went wrong while finishing this meeting.", meeting.stage ?? "", [
        linkButton("Try again", () => void finish(meeting), true),
      ]),
    );
  }
}

function bannerFor(note: MeetingNote, meeting: Meeting): HTMLElement | null {
  switch (note.kind) {
    case "interrupted":
      return banner(
        "warn",
        "Waveform closed while this was recording.",
        `Everything up to ${clock(meeting.durationMs)} was kept. Speakers and the summary have not been done yet.`,
        [linkButton("Finish this meeting", () => void finish(meeting), true)],
      );
    case "other-side-not-heard":
      return banner(
        "warn",
        "The other side of the call wasn't recorded.",
        "macOS hadn't given Waveform permission to hear it. Allow it once under Screen & System Audio Recording and the next recording will have both sides.",
        [linkButton("Open System Settings", openAudioCaptureSettings)],
      );
    case "nothing-said":
      return banner("info", "Nothing was picked up in this recording.", "", [
        linkButton("Delete", () => void remove(meeting)),
      ]);
    // These three are shown where they matter: in the summary or transcript.
    case "no-summary-key":
    case "summary-failed":
    case "summary-unparsed":
    case "speaker-tool-missing":
      return null;
    default:
      return banner("info", note.text, "", []);
  }
}

function banner(tone: "info" | "warn" | "error", title: string, body: string, actions: HTMLElement[]): HTMLElement {
  const box = document.createElement("div");
  box.className = `meeting-banner is-${tone}`;
  const text = document.createElement("div");
  text.className = "meeting-banner-text";
  const strong = document.createElement("strong");
  strong.textContent = title;
  text.append(strong);
  if (body) {
    const small = document.createElement("span");
    small.textContent = body;
    text.append(small);
  }
  box.append(text);
  if (actions.length > 0) {
    const row = document.createElement("div");
    row.className = "meeting-banner-actions";
    row.append(...actions);
    box.append(row);
  }
  return box;
}

function openAudioCaptureSettings(): void {
  void host()
    .openUrl("x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture")
    .catch(showError);
}

async function finish(meeting: Meeting): Promise<void> {
  try {
    await host().finishMeeting(meeting.id);
    options.toast("Finishing the meeting…");
  } catch (error) {
    showError(error);
  }
}

// --- Summary -----------------------------------------------------------------

function renderSummary(): void {
  if (!detail) return;
  const { meeting, summary } = detail;
  element.summary.replaceChildren();
  element.summary.hidden = meeting.state === "recording";
  if (meeting.state === "recording") return;

  const head = document.createElement("div");
  head.className = "meeting-summary-head";
  const heading = document.createElement("h2");
  heading.className = "section-label";
  heading.textContent = "Summary";
  head.append(heading);
  element.summary.append(head);

  const noteOf = (kind: string) => meeting.notes.find((note) => note.kind === kind);

  if (meeting.state === "processing") {
    const skeleton = document.createElement("div");
    skeleton.className = "summary-skeleton";
    skeleton.setAttribute("aria-label", "Summary is being written");
    skeleton.append(...[0, 1, 2].map(() => document.createElement("span")));
    element.summary.append(skeleton);
    return;
  }

  if (namesChanged && summary) {
    element.summary.append(
      banner("info", "Names changed.", "Rewrite the summary with them?", [
        linkButton("Rewrite", () => void rewriteSummary(), true),
        linkButton("Not now", () => {
          namesChanged = false;
          renderSummary();
        }),
      ]),
    );
  }

  if (!summary) {
    if (noteOf("no-summary-key") || !status?.hasOpenRouterKey) {
      element.summary.append(
        banner("info", "No summary yet.", "Summaries need an OpenRouter key; the transcript stays on this Mac.", [
          linkButton("Add key", () => options.openView("ai"), true),
        ]),
      );
    } else if (noteOf("summary-failed")) {
      element.summary.append(
        banner("error", "The summary didn't come through.", noteOf("summary-failed")?.text ?? "", [
          linkButton("Try again", () => void rewriteSummary(), true),
        ]),
      );
    } else if (noteOf("nothing-said")) {
      // The banner above already says so.
    } else if (meeting.summary) {
      // Text came back but not in the usual layout.
      const label = document.createElement("p");
      label.className = "meeting-summary-note";
      label.textContent = "Shown as it came back.";
      const raw = document.createElement("pre");
      raw.className = "meeting-summary-raw";
      raw.textContent = meeting.summary;
      element.summary.append(label, raw, linkButton("Try again", () => void rewriteSummary()));
    } else {
      element.summary.append(
        banner("info", "No summary yet.", "", [linkButton("Write summary", () => void rewriteSummary(), true)]),
      );
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
  element.summary.append(summarySection("Next steps", summary.nextSteps));
  element.summary.append(summarySection("Decisions", summary.decisions));
}

async function rewriteSummary(): Promise<void> {
  if (!detail) return;
  namesChanged = false;
  try {
    const next = await host().summarizeMeeting(detail.meeting.id);
    if (openId === next.meeting.id) {
      detail = next;
      renderDetail();
    }
    options.toast("Summary written.");
  } catch (error) {
    showError(error);
    void reloadDetail();
  }
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

function summaryTextOf(given: MeetingDetail): string {
  if (given.summary) return summaryText(given.summary);
  return given.meeting.summary ?? "";
}

function summaryText(summary: MeetingSummary): string {
  const blocks = [summary.overview];
  for (const topic of summary.topics) {
    blocks.push(`${topic.heading}\n${topic.points.map((point) => `- ${point}`).join("\n")}`);
  }
  blocks.push(`Next steps\n${summary.nextSteps.map((step) => `- ${step}`).join("\n")}`);
  blocks.push(`Decisions\n${summary.decisions.map((decision) => `- ${decision}`).join("\n")}`);
  return blocks.join("\n\n");
}

// --- Transcript --------------------------------------------------------------

/** One line in the transcript header when speakers could not be told apart. */
function renderTranscriptNote(): void {
  if (!detail) return;
  const { meeting } = detail;
  element.transcriptNote.replaceChildren();
  const missing = meeting.notes.find((note) => note.kind === "speaker-tool-missing");
  element.transcriptNote.hidden = !missing || meeting.state === "recording";
  if (!missing || meeting.state === "recording") return;
  const text = document.createElement("span");
  text.textContent = installing ? installing.message : "Everyone else is shown as one speaker.";
  element.transcriptNote.append(text);
  if (status?.diarizerInstalled) {
    element.transcriptNote.append(
      linkButton("Tag speakers now", () => {
        void host()
          .tagMeetingSpeakers(meeting.id)
          .then(() => options.toast("Tagging speakers…"))
          .catch(showError);
      }, true),
    );
  } else {
    const button = diarizerButton();
    if (!installing) button.textContent = `Tell speakers apart (${formatBytes(status?.diarizerBytes ?? 0)})`;
    element.transcriptNote.append(button);
  }
}

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
  const unnamed = labels.filter((label) => label !== "me" && !meeting.speakers[label]);
  element.speakersPrompt.hidden = meeting.state === "recording" || unnamed.length === 0;
  element.speakersPrompt.textContent = "Who was on the call? Click a name to change it.";

  element.speakers.replaceChildren(
    ...labels.map((label) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = `speaker-chip ${speakerClass(label)}${meeting.speakers[label] || label === "me" ? "" : " is-unnamed"}`;
      chip.textContent = `✎ ${speakerName(label, meeting)}`;
      chip.title = "Click to rename";
      chip.disabled = meeting.state === "recording" && label !== "me";
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
  const finishEdit = (save: boolean) => {
    if (settled) return;
    settled = true;
    const name = field.value.trim();
    field.replaceWith(chip);
    if (!save || name === speakerName(label, meeting)) return;
    void host()
      .renameMeetingSpeaker(meeting.id, label, name)
      .then((next) => {
        namesChanged = Boolean(detail?.summary);
        applyMeeting(next);
      })
      .catch(showError);
  };
  field.addEventListener("keydown", (event) => {
    if (event.key === "Enter") finishEdit(true);
    if (event.key === "Escape") finishEdit(false);
  });
  field.addEventListener("blur", () => finishEdit(true));
}

function speakerClass(label: string): string {
  if (label === "me") return "is-me";
  const match = /^speaker_(\d+)$/.exec(label);
  return match ? `is-s${Number(match[1]) % 6}` : "";
}

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
      meeting.state === "recording"
        ? "Listening. Lines appear a few seconds after each sentence ends."
        : meeting.state === "processing"
          ? "Finishing the last phrases…"
          : "Nothing was picked up in this recording.";
    element.lines.append(empty);
  } else if (shown.length === 0) {
    const empty = document.createElement("li");
    empty.className = "meeting-line is-empty";
    empty.textContent = "No line matches that.";
    element.lines.append(empty);
  }
  if (meeting.state === "recording" && !query) {
    element.lines.lastElementChild?.scrollIntoView({ block: "nearest" });
  }
}

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

// --- Playback ----------------------------------------------------------------

async function ensurePlayback(): Promise<HTMLAudioElement | null> {
  if (!detail) return null;
  if (playback) return playback.audio;
  const bytes = await host().getMeetingAudio(detail.meeting.id);
  const copy = new Uint8Array(bytes);
  const url = URL.createObjectURL(new Blob([copy], { type: "audio/wav" }));
  const audio = new Audio(url);
  for (const name of ["ended", "pause", "play"]) {
    audio.addEventListener(name, renderBand);
  }
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
}

// --- Helpers -----------------------------------------------------------------

function showError(error: unknown): void {
  options.toast(error instanceof Error ? error.message : String(error), { tone: "error" });
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
