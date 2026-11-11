import type {
  DiarizerInstallEvent,
  Meeting,
  MeetingDetail,
  MeetingLevelEvent,
  MeetingNote,
  MeetingSummary,
  RecorderStatus,
} from "../shared/contracts";
import { host } from "./host";
import { audioFileToMonoWav } from "./audio/file-wav";
import { onRowContextMenu } from "./context-menu";

/**
 * The Meetings page: one page at a time. The list, grouped by day, with an
 * overview beside it of the week and the next steps people took on; or the
 * open meeting, its summary, transcript and the user's own notes a tab apart,
 * with a box at the foot to ask about it.
 *
 * The host does the recording and transcribing; this file only shows what
 * it reports and asks it for changes. Nothing here has to survive the
 * window closing, because nothing here is the recording.
 *
 * One rule shapes the page: a live microphone is never a surprise. While a
 * meeting records, the header button is Stop with a running clock, the list
 * pins the recording row with its own Stop, and the open meeting is a calm
 * card with the clock and one unmistakable Stop.
 *
 * Nothing on the page is a timer pretending to be progress, and nothing is a
 * browser dialog: the web view has none, so every question -- delete this,
 * throw that away, keep this short one -- is asked inline, where it applies.
 */

interface Options {
  /** Opens Settings on AI Polish, for "add a key". */
  openAiPolish(): void;
  /** Says something briefly, at the bottom of the window. */
  toast(message: string, options?: { tone?: "error"; action?: { label: string; run(): void } }): void;
  /** Whether the first-run note has been shown, and marking it so. */
  introSeen(): boolean;
  markIntroSeen(): void;
  /** Whether an earlier launch heard the other side, and saying so. */
  otherSideAllowed(): boolean;
  rememberOtherSide(allowed: boolean): void;
}

const element = {
  view: byId<HTMLElement>("view-meetings"),
  search: byId<HTMLInputElement>("meetings-search"),
  record: byId<HTMLButtonElement>("meeting-record"),
  importButton: byId<HTMLButtonElement>("meeting-import"),
  importFile: byId<HTMLInputElement>("meeting-import-file"),
  intro: byId<HTMLElement>("meeting-intro"),
  introStart: byId<HTMLButtonElement>("meeting-intro-start"),
  introCancel: byId<HTMLButtonElement>("meeting-intro-cancel"),
  introClose: byId<HTMLButtonElement>("meeting-intro-close"),
  empty: byId<HTMLElement>("meetings-empty"),
  emptyRecord: byId<HTMLButtonElement>("meetings-empty-record"),
  emptySetup: byId<HTMLElement>("meetings-empty-setup"),
  permission: byId<HTMLElement>("meetings-permission"),
  shell: byId<HTMLElement>("meetings-shell"),
  list: byId<HTMLElement>("meetings-list"),
  noMatch: byId<HTMLElement>("meetings-no-match"),
  overview: byId<HTMLElement>("meetings-overview"),
  detail: byId<HTMLElement>("meeting-detail"),
  scroller: byId<HTMLElement>("meeting-scroll"),
  detailHead: byId<HTMLElement>("meeting-detail-head"),
  back: byId<HTMLButtonElement>("meeting-back"),
  prev: byId<HTMLButtonElement>("meeting-prev"),
  next: byId<HTMLButtonElement>("meeting-next"),
  window: byId<HTMLButtonElement>("meeting-window"),
  findToggle: byId<HTMLButtonElement>("meeting-find-toggle"),
  copyTranscript: byId<HTMLButtonElement>("meeting-copy-transcript"),
  speakersToggle: byId<HTMLButtonElement>("meeting-speakers-toggle"),
  title: byId<HTMLInputElement>("meeting-title"),
  actions: byId<HTMLElement>("meeting-actions"),
  meta: byId<HTMLElement>("meeting-meta"),
  progress: byId<HTMLButtonElement>("meeting-progress"),
  confirm: byId<HTMLElement>("meeting-confirm"),
  short: byId<HTMLElement>("meeting-short"),
  band: byId<HTMLElement>("meeting-band"),
  banners: byId<HTMLElement>("meeting-banners"),
  tabs: byId<HTMLElement>("meeting-tabs"),
  tabSummary: byId<HTMLButtonElement>("meeting-tab-summary"),
  tabTranscript: byId<HTMLButtonElement>("meeting-tab-transcript"),
  tabNotes: byId<HTMLButtonElement>("meeting-tab-notes"),
  tabCount: byId<HTMLElement>("meeting-tab-count"),
  summary: byId<HTMLElement>("meeting-summary"),
  transcript: byId<HTMLElement>("meeting-transcript"),
  transcriptHead: byId<HTMLElement>("meeting-transcript-head"),
  transcriptInfo: byId<HTMLElement>("meeting-transcript-info"),
  transcriptNote: byId<HTMLElement>("meeting-transcript-note"),
  find: byId<HTMLInputElement>("meeting-find"),
  speakers: byId<HTMLElement>("meeting-speakers"),
  speakersPrompt: byId<HTMLElement>("meeting-speakers-prompt"),
  lines: byId<HTMLOListElement>("meeting-lines"),
  notes: byId<HTMLElement>("meeting-notes"),
  memo: byId<HTMLTextAreaElement>("meeting-memo"),
  memoState: byId<HTMLElement>("meeting-memo-state"),
  ask: byId<HTMLElement>("meeting-ask"),
  answers: byId<HTMLOListElement>("meeting-answers"),
  askForm: byId<HTMLFormElement>("meeting-ask-form"),
  askInput: byId<HTMLInputElement>("meeting-ask-input"),
  askSend: byId<HTMLButtonElement>("meeting-ask-send"),
};

type Tab = "summary" | "transcript" | "notes";
const TABS: Tab[] = ["notes", "transcript", "summary"];

/** One question asked about a meeting, and its answer once it lands. */
interface Answer {
  question: string;
  answer: string | null;
  error: string | null;
}

/** A recording stopped under this is offered up for discarding. */
const SHORT_MS = 20_000;

let options: Options = {
  openAiPolish: () => {},
  toast: () => {},
  introSeen: () => true,
  markIntroSeen: () => {},
  otherSideAllowed: () => false,
  rememberOtherSide: () => {},
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
/** What the last permission check said; null until one has run. */
let otherSide: "heard" | "silent" | "unsupported" | "missing" | null = null;
let probing = false;
/** The ask above the list was waved away for this launch. */
let permissionDismissed = false;
/** The live card's moving parts, updated in place rather than rebuilt. */
let live: { key: string; clock: HTMLElement; dot: HTMLElement } | null = null;
/** Where focus should return when the first-run sheet closes. */
let introReturnTo: HTMLElement | null = null;
/** The tab the user chose this session; null means the page decides. */
let chosenTab: Tab | null = null;
/** Inline questions that are up. */
let confirmDelete = false;
let confirmDiscard = false;
/** Short recordings the user said to keep, for this launch. */
const shortKept = new Set<string>();
/** Questions asked this launch, by meeting. Nothing is saved. */
const answers = new Map<string, Answer[]>();
/** The notes typed but not yet saved, and the timer that will save them. */
let memoPending: { id: string; text: string; timer: number } | null = null;
/** The meeting the list should put focus back on when the page returns to it. */
let returnTo: string | null = null;
/** Whether the transcript's find field and speaker names are out. */
let findOpen = false;
let speakersOpen = false;
/** The meeting the panel beside the list is showing: the one pointed at or focused. */
let previewId: string | null = null;

export function bindMeetings(given: Options): void {
  options = given;

  element.record.addEventListener("click", () => void onRecordButton());
  element.emptyRecord.addEventListener("click", () => void onRecordButton());
  element.importButton.addEventListener("click", () => element.importFile.click());
  element.importFile.addEventListener("change", () => {
    const file = element.importFile.files?.[0];
    element.importFile.value = "";
    if (file) void importAudioFile(file);
  });
  element.introStart.addEventListener("click", () => void startFromIntro());
  element.introCancel.addEventListener("click", hideIntro);
  element.introClose.addEventListener("click", hideIntro);
  element.intro.addEventListener("click", (event) => {
    if (event.target === element.intro) hideIntro();
  });
  element.back.addEventListener("click", () => openMeeting(null));
  // Scrolled: the head slims down, so more of the meeting shows.
  element.scroller.addEventListener("scroll", () => {
    // Apart, so the head changing height does not flip it straight back.
    const top = element.scroller.scrollTop;
    if (top > 24) element.detail.classList.add("is-compact");
    else if (top < 4) element.detail.classList.remove("is-compact");
  });
  element.prev.addEventListener("click", () => step(-1));
  element.next.addEventListener("click", () => step(1));
  element.window.addEventListener("click", () => {
    if (openId) void host().showMeetingPanel(openId).catch(showError);
  });
  element.findToggle.addEventListener("click", () => {
    findOpen = !findOpen;
    if (!findOpen && element.find.value) {
      element.find.value = "";
      renderLines();
    }
    renderTranscriptTools();
    if (findOpen) element.find.focus();
  });
  element.copyTranscript.addEventListener("click", () => {
    if (!detail || detail.lines.length === 0) return;
    const text = transcriptText(detail);
    void navigator.clipboard
      .writeText(text)
      .then(() => options.toast("Transcript copied"))
      .catch(showError);
  });
  element.speakersToggle.addEventListener("click", () => {
    speakersOpen = !speakersOpen;
    renderTranscriptTools();
  });
  element.memo.addEventListener("input", onMemoInput);
  element.memo.addEventListener("blur", () => void flushMemo());
  element.askForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void ask();
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
    if (event.key === "Escape") {
      event.stopPropagation();
      if (detail) element.title.value = detail.meeting.title;
      element.title.blur();
    }
  });
  element.search.addEventListener("input", renderList);
  element.find.addEventListener("input", renderLines);
  element.progress.addEventListener("click", (event) => {
    if (!playback || !Number.isFinite(playback.audio.duration)) return;
    const box = element.progress.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
    playback.audio.currentTime = fraction * playback.audio.duration;
  });
  element.tabSummary.addEventListener("click", () => chooseTab("summary"));
  element.tabTranscript.addEventListener("click", () => chooseTab("transcript"));
  element.tabNotes.addEventListener("click", () => chooseTab("notes"));
  element.tabs.addEventListener("keydown", onTabKey);

  // One listener for every menu on the page, rather than one per menu built.
  document.addEventListener(
    "click",
    (event) => {
      if (!(event.target as HTMLElement).closest(".copy-menu")) closeMenus();
    },
    { capture: true },
  );
  document.addEventListener("keydown", onKey);

  host().onMeetingLine(({ meetingId, line }) => {
    if (!detail || detail.meeting.id !== meetingId) return;
    detail.lines.push(line);
    detail.lines.sort((a, b) => a.startMs - b.startMs || a.idx - b.idx);
    renderLines();
    renderSpeakers();
    if (detail.lines.length === 1) renderAsk();
  });
  host().onMeetingChanged((meeting) => {
    // A recording that heard nothing from the tap: macOS no longer allows
    // it, whatever an earlier check said.
    if (otherSide === "heard" && meeting.notes.some((note) => note.kind === "other-side-not-heard")) {
      otherSide = "silent";
      options.rememberOtherSide(false);
      renderPermissionAsk();
    }
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
    renderHead();
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

/** Whether the Meetings page is the one showing, so a drop lands here. */
export function meetingsShown(): boolean {
  return !element.view.hidden;
}

let importing = false;

/** What `afconvert` reads; anything else is decoded by WebKit. */
const HOST_DECODES = new Set(["wav", "mp3", "m4a", "m4b", "mp4", "aac", "caf", "aif", "aiff", "flac"]);

/**
 * Makes a meeting from an audio file, picked or dropped: the host keeps the
 * audio, transcribes it, tags speakers and writes the summary, the same as
 * after a recording. The meeting opens at once and fills in as it goes.
 */
export async function importAudioFile(file: File): Promise<void> {
  if (importing) {
    options.toast("Another file is still being read.");
    return;
  }
  importing = true;
  element.importButton.disabled = true;
  options.toast(`Reading ${file.name}…`);
  try {
    const title = file.name.replace(/\.[^.]+$/, "");
    const extension = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase() ?? "";
    // Core Audio, in the host, reads these whole. WebKit's decoder is only
    // the fallback: it cut an 18-minute M4A to under 12 without an error.
    const meeting = HOST_DECODES.has(extension)
      ? await host().importMeetingAudio(new Uint8Array(await file.arrayBuffer()), title, extension)
      : await host().importMeetingAudio(await audioFileToMonoWav(file, 16_000), title);
    await refreshList();
    openMeeting(meeting.id);
  } catch (error) {
    showError(error);
  } finally {
    importing = false;
    element.importButton.disabled = false;
  }
}

/** For the strip on other pages: open the live meeting. */
export function openRecordingMeeting(): void {
  if (status?.recording) openMeeting(status.recording);
}

/** For the strip and the HUD: stop whatever is recording. */
export async function stopRecording(): Promise<void> {
  await stop();
}

// --- Keyboard ------------------------------------------------------------------

/**
 * ⌘F finds; Escape puts away the nearest thing that is up, and then the open
 * meeting; the arrows walk the list and Enter opens the row.
 */
function onKey(event: KeyboardEvent): void {
  if (element.view.hidden) return;

  if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "f") {
    event.preventDefault();
    // The list is behind the open meeting; go back to it first.
    if (openId) openMeeting(null);
    element.search.focus();
    element.search.select();
    return;
  }

  if (event.key === "Escape") {
    if (closeMenus()) {
      event.stopPropagation();
      return;
    }
    if (confirmDelete || confirmDiscard) {
      event.stopPropagation();
      confirmDelete = false;
      confirmDiscard = false;
      live = null;
      renderConfirm();
      renderBand();
      return;
    }
    if (!element.intro.hidden) {
      event.stopPropagation();
      hideIntro();
      return;
    }
    // A field with text in it clears first; the page steps back only after.
    const active = document.activeElement;
    if (active instanceof HTMLInputElement && active.value) return;
    if (active instanceof HTMLTextAreaElement) return;
    if (openId) {
      event.stopPropagation();
      openMeeting(null);
    }
    return;
  }

  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    const active = document.activeElement as HTMLElement | null;
    if (openId || !active || !(element.list.contains(active) || active === element.search)) return;
    const rows = Array.from(element.list.querySelectorAll<HTMLElement>(".meeting-row"));
    if (rows.length === 0) return;
    event.preventDefault();
    const down = event.key === "ArrowDown";
    const index = rows.findIndex((row) => row.contains(active));
    const next = index === -1 ? (down ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, index + (down ? 1 : -1)));
    const id = rows[next]?.dataset.id;
    if (id) focusRow(id);
  }
}

function focusRow(id: string): void {
  const rows = element.list.querySelectorAll<HTMLElement>(".meeting-row");
  for (const row of rows) row.tabIndex = row.dataset.id === id ? 0 : -1;
  const row = element.list.querySelector<HTMLElement>(`.meeting-row[data-id="${CSS.escape(id)}"]`);
  row?.focus();
  row?.scrollIntoView({ block: "nearest" });
}

// --- Data --------------------------------------------------------------------

async function refreshStatus(): Promise<void> {
  try {
    status = await host().meetingRecorderStatus();
    // macOS keeps the grant between launches; the page's memory of it would
    // not, and the ask would come back every time.
    if (otherSide === null && options.otherSideAllowed()) otherSide = "heard";
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
  renderHead();
  renderAsk();
  renderOverview();
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
  const active = document.activeElement;
  introReturnTo = active instanceof HTMLElement && active !== document.body ? active : element.record;
  element.intro.hidden = false;
  element.introStart.focus();
}

function hideIntro(): void {
  if (element.intro.hidden) return;
  element.intro.hidden = true;
  (introReturnTo ?? element.record).focus();
  introReturnTo = null;
}

/**
 * Asks macOS for the other side's permission, then records. The ask is the
 * point of the sheet: the prompt appears here, on purpose, not mid-call.
 */
async function startFromIntro(): Promise<void> {
  element.introStart.disabled = true;
  element.introStart.textContent = "Asking macOS…";
  const outcome = await probeOtherSide();
  element.introStart.disabled = false;
  element.introStart.textContent = "Allow and start recording";
  options.markIntroSeen();
  hideIntro();
  if (outcome === "silent") {
    options.toast("macOS didn't allow Waveform to hear the other side yet. Recording your side only.", {
      action: { label: "Open System Settings", run: openAudioCaptureSettings },
    });
  }
  await record();
}

/** Runs the permission check and remembers the answer for the page. */
async function probeOtherSide(): Promise<typeof otherSide> {
  if (probing) return otherSide;
  probing = true;
  renderEmpty();
  try {
    otherSide = await host().probeSystemAudio();
  } catch (error) {
    showError(error);
    otherSide = "silent";
  } finally {
    probing = false;
  }
  if (otherSide === "heard" || otherSide === "silent") options.rememberOtherSide(otherSide === "heard");
  renderEmpty();
  renderBanners();
  live = null;
  renderBand();
  renderPermissionAsk();
  if (otherSide === "heard") options.toast("Allowed. The other side of your calls will be recorded.");
  return otherSide;
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
  confirmDiscard = false;
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

/** Throws the live recording away; the card has already asked. */
async function discardRecording(): Promise<void> {
  if (!detail || detail.meeting.state !== "recording") return;
  confirmDiscard = false;
  try {
    await host().cancelMeeting();
    openMeeting(null);
    await refreshList();
    options.toast("Discarded");
  } catch (error) {
    showError(error);
  }
}

/** Deletes a finished meeting; the bar or the short-recording offer has asked. */
async function deleteMeeting(meeting: Meeting, said: string): Promise<void> {
  confirmDelete = false;
  try {
    await host().deleteMeeting(meeting.id);
    if (openId === meeting.id) openMeeting(null);
    await refreshList();
    options.toast(said);
  } catch (error) {
    showError(error);
    renderConfirm();
  }
}

async function saveAudio(meeting: Meeting): Promise<void> {
  try {
    await host().exportMeetingAudio(meeting.id);
    options.toast("Saved to Downloads");
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
  const label = stopping
    ? "Stopping…"
    : recording
      ? `Stop ${recordingSince ? clock(Date.now() - recordingSince) : ""}`.trim()
      : "Record";
  element.record.replaceChildren(icon(recording ? "stop" : "mic", recording), label);
  element.record.title = recording ? "Stop recording and keep it" : "Record a meeting";
  if (recording) startTicker();
  else if (!detail || detail.meeting.state !== "recording") stopTicker();
}

/** Twice a second: the clocks move; nothing else is rebuilt. */
function startTicker(): void {
  if (ticker !== null) return;
  ticker = window.setInterval(() => {
    renderRecordButton();
    if (detail?.meeting.state === "recording") updateLive();
    const row = element.list.querySelector<HTMLElement>(".meeting-row.is-recording .meeting-row-time");
    if (row && recordingSince) row.textContent = clock(Date.now() - recordingSince);
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

  const cards: HTMLElement[] = [];
  if (status.systemAudio === "available") {
    const heard = otherSide === "heard";
    const actions: HTMLElement[] = [];
    if (!heard) {
      actions.push(linkButton(probing ? "Asking macOS…" : otherSide === "silent" ? "Check again" : "Allow", () => void probeOtherSide(), true));
      if (otherSide === "silent") actions.push(linkButton("Open System Settings", openAudioCaptureSettings));
    }
    cards.push(
      setupCard(
        "headphones",
        "Hear the other side of the call",
        heard
          ? "Allowed. Both sides of a call are recorded."
          : otherSide === "silent"
            ? "macOS hasn't allowed it. Turn on Waveform under Screen & System Audio Recording, then check again."
            : "macOS asks once. Nothing you record leaves this Mac.",
        { done: heard, actions },
      ),
    );
  } else if (status.systemAudio === "unsupported") {
    cards.push(
      setupCard("headphones", "Hear the other side of the call", "Needs macOS 14.2 or later; until then only your microphone is recorded."),
    );
  } else {
    cards.push(setupCard("headphones", "Your microphone only", "This copy of Waveform can only record your microphone."));
  }
  if (!status.diarizerInstalled) {
    cards.push(
      setupCard(
        "users",
        "Tell speakers apart",
        installing
          ? installing.message
          : `A ${megabytes(status.diarizerBytes)} download, kept on this Mac. Without it, everyone else on the call is one voice.`,
        { actions: [diarizerButton()], progress: installing ? installing.progress : null },
      ),
    );
  }
  if (!status.canSummarize) {
    cards.push(
      setupCard(
        "sparkles",
        "Write a summary",
        "Download a local model in AI Polish and summaries stay on this Mac. An OpenRouter key works too; it sends only the transcript text.",
        { actions: [linkButton("Set up", () => options.openAiPolish())] },
      ),
    );
  }
  element.emptySetup.append(...cards);
}

/** One thing still to set up, or done: an icon, a line on why, a button. */
function setupCard(
  glyph: IconName,
  title: string,
  body: string,
  extra: { done?: boolean; actions?: HTMLElement[]; progress?: number | null } = {},
): HTMLElement {
  const card = document.createElement("div");
  card.className = "setup-card";
  if (extra.done) card.classList.add("is-done");
  const mark = document.createElement("span");
  mark.className = "setup-card-icon";
  mark.append(icon(extra.done ? "check" : glyph));
  const heading = document.createElement("h3");
  heading.textContent = title;
  const text = document.createElement("p");
  text.textContent = body;
  card.append(mark, heading, text);
  if (extra.progress !== null && extra.progress !== undefined) {
    const bar = document.createElement("div");
    bar.className = "setup-card-progress";
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-valuenow", String(Math.round(extra.progress * 100)));
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", "100");
    const fill = document.createElement("span");
    fill.style.width = `${Math.round(extra.progress * 100)}%`;
    bar.append(fill);
    card.append(bar);
  }
  if (extra.actions && extra.actions.length > 0) {
    const row = document.createElement("div");
    row.className = "setup-card-actions";
    row.append(...extra.actions);
    card.append(row);
  }
  return card;
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
          (meeting.summary ?? "").toLowerCase().includes(query) ||
          meeting.memo.toLowerCase().includes(query),
      )
    : meetings;

  element.shell.hidden = meetings.length === 0;
  element.shell.dataset.open = String(openId !== null);
  // An open meeting has the page to itself: no Notetaker head above it.
  element.view.classList.toggle("is-meeting-open", openId !== null);
  element.list.replaceChildren(...groupRows(shown));
  element.noMatch.hidden = meetings.length === 0 || shown.length > 0;
  renderPermissionAsk();
  renderOverview();
}

/**
 * The list in sections: the recording first, whatever the dates say, then
 * one section a day, newest first.
 */
function groupRows(shown: Meeting[]): HTMLElement[] {
  const groups = new Map<string, { label: string; live: boolean; rows: Meeting[] }>();
  const focusable = (returnTo && shown.some((meeting) => meeting.id === returnTo) ? returnTo : shown[0]?.id) ?? null;
  for (const meeting of shown) {
    const key = meeting.state === "recording" ? "live" : dayKey(meeting.createdAt);
    const group = groups.get(key) ?? { label: key === "live" ? "Now" : dayLabel(meeting.createdAt), live: key === "live", rows: [] };
    group.rows.push(meeting);
    groups.set(key, group);
  }
  const ordered = Array.from(groups.values()).sort((a, b) => Number(b.live) - Number(a.live));
  return ordered.map((group) => {
    const section = document.createElement("div");
    section.className = "meetings-group";
    if (group.live) section.classList.add("is-live");
    section.setAttribute("role", "group");
    section.setAttribute("aria-label", group.label);
    const label = document.createElement("h3");
    label.className = "meetings-group-label";
    label.textContent = group.label;
    section.append(label, ...group.rows.map((meeting) => renderListRow(meeting, meeting.id === focusable)));
    return section;
  });
}

function dayKey(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function dayLabel(at: number): string {
  const days = daysAgo(at);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  const date = new Date(at);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString(
    [],
    sameYear ? { weekday: "short", day: "numeric", month: "short" } : { weekday: "short", day: "numeric", month: "short", year: "numeric" },
  );
}

function daysAgo(at: number): number {
  const start = (ts: number) => {
    const date = new Date(ts);
    date.setHours(0, 0, 0, 0);
    return date.getTime();
  };
  return Math.round((start(Date.now()) - start(at)) / 86_400_000);
}

/**
 * Above the list, until allowed: the one permission the feature depends on.
 * Asked with a button, never a trip to System Settings unless macOS refused.
 */
function renderPermissionAsk(): void {
  const show =
    meetings.length > 0 &&
    status?.systemAudio === "available" &&
    otherSide !== "heard" &&
    !permissionDismissed;
  element.permission.hidden = !show;
  if (!show) return;
  element.permission.replaceChildren();
  const text = document.createElement("div");
  text.className = "meeting-banner-text";
  const strong = document.createElement("strong");
  strong.textContent = otherSide === "silent" ? "macOS hasn't let Waveform hear the other side of calls." : "Let Waveform hear the other side of your calls.";
  const small = document.createElement("span");
  small.textContent =
    otherSide === "silent"
      ? "Turn on Waveform under Screen & System Audio Recording, then check again."
      : "macOS asks once. Without it, meetings record your microphone only.";
  text.append(strong, small);
  const actions = document.createElement("div");
  actions.className = "meeting-banner-actions";
  actions.append(
    linkButton(probing ? "Asking macOS…" : otherSide === "silent" ? "Check again" : "Allow", () => void probeOtherSide(), true),
  );
  if (otherSide === "silent") actions.append(linkButton("Open System Settings", openAudioCaptureSettings));
  actions.append(
    linkButton("Not now", () => {
      permissionDismissed = true;
      renderPermissionAsk();
    }),
  );
  element.permission.append(text, actions);
}

function renderListRow(meeting: Meeting, focusable: boolean): HTMLElement {
  const row = document.createElement("div");
  row.className = `meeting-row is-${meeting.state}`;
  row.dataset.id = meeting.id;
  row.tabIndex = focusable ? 0 : -1;
  row.setAttribute("role", "option");
  row.setAttribute("aria-selected", "false");
  const open = () => openMeeting(meeting.id);
  row.addEventListener("click", open);
  row.addEventListener("mouseenter", () => preview(meeting.id));
  row.addEventListener("focus", () => preview(meeting.id));
  row.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      open();
    }
  });
  onRowContextMenu(row, (event) => void openRowMenu(meeting.id, event.clientX, event.clientY));

  const tile = document.createElement("span");
  tile.className = "meeting-row-tile";
  tile.append(icon(meeting.state === "recording" ? "mic" : "text"));

  const main = document.createElement("span");
  main.className = "meeting-row-main";
  const title = document.createElement("span");
  title.className = "meeting-row-title";
  if (meeting.state === "recording") {
    const dot = document.createElement("span");
    dot.className = "recording-dot";
    title.append(dot);
  }
  const name = document.createElement("span");
  name.textContent = meeting.title;
  title.append(name);
  const time = document.createElement("span");
  time.className = "meeting-row-time";
  time.textContent =
    meeting.state === "recording"
      ? clock(Date.now() - (recordingSince ?? meeting.createdAt))
      : [timeOfDay(meeting.createdAt), meeting.durationMs > 0 ? duration(meeting.durationMs) : ""].filter(Boolean).join(" · ");
  main.append(title, time);

  const side = document.createElement("span");
  side.className = "meeting-row-side";
  const badge = rowBadge(meeting);
  if (badge) side.append(badge);
  if (meeting.state === "recording") {
    const stopButton = linkButton("Stop", () => void stop());
    stopButton.className = "pill-button is-stop is-small";
    stopButton.addEventListener("click", (event) => event.stopPropagation());
    side.append(stopButton);
  }

  row.classList.toggle("is-previewed", meeting.id === previewedId());
  row.append(tile, main, side);
  return row;
}

// --- Overview ------------------------------------------------------------------

/** The meeting the panel shows: the one pointed at, else the newest finished one. */
function previewedId(): string | null {
  if (previewId && meetings.some((meeting) => meeting.id === previewId)) return previewId;
  return (meetings.find((meeting) => meeting.state !== "recording") ?? meetings[0])?.id ?? null;
}

function preview(id: string): void {
  if (previewId === id) return;
  previewId = id;
  for (const row of element.list.querySelectorAll<HTMLElement>(".meeting-row")) {
    row.classList.toggle("is-previewed", row.dataset.id === id);
  }
  renderOverview();
}

/**
 * Beside the list: the meeting pointed at, read without opening it: its
 * title, when, and the summary's one-sentence overview.
 */
function renderOverview(): void {
  const id = previewedId();
  const meeting = meetings.find((entry) => entry.id === id);
  if (!meeting) {
    element.overview.replaceChildren();
    return;
  }

  const head = document.createElement("header");
  head.className = "overview-head";
  const title = document.createElement("h2");
  title.className = "overview-title";
  title.textContent = meeting.title;
  const when = document.createElement("p");
  when.className = "overview-when";
  when.textContent = [
    new Date(meeting.createdAt).toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }),
    timeOfDay(meeting.createdAt),
    meeting.durationMs > 0 ? duration(meeting.durationMs) : "",
  ]
    .filter(Boolean)
    .join(" · ");
  head.append(title, when);

  const body = document.createElement("div");
  body.className = "overview-body";
  const section = (label: string, content: HTMLElement) => {
    const heading = document.createElement("h3");
    heading.className = "overview-label";
    heading.textContent = label;
    body.append(heading, content);
  };

  const lede = rowLede(meeting);
  const text = document.createElement("p");
  text.className = "overview-text";
  if (meeting.state === "recording") text.textContent = "Recording now. The overview is written when it stops.";
  else if (meeting.state === "processing") text.textContent = "Finishing up. The overview is on its way.";
  else if (lede) text.textContent = lede;
  else {
    text.classList.add("is-quiet");
    text.textContent = status?.canSummarize
      ? "No summary for this meeting."
      : "Summaries need a local model or an OpenRouter key from AI Polish.";
  }
  section("Overview", text);

  element.overview.replaceChildren(head, body);
}

function rowLede(meeting: Meeting): string {
  if (meeting.state !== "ready") return "";
  // The summary's first line is the overview; a Title line, if the model
  // wrote one, is already the row's title.
  return (
    meeting.summary
      ?.split("\n")
      .map((line) => line.trim())
      .find((line) => line && !/^\*{0,2}title:/i.test(line)) ?? ""
  );
}

/** A small word on the row for anything that is not simply "ready". */
function rowBadge(meeting: Meeting): HTMLElement | null {
  const make = (text: string, tone: "live" | "busy" | "warn" | "plain") => {
    const badge = document.createElement("span");
    badge.className = "meeting-row-badge";
    if (tone !== "plain") badge.classList.add(`is-${tone}`);
    badge.textContent = text;
    return badge;
  };
  switch (meeting.state) {
    case "recording":
      return make("Live", "live");
    case "processing":
      return make("Finishing…", "busy");
    case "failed":
      return make(meeting.notes.some((note) => note.kind === "interrupted") ? "Interrupted" : "Stopped early", "warn");
    default:
      if (meeting.notes.some((note) => note.kind === "other-side-not-heard")) return make("Your side only", "plain");
      if (meeting.notes.some((note) => note.kind === "nothing-said")) return make("Nothing picked up", "plain");
      return null;
  }
}

// --- One meeting -------------------------------------------------------------

function openMeeting(id: string | null): void {
  const changed = id !== openId;
  const leaving = openId;
  void flushMemo();
  stopPlayback();
  openId = id;
  detail = null;
  namesChanged = false;
  confirmDelete = false;
  confirmDiscard = false;
  live = null;
  element.detail.hidden = id === null;
  element.find.value = "";
  element.askInput.value = "";
  element.detail.classList.remove("is-compact");
  findOpen = false;
  speakersOpen = false;
  if (id === null && leaving) returnTo = leaving;
  renderList();
  renderEmpty();
  if (id) {
    if (changed) replay(element.detail);
    element.scroller.scrollTo({ top: 0 });
    const known = meetings.find((meeting) => meeting.id === id);
    if (known) {
      detail = { meeting: known, lines: [], summary: null };
      renderDetail();
    }
    void reloadDetail();
  } else {
    if (!status?.recording) stopTicker();
    // Back on the list: on the row that was open, so the arrows go on from there.
    if (leaving) focusRow(leaving);
  }
}

/** Runs an element's entrance animation again. */
function replay(node: HTMLElement): void {
  node.style.animation = "none";
  void node.offsetWidth;
  node.style.animation = "";
}

function renderDetail(): void {
  if (!detail) return;
  if (document.activeElement !== element.title) element.title.value = detail.meeting.title;
  renderHead();
  renderConfirm();
  renderShort();
  renderBand();
  renderBanners();
  renderTabs();
  renderSummary();
  renderTranscriptNote();
  renderSpeakers();
  renderLines();
  renderMemo();
  renderAsk();
  renderTranscriptTools();
  if (detail.meeting.state === "recording") startTicker();
}

/** The sticky head: when, how long, who, and what can be done with it. */
function renderHead(): void {
  if (!detail) return;
  const { meeting } = detail;

  // Under the title: the day, and how long, as quiet chips.
  const chip = (text: string, tone?: string) => {
    const span = document.createElement("span");
    span.className = tone ? `meeting-chip is-${tone}` : "meeting-chip";
    span.textContent = text;
    return span;
  };
  const date = new Date(meeting.createdAt);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  const chips: HTMLElement[] = [
    chip(date.toLocaleDateString([], sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" })),
    chip(timeOfDay(meeting.createdAt)),
  ];
  if (meeting.state === "recording") chips.push(chip("Recording", "live"));
  else if (meeting.durationMs > 0) chips.push(chip(duration(meeting.durationMs)));
  element.meta.replaceChildren(...chips);

  // Newer and older, in the list's order.
  const index = meetings.findIndex((entry) => entry.id === meeting.id);
  element.prev.disabled = index <= 0;
  element.next.disabled = index === -1 || index >= meetings.length - 1;

  element.actions.replaceChildren();
  if (meeting.state === "recording" || meeting.state === "processing") return;
  const playing = Boolean(playback && !playback.audio.paused);
  const trigger = iconButton("more", "More", () => {});
  trigger.className = "meeting-icon-button is-plain";
  const menu = dropdown(trigger, "More", [
    { label: playing ? "Pause" : "Play", icon: playing ? "pause" : "play", run: () => void togglePlay(), disabled: !meeting.hasAudio },
    "divider",
    ...copyItems(() => menu),
    "divider",
    ...moreItems(),
  ]);
  // Speakers not told apart yet: the one thing to do, beside the menu.
  if (meeting.notes.some((note) => note.kind === "speaker-tool-missing")) {
    const label = installing
      ? installing.message
      : status?.diarizerInstalled
        ? "Tag speakers now"
        : `Tell speakers apart (${megabytes(status?.diarizerBytes ?? 0)} download)`;
    const tag = iconButton("users", label, () => tagSpeakers(meeting));
    tag.className = "meeting-icon-button is-plain is-attention";
    tag.disabled = Boolean(installing);
    element.actions.append(tag);
  }
  element.actions.append(menu);
}

/** Tags the meeting's speakers, fetching the speaker tool first if need be. */
function tagSpeakers(meeting: Meeting): void {
  if (status?.diarizerInstalled) {
    void host()
      .tagMeetingSpeakers(meeting.id)
      .then(() => options.toast("Tagging speakers…"))
      .catch(showError);
    return;
  }
  if (installing) return;
  installing = { stage: "downloading", message: "Starting…", progress: 0 };
  renderHead();
  renderTranscriptNote();
  void host()
    .installDiarizer()
    .catch(showError)
    .finally(() => void refreshStatus());
}

/** Opens the meeting before (-1) or after (1) this one in the list. */
function step(by: number): void {
  if (!openId) return;
  const index = meetings.findIndex((entry) => entry.id === openId);
  const next = meetings[index + by];
  if (next) openMeeting(next.id);
}

/** The transcript bar's toggles: find, and naming the speakers. */
function renderTranscriptTools(): void {
  element.find.hidden = !findOpen;
  element.findToggle.setAttribute("aria-pressed", String(findOpen));
  element.speakersToggle.setAttribute("aria-expanded", String(speakersOpen));
  element.speakersToggle.setAttribute("aria-pressed", String(speakersOpen));
  element.copyTranscript.disabled = !detail || detail.lines.length === 0;
  renderSpeakers();
}

/** What the Copy menu offers for the open meeting. `anchor` shows the "copied" tick. */
function copyItems(anchor: () => HTMLElement, given: MeetingDetail | null = detail): DropdownItem[] {
  const lines = given?.lines.length ?? 0;
  return [
    { label: "Copy summary", icon: "sparkles", run: () => copyText(anchor(), "Summary", given?.meeting.summary ? summaryTextOf(given) : null), disabled: !given?.meeting.summary },
    { label: "Copy transcript", icon: "text", run: () => copyText(anchor(), "Transcript", given && given.lines.length > 0 ? transcriptText(given) : null), disabled: lines === 0 },
    {
      label: "Copy both",
      icon: "copy",
      run: () =>
        copyText(
          anchor(),
          "Summary and transcript",
          given && given.lines.length > 0
            ? [given.meeting.summary ? summaryTextOf(given) : null, "Transcript", transcriptText(given)].filter(Boolean).join("\n\n")
            : null,
        ),
      disabled: lines === 0,
    },
  ];
}

/** What the More menu offers for the open meeting. */
function moreItems(): DropdownItem[] {
  const meeting = detail?.meeting;
  if (!meeting) return [];
  return [
    { label: "Rename", icon: "pencil", run: () => { element.title.focus(); element.title.select(); } },
    { label: "Rewrite summary", icon: "sparkles", run: () => void rewriteSummary(), disabled: !status?.canSummarize || !detail || detail.lines.length === 0 },
    { label: "Tag speakers again", icon: "users", run: () => tagSpeakers(meeting), disabled: !status?.diarizerInstalled || !meeting.hasAudio },
    { label: "Save audio…", icon: "download", run: () => void saveAudio(meeting), disabled: !meeting.hasAudio },
    "divider",
    { label: "Delete meeting…", icon: "trash", run: askDelete, danger: true },
  ];
}

/**
 * Right-click on a row: the list stays where it is, and the menu offers what
 * can be done without opening the meeting -- open it, copy from it, save its
 * audio -- and the rest by opening it first. A meeting still recording or
 * finishing offers only Open.
 */
async function openRowMenu(id: string, x: number, y: number): Promise<void> {
  closeMenus();
  preview(id);
  let given: MeetingDetail;
  try {
    given = await host().getMeeting(id);
  } catch (error) {
    showError(error);
    return;
  }
  const meeting = given.meeting;
  const busy = meeting.state === "recording" || meeting.state === "processing";
  const thenOpen = (run: () => void) => () => {
    openMeeting(id);
    run();
  };
  const wrap = floatingMenu(x, y, "Meeting", [
    { label: "Open", icon: "text", run: () => openMeeting(id) },
    ...(busy
      ? []
      : ([
          { label: "Play", icon: "play", run: thenOpen(() => void togglePlay()), disabled: !meeting.hasAudio },
          "divider",
          ...copyItems(() => wrap, given),
          "divider",
          { label: "Rename", icon: "pencil", run: thenOpen(() => { element.title.focus(); element.title.select(); }) },
          { label: "Save audio…", icon: "download", run: () => void saveAudio(meeting), disabled: !meeting.hasAudio },
          "divider",
          { label: "Delete meeting…", icon: "trash", run: thenOpen(askDelete), danger: true },
        ] as DropdownItem[])),
  ]);
}

function copyText(trigger: HTMLElement, what: string, text: string | null): void {
  if (text === null) return;
  const button = trigger.querySelector("button");
  void navigator.clipboard
    .writeText(text)
    .then(() => {
      if (button) copied(button);
      options.toast(`${what} copied`);
    })
    .catch(showError);
}

/** A head action: an icon, and a word beside it when there is room for one. */
function iconButton(glyph: IconName, label: string, run: () => void, withLabel = false): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = withLabel ? "pill-button" : "pill-button is-icon";
  button.setAttribute("aria-label", label);
  button.title = label;
  button.append(icon(glyph, glyph === "play" || glyph === "pause"));
  if (withLabel) button.append(label);
  button.addEventListener("click", run);
  return button;
}

// --- Inline questions ----------------------------------------------------------

function askDelete(): void {
  confirmDelete = true;
  renderConfirm();
  element.scroller.scrollTo({ top: 0, behavior: reducedMotion() ? "auto" : "smooth" });
  element.confirm.querySelector<HTMLButtonElement>("[data-cancel]")?.focus();
}

/** "Delete this meeting?" at the top of the detail, until answered. */
function renderConfirm(): void {
  if (!detail || !confirmDelete) {
    element.confirm.hidden = true;
    element.confirm.replaceChildren();
    return;
  }
  const { meeting } = detail;
  element.confirm.hidden = false;
  element.confirm.setAttribute("aria-label", "Delete this meeting?");
  const text = document.createElement("div");
  text.className = "meeting-banner-text";
  const strong = document.createElement("strong");
  strong.textContent = `Delete “${meeting.title}” and its recording?`;
  const small = document.createElement("span");
  small.textContent = "This cannot be undone.";
  text.append(strong, small);
  const actions = document.createElement("div");
  actions.className = "meeting-banner-actions";
  const yes = linkButton("Delete", () => void deleteMeeting(meeting, "Deleted"));
  yes.className = "pill-button is-stop";
  const no = linkButton("Cancel", () => {
    confirmDelete = false;
    renderConfirm();
  });
  no.dataset.cancel = "1";
  actions.append(yes, no);
  element.confirm.replaceChildren(text, actions);
}

/**
 * Why a just-stopped recording is probably not worth keeping, or null. Said
 * as soon as Stop lands, so nobody waits a minute for notes on twelve seconds.
 */
function shortReason(): string | null {
  if (!detail) return null;
  const { meeting } = detail;
  if (meeting.state === "recording" || shortKept.has(meeting.id)) return null;
  if (meeting.durationMs > 0 && meeting.durationMs < SHORT_MS) {
    return `Short recording — ${duration(meeting.durationMs)}, nothing much in it.`;
  }
  const nothing =
    meeting.notes.some((note) => note.kind === "nothing-said") || (meeting.state === "ready" && detail.lines.length === 0);
  if (nothing) return `Nothing was picked up — ${duration(meeting.durationMs)} of silence.`;
  return null;
}

/** The offer to discard a short or empty recording: Discard, or Keep. */
function renderShort(): void {
  const reason = shortReason();
  element.short.hidden = reason === null;
  element.short.replaceChildren();
  if (reason === null || !detail) return;
  const { meeting } = detail;
  const text = document.createElement("div");
  text.className = "meeting-banner-text";
  const strong = document.createElement("strong");
  strong.textContent = reason;
  const small = document.createElement("span");
  small.textContent = meeting.state === "processing" ? "Discarding now stops the finishing too." : "Keep it, or let it go.";
  text.append(strong, small);
  const actions = document.createElement("div");
  actions.className = "meeting-banner-actions";
  const discard = linkButton("Discard", () => void deleteMeeting(meeting, "Discarded"));
  discard.className = "pill-button is-stop";
  const keep = linkButton("Keep", () => {
    shortKept.add(meeting.id);
    renderShort();
    renderBanners();
  });
  actions.append(discard, keep);
  element.short.append(text, actions);
}

/**
 * The host's finishing stages, in the order it runs them. The first is this
 * page's own: Stop is in flight and the host has not answered yet.
 */
const STEPS: { label: string; stage: string | null; when?: () => boolean }[] = [
  { label: "Saving the recording", stage: null },
  { label: "Transcribing the last phrases", stage: "Finishing the last phrases" },
  { label: "Tagging speakers", stage: "Tagging speakers", when: () => Boolean(status?.diarizerInstalled) },
  { label: "Preparing playback", stage: "Preparing playback" },
  { label: "Writing the summary", stage: "Writing the summary", when: () => Boolean(status?.canSummarize) },
];

/** The card under the head: live while recording, steps while finishing. */
function renderBand(): void {
  if (!detail) return;
  const { meeting } = detail;
  const band = element.band;

  if (meeting.state === "recording" && !stopping) {
    renderLiveCard(meeting);
    return;
  }
  live = null;

  if (meeting.state === "processing" || (meeting.state === "recording" && stopping)) {
    band.className = "meeting-band is-processing";
    const steps = STEPS.filter((step) => step.when?.() ?? true);
    const current = (meeting.stage ?? "").replace(/…$/, "");
    // An imported file is still being transcribed: its own stage, with a
    // way out, since a long file takes as long as the engine needs.
    const importing = current.startsWith("Transcribing");
    let currentIndex = stopping ? 0 : steps.findIndex((step) => step.stage !== null && current.startsWith(step.stage));
    if (currentIndex === -1) currentIndex = 1;

    // One quiet line: what is happening now, with a small spinner.
    const label = importing && currentIndex <= 1 ? (meeting.stage ?? "Reading the file") : (steps[currentIndex]?.label ?? "Finishing");
    const card = document.createElement("div");
    card.className = "band-status";
    card.setAttribute("role", "status");
    const spinner = document.createElement("span");
    spinner.className = "band-spinner";
    spinner.setAttribute("aria-hidden", "true");
    const count = document.createElement("span");
    count.className = "band-count";
    count.textContent = `${Math.min(currentIndex, steps.length - 1) + 1}/${steps.length}`;
    const text = document.createElement("span");
    text.textContent = `${label.replace(/…$/, "")}…`;
    card.append(spinner, count, text);
    if (importing) {
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "link band-cancel";
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", () => void deleteMeeting(meeting, "Import cancelled."));
      card.append(cancel);
    }
    band.replaceChildren(card);
    return;
  }

  band.className = "meeting-band";
  band.replaceChildren();
}

/**
 * Built once per situation and then only moved: the clock changes twice a
 * second and the dot brightens with the audio, and rebuilding them would
 * reset their motion. Calm on purpose: no meters, nothing that says who is
 * speaking.
 */
function renderLiveCard(meeting: Meeting): void {
  const hasOther = status?.systemAudio === "available" && meeting.hasSystemAudio;
  const unheard = hasOther && level ? !level.otherHeard && level.elapsedMs > 5_000 : false;
  const key = [hasOther, unheard, probing, confirmDiscard].join("|");
  if (live && live.key === key && element.band.firstElementChild?.classList.contains("live-card")) {
    updateLive();
    return;
  }

  element.band.className = "meeting-band is-recording";
  const card = document.createElement("div");
  card.className = "live-card";

  const head = document.createElement("div");
  head.className = "live-head";
  const state = document.createElement("span");
  state.className = "live-status";
  const dot = document.createElement("span");
  dot.className = "recording-dot";
  state.append(dot, "Recording");
  const clockText = document.createElement("span");
  clockText.className = "live-clock";
  head.append(state, clockText);

  const note = document.createElement("p");
  note.className = "live-note";
  if (!hasOther) {
    note.textContent = "Only your microphone is being recorded.";
  } else if (unheard) {
    note.classList.add("is-warn");
    note.append("Waveform can't hear the other side yet. ");
    note.append(linkButton(probing ? "Asking macOS…" : "Allow", () => void probeOtherSide(), true));
    note.append(linkButton("Open System Settings", openAudioCaptureSettings));
  } else {
    note.textContent = "Both sides are being recorded. Lines appear a few seconds after each sentence ends.";
  }

  const actions = document.createElement("div");
  actions.className = "live-actions";
  if (confirmDiscard) {
    actions.classList.add("is-asking");
    const text = document.createElement("div");
    text.className = "meeting-banner-text";
    const strong = document.createElement("strong");
    strong.textContent = "Throw this recording away?";
    const small = document.createElement("span");
    const elapsed = clock(Date.now() - (recordingSince ?? meeting.createdAt));
    small.textContent = `The ${elapsed} recorded so far will be deleted.`;
    text.append(strong, small);
    const buttons = document.createElement("div");
    buttons.className = "meeting-banner-actions";
    const yes = linkButton("Discard", () => void discardRecording());
    yes.className = "pill-button is-stop";
    const no = linkButton("Keep recording", () => {
      confirmDiscard = false;
      live = null;
      renderBand();
    });
    no.dataset.cancel = "1";
    buttons.append(yes, no);
    actions.append(text, buttons);
  } else {
    const stopButton = document.createElement("button");
    stopButton.type = "button";
    stopButton.className = "pill-button is-stop live-stop";
    stopButton.append(icon("stop", true), "Stop");
    stopButton.title = "Stop recording and keep it";
    stopButton.addEventListener("click", () => void stop());
    const discardButton = document.createElement("button");
    discardButton.type = "button";
    discardButton.className = "link live-discard";
    discardButton.textContent = "Discard";
    discardButton.addEventListener("click", () => {
      confirmDiscard = true;
      live = null;
      renderBand();
      element.band.querySelector<HTMLButtonElement>("[data-cancel]")?.focus();
    });
    actions.append(stopButton, discardButton);
  }

  card.append(head, note, actions);
  element.band.replaceChildren(card);
  live = { key, clock: clockText, dot };
  updateLive();
}

function updateLive(): void {
  if (!live || !detail) return;
  live.clock.textContent = clock(Date.now() - (recordingSince ?? detail.meeting.createdAt));
  // The one sign that audio is arriving: the dot brightens with it.
  const loudest = Math.max(level?.mic ?? 0, level?.system ?? 0);
  live.dot.style.setProperty("--live-level", String(Math.min(1, Math.sqrt(Math.min(1, loudest * 4)))));
}

// --- Tabs ------------------------------------------------------------------------

/** The tab showing: the user's pick this session, else Summary when there is one. */
function activeTab(): Tab {
  if (!detail) return "transcript";
  if (detail.meeting.state === "recording") return chosenTab === "notes" ? "notes" : "transcript";
  if (chosenTab) return chosenTab;
  return detail.summary || detail.meeting.summary ? "summary" : "transcript";
}

function tabButton(tab: Tab): HTMLButtonElement {
  return tab === "summary" ? element.tabSummary : tab === "transcript" ? element.tabTranscript : element.tabNotes;
}

function tabPanel(tab: Tab): HTMLElement {
  return tab === "summary" ? element.summary : tab === "transcript" ? element.transcript : element.notes;
}

function chooseTab(tab: Tab): void {
  if (tabButton(tab).disabled) return;
  const before = activeTab();
  chosenTab = tab;
  renderTabs();
  if (before !== tab) replay(tabPanel(tab));
}

function renderTabs(): void {
  if (!detail) return;
  const tab = activeTab();
  element.tabSummary.disabled = detail.meeting.state === "recording";
  element.tabSummary.setAttribute("aria-disabled", String(element.tabSummary.disabled));
  element.tabs.dataset.tab = tab;
  for (const name of TABS) {
    const button = tabButton(name);
    button.setAttribute("aria-selected", String(name === tab));
    button.tabIndex = name === tab ? 0 : -1;
    tabPanel(name).hidden = name !== tab;
  }
  if (tab === "notes") sizeMemo();
  updateTabCount();
}

function updateTabCount(): void {
  const count = detail?.lines.length ?? 0;
  element.tabCount.textContent = count > 0 ? ` · ${count}` : "";
}

/** ← and → move between the tabs, skipping one that is off; Home and End jump. */
function onTabKey(event: KeyboardEvent): void {
  const open = TABS.filter((tab) => !tabButton(tab).disabled);
  const at = open.indexOf(activeTab());
  let next: Tab | undefined;
  if (event.key === "ArrowRight") next = open[Math.min(open.length - 1, at + 1)];
  else if (event.key === "ArrowLeft") next = open[Math.max(0, at - 1)];
  else if (event.key === "Home") next = open[0];
  else if (event.key === "End") next = open[open.length - 1];
  if (!next || next === activeTab()) return;
  event.preventDefault();
  chooseTab(next);
  tabButton(next).focus();
}

// --- Notes -----------------------------------------------------------------------

/** The user's own notes: shown as saved, unless they are typing in them. */
function renderMemo(): void {
  if (!detail) return;
  const typing = document.activeElement === element.memo || memoPending?.id === detail.meeting.id;
  if (!typing && element.memo.value !== detail.meeting.memo) {
    element.memo.value = detail.meeting.memo;
    element.memoState.textContent = "";
  }
  if (!element.notes.hidden) sizeMemo();
}

/** Grows with what is written, so the page scrolls rather than the box. */
function sizeMemo(): void {
  element.memo.style.height = "auto";
  element.memo.style.height = `${Math.max(240, element.memo.scrollHeight + 2)}px`;
}

function onMemoInput(): void {
  if (!openId) return;
  sizeMemo();
  if (memoPending) window.clearTimeout(memoPending.timer);
  element.memoState.textContent = "";
  memoPending = { id: openId, text: element.memo.value, timer: window.setTimeout(() => void flushMemo(), 700) };
}

/** Saves notes still waiting to be; called on a pause, on blur, and on leaving. */
async function flushMemo(): Promise<void> {
  const pending = memoPending;
  if (!pending) return;
  window.clearTimeout(pending.timer);
  memoPending = null;
  try {
    const meeting = await host().setMeetingMemo(pending.id, pending.text);
    if (openId === pending.id && !memoPending) element.memoState.textContent = "Saved";
    const index = meetings.findIndex((entry) => entry.id === meeting.id);
    if (index !== -1) meetings[index] = meeting;
    if (detail && detail.meeting.id === meeting.id) detail.meeting = meeting;
  } catch (error) {
    showError(error);
  }
}

// --- Ask ---------------------------------------------------------------------------

/** The box at the foot: what it can do now, and what was asked so far. */
function renderAsk(): void {
  if (!detail) return;
  const { meeting } = detail;
  const keyed = Boolean(status?.canSummarize);
  const said = detail.lines.length > 0;
  const asked = answers.get(meeting.id) ?? [];
  const waiting = asked.some((entry) => entry.answer === null && entry.error === null);
  element.askInput.disabled = !keyed || !said;
  element.askSend.disabled = !keyed || !said || waiting;
  element.askInput.placeholder = !keyed
    ? "Download a local model or add an OpenRouter key in AI Polish to ask about meetings"
    : !said
      ? meeting.state === "recording"
        ? "Ask once something has been said"
        : "Nothing was said to ask about"
      : waiting
        ? "Thinking…"
        : meeting.state === "recording"
          ? "Ask about what has been said so far"
          : "Ask about this meeting";
  element.ask.classList.toggle("is-off", !keyed);

  element.answers.hidden = asked.length === 0;
  element.answers.replaceChildren(
    ...asked.map((entry, index) => {
      const item = document.createElement("li");
      item.className = "meeting-answer";
      const question = document.createElement("p");
      question.className = "meeting-answer-question";
      question.textContent = entry.question;
      const reply = document.createElement("div");
      reply.className = "meeting-answer-reply";
      if (entry.answer !== null) {
        reply.append(...answerBlocks(entry.answer));
        const copy = copyButton("Copy the answer", () => entry.answer ?? "");
        reply.append(copy);
      } else if (entry.error !== null) {
        reply.classList.add("is-error");
        reply.textContent = entry.error;
      } else {
        reply.classList.add("is-waiting");
        reply.append(listening());
      }
      const dismiss = document.createElement("button");
      dismiss.type = "button";
      dismiss.className = "meeting-answer-dismiss";
      dismiss.setAttribute("aria-label", "Remove this question");
      dismiss.title = "Remove";
      dismiss.append(icon("close"));
      dismiss.addEventListener("click", () => {
        const list = answers.get(meeting.id) ?? [];
        list.splice(index, 1);
        renderAsk();
      });
      item.append(question, reply, dismiss);
      return item;
    }),
  );
  element.answers.scrollTop = element.answers.scrollHeight;
}

/** An answer's text as paragraphs and lists, its "- " lines becoming points. */
function answerBlocks(text: string): HTMLElement[] {
  const blocks: HTMLElement[] = [];
  let list: HTMLUListElement | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) {
      list = null;
      continue;
    }
    const point = /^[-*•]\s+(.*)$/.exec(line);
    if (point) {
      if (!list) {
        list = document.createElement("ul");
        blocks.push(list);
      }
      const item = document.createElement("li");
      item.textContent = point[1]!.replace(/\*\*/g, "");
      list.append(item);
    } else {
      list = null;
      const paragraph = document.createElement("p");
      paragraph.textContent = line.replace(/\*\*/g, "");
      blocks.push(paragraph);
    }
  }
  return blocks;
}

async function ask(): Promise<void> {
  if (!detail || element.askSend.disabled) return;
  const question = element.askInput.value.trim();
  if (!question) return;
  const id = detail.meeting.id;
  const entry: Answer = { question, answer: null, error: null };
  const list = answers.get(id) ?? [];
  list.push(entry);
  answers.set(id, list);
  element.askInput.value = "";
  renderAsk();
  try {
    await flushMemo();
    entry.answer = await host().askMeeting(id, question);
  } catch (error) {
    entry.error = error instanceof Error ? error.message : String(error);
  }
  if (openId === id) {
    renderAsk();
    element.askInput.focus();
  }
}

// --- Menus -------------------------------------------------------------------

type DropdownItem = { label: string; icon?: IconName; run(): void; disabled?: boolean; danger?: boolean } | "divider";

/**
 * A button that opens a small menu beneath it. Closes on a choice, on
 * Escape, on a click anywhere else; the arrows move through it.
 */
function dropdown(trigger: HTMLButtonElement, aria: string, items: DropdownItem[]): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "copy-menu";
  trigger.setAttribute("aria-label", aria);
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", "false");
  const menu = document.createElement("div");
  menu.className = "copy-menu-list";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", aria);

  fillMenu(menu, items);

  const entries = () => Array.from(menu.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)"));
  trigger.addEventListener("click", (event) => {
    const open = wrap.classList.contains("is-open");
    closeMenus();
    if (open) return;
    wrap.classList.add("is-open");
    trigger.setAttribute("aria-expanded", "true");
    // Opened from the keyboard: land on the first choice.
    if (event.detail === 0) entries()[0]?.focus();
  });
  trigger.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" && wrap.classList.contains("is-open")) {
      event.preventDefault();
      entries()[0]?.focus();
    }
  });
  menu.addEventListener("keydown", (event) => {
    const all = entries();
    const at = all.findIndex((entry) => entry === document.activeElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = event.key === "ArrowDown" ? (at + 1) % all.length : (at - 1 + all.length) % all.length;
      all[next]?.focus();
    } else if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      closeMenus();
      trigger.focus();
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      (event.key === "Home" ? all[0] : all[all.length - 1])?.focus();
    }
  });

  wrap.append(trigger, menu);
  return wrap;
}

function fillMenu(menu: HTMLElement, items: DropdownItem[]): void {
  for (const item of items) {
    if (item === "divider") {
      menu.append(document.createElement("hr"));
      continue;
    }
    const entry = document.createElement("button");
    entry.type = "button";
    entry.setAttribute("role", "menuitem");
    entry.tabIndex = -1;
    if (item.icon) entry.append(icon(item.icon, item.icon === "play" || item.icon === "pause"));
    entry.append(item.label);
    entry.disabled = Boolean(item.disabled);
    if (item.danger) entry.classList.add("is-danger");
    entry.addEventListener("click", () => {
      closeMenus();
      item.run();
    });
    menu.append(entry);
  }
}

/**
 * A menu at a point rather than under a button: the right-click one. It goes
 * away with the others: on a choice, Escape, or a click elsewhere.
 */
function floatingMenu(x: number, y: number, aria: string, items: DropdownItem[]): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "copy-menu is-open is-floating";
  const menu = document.createElement("div");
  menu.className = "copy-menu-list";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", aria);
  fillMenu(menu, items);
  wrap.append(menu);
  element.view.append(wrap);

  // Down and right of the pointer, flipped where the window runs out.
  const margin = 8;
  const top = y + menu.offsetHeight > window.innerHeight - margin ? y - menu.offsetHeight : y;
  const left = x + menu.offsetWidth > window.innerWidth - margin ? x - menu.offsetWidth : x;
  wrap.style.top = `${Math.max(margin, top)}px`;
  wrap.style.left = `${Math.max(margin, left)}px`;

  const entries = () => Array.from(menu.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)"));
  menu.addEventListener("keydown", (event) => {
    const all = entries();
    const at = all.findIndex((entry) => entry === document.activeElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = event.key === "ArrowDown" ? (at + 1) % all.length : (at - 1 + all.length) % all.length;
      all[next]?.focus();
    } else if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      event.stopPropagation();
      closeMenus();
    }
  });
  entries()[0]?.focus();
  return wrap;
}

/** Closes every open menu on the page; true if there was one. */
function closeMenus(): boolean {
  let any = false;
  for (const open of element.view.querySelectorAll<HTMLElement>(".copy-menu.is-open")) {
    open.classList.remove("is-open");
    open.querySelector("[aria-haspopup]")?.setAttribute("aria-expanded", "false");
    any = true;
  }
  for (const floating of element.view.querySelectorAll(".copy-menu.is-floating")) {
    floating.remove();
    any = true;
  }
  return any;
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
        otherSide === "heard"
          ? "It is allowed now; the next recording will have both sides."
          : "macOS hadn't given Waveform permission to hear it. Allow it, and the next recording will have both sides.",
        otherSide === "heard"
          ? []
          : [
              linkButton(probing ? "Asking macOS…" : "Allow", () => void probeOtherSide(), true),
              linkButton("Open System Settings", openAudioCaptureSettings),
            ],
      );
    case "nothing-said":
      // The offer above says it with buttons; once kept, a quiet word is enough.
      return shortReason() !== null ? null : banner("info", "Nothing was picked up in this recording.", "", []);
    // These are shown where they matter: in the summary or transcript.
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
  box.setAttribute("role", tone === "error" ? "alert" : "status");
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
  void host().openPrivacySettings("audio-capture").catch(showError);
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
  if (meeting.state === "recording") return;

  const noteOf = (kind: string) => meeting.notes.find((note) => note.kind === kind);

  if (summary) element.summary.append(summaryBar(summary));

  if (meeting.state === "processing") {
    element.summary.append(skeleton());
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
    if (noteOf("nothing-said") || detail.lines.length === 0) {
      const quiet = document.createElement("p");
      quiet.className = "meeting-summary-note";
      quiet.textContent = "Nothing was said, so there is nothing to summarise.";
      element.summary.append(quiet);
    } else if (noteOf("no-summary-key") || !status?.canSummarize) {
      element.summary.append(
        banner("info", "No summary yet.", "Summaries need a local model or an OpenRouter key from AI Polish.", [
          linkButton("Set up", () => options.openAiPolish(), true),
        ]),
      );
    } else if (noteOf("summary-failed")) {
      element.summary.append(
        banner("error", "The summary didn't come through.", noteOf("summary-failed")?.text ?? "", [
          linkButton("Try again", () => void rewriteSummary(), true),
        ]),
      );
    } else if (meeting.summary && noteOf("summary-unparsed")) {
      // Text came back but not in the usual layout.
      const label = document.createElement("p");
      label.className = "meeting-summary-note";
      label.textContent = "Shown as it came back.";
      const raw = document.createElement("pre");
      raw.className = "meeting-summary-raw";
      raw.textContent = meeting.summary;
      element.summary.append(label, raw, linkButton("Try again", () => void rewriteSummary()));
    } else if (meeting.summary) {
      // The host has a summary this page has not fetched yet; it is on its way.
      element.summary.append(skeleton());
    } else {
      element.summary.append(
        banner("info", "No summary yet.", "", [linkButton("Write summary", () => void rewriteSummary(), true)]),
      );
    }
    return;
  }

  const card = document.createElement("div");
  card.className = "summary-card";
  const overview = document.createElement("p");
  overview.className = "meeting-overview";
  overview.textContent = summary.overview;
  card.append(summarySection(null, [summary.overview], overview));
  for (const topic of summary.topics) {
    card.append(summarySection(topic.heading, topic.points));
  }
  card.append(summarySection("Next steps", summary.nextSteps));
  card.append(summarySection("Decisions", summary.decisions));
  element.summary.append(card);
}

/** Over the summary: how long it takes to read, and copying it. */
function summaryBar(summary: MeetingSummary): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "panel-bar";
  const info = document.createElement("span");
  info.className = "panel-bar-info";
  info.append(icon("sparkles"));
  const words = summaryText(summary).split(/\s+/).filter(Boolean).length;
  const label = document.createElement("span");
  label.textContent = `${Math.max(1, Math.round(words / 230))} min read`;
  info.append(label);
  const tools = document.createElement("span");
  tools.className = "panel-bar-tools";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "meeting-icon-button is-plain";
  copy.setAttribute("aria-label", "Copy the summary");
  copy.title = "Copy the summary";
  copy.append(icon("copy"));
  copy.addEventListener("click", () => {
    void navigator.clipboard
      .writeText(summaryText(summary))
      .then(() => options.toast("Summary copied"))
      .catch(showError);
  });
  tools.append(copy);
  bar.append(info, tools);
  return bar;
}

/** The shape of a summary, shimmering, while one is being written or fetched. */
function skeleton(): HTMLElement {
  const box = document.createElement("div");
  box.className = "summary-skeleton";
  box.setAttribute("role", "status");
  box.setAttribute("aria-label", "Summary is being written");
  box.append(...[0, 1, 2, 3, 4].map(() => document.createElement("span")));
  return box;
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
  } else {
    top.append(document.createElement("span"));
  }
  const copy = copyButton(heading ? `Copy ${heading}` : "Copy the overview", () =>
    heading ? `${heading}\n${points.map((point) => `- ${point}`).join("\n")}` : points.join("\n"),
  );
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
    if (points.length === 0) {
      const item = document.createElement("li");
      item.textContent = "None";
      item.style.color = "var(--ink-faint)";
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
  text.textContent = installing
    ? installing.message
    : "Everyone else is shown as one speaker. Tag speakers from the button at the top.";
  element.transcriptNote.append(text);
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
  element.speakersPrompt.hidden = !speakersOpen || meeting.state === "recording" || unnamed.length === 0;
  element.speakersPrompt.textContent = "Who was on the call? Click a name to change it.";

  element.speakers.replaceChildren(
    ...labels.map((label) => {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = `speaker-chip ${speakerClass(label)}${meeting.speakers[label] || label === "me" ? "" : " is-unnamed"}`;
      const dot = document.createElement("span");
      dot.className = "speaker-dot";
      chip.append(dot, speakerName(label, meeting), icon("pencil"));
      chip.title = "Click to rename";
      chip.setAttribute("aria-label", `Rename ${speakerName(label, meeting)}`);
      chip.disabled = meeting.state === "recording" && label !== "me";
      chip.addEventListener("click", () => renameSpeaker(label, chip));
      return chip;
    }),
  );
  element.speakers.hidden = !speakersOpen || labels.length === 0;
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
    if (event.key === "Escape") {
      event.stopPropagation();
      finishEdit(false);
      chip.focus();
    }
  });
  field.addEventListener("blur", () => finishEdit(true));
}

/** The same hue for a voice wherever it appears. */
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

  let previous: string | null | undefined;
  element.lines.replaceChildren(
    ...shown.map((line) => {
      const label = line.speaker ?? "";
      const name = speakerName(line.speaker, meeting);
      const item = document.createElement("li");
      item.className = `meeting-line ${speakerClass(label)}`;
      item.dataset.idx = String(line.idx);
      if (!query && previous !== undefined && previous === line.speaker) item.classList.add("is-continued");
      previous = line.speaker;

      const body = document.createElement("div");
      body.className = "meeting-line-body";

      const head = document.createElement("div");
      head.className = "meeting-line-head";
      const who = document.createElement("span");
      who.className = "meeting-line-speaker";
      who.textContent = label === "me" ? `${name} (you)` : name;
      const time = document.createElement("button");
      time.type = "button";
      time.className = "meeting-line-time";
      time.append(icon("play", true), clock(line.startMs));
      time.title = "Play from here";
      time.setAttribute("aria-label", `Play from ${clock(line.startMs)}`);
      time.disabled = meeting.state === "recording" || !meeting.hasAudio;
      time.addEventListener("click", () => void playFrom(line.startMs));
      head.append(who, time);

      const bubble = document.createElement("div");
      bubble.className = "meeting-line-bubble";
      const text = document.createElement("p");
      text.className = "meeting-line-text";
      text.append(...highlight(line.text, query));
      bubble.append(text, copyButton("Copy this line", () => line.text));

      body.append(head, bubble);
      item.append(body);
      return item;
    }),
  );
  if (detail.lines.length === 0) {
    const empty = document.createElement("li");
    empty.className = "meeting-line is-empty";
    if (meeting.state === "recording") {
      empty.classList.add("is-live");
      empty.append("Listening. Lines appear a few seconds after each sentence ends.", listening());
    } else {
      empty.textContent = meeting.state === "processing" ? "Finishing the last phrases…" : "Nothing was picked up in this recording.";
    }
    element.lines.append(empty);
  } else if (shown.length === 0) {
    const empty = document.createElement("li");
    empty.className = "meeting-line is-empty";
    empty.textContent = "No line matches that.";
    element.lines.append(empty);
  }
  if (meeting.state === "recording" && !query) {
    element.lines.lastElementChild?.scrollIntoView({ block: "nearest", behavior: reducedMotion() ? "auto" : "smooth" });
  }
  updateTabCount();
  renderTranscriptInfo();
  markPlayingLine();
}

/** Over the transcript: how many voices, and how long. */
function renderTranscriptInfo(): void {
  if (!detail) return;
  const voices = new Set(detail.lines.map((line) => line.speaker).filter(Boolean)).size;
  const parts: string[] = [];
  if (voices > 0) parts.push(voices === 1 ? "1 speaker" : `${voices} speakers`);
  const length = detail.meeting.state === "recording" ? Date.now() - (recordingSince ?? detail.meeting.createdAt) : detail.meeting.durationMs;
  if (length > 0) parts.push(clock(length));
  element.transcriptInfo.textContent = parts.join(" · ");
}

/** Three dots that take turns: the page is listening, not stuck. */
function listening(): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "listening";
  wrap.setAttribute("aria-hidden", "true");
  wrap.append(document.createElement("i"), document.createElement("i"), document.createElement("i"));
  return wrap;
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
    audio.addEventListener(name, renderHead);
  }
  for (const name of ["timeupdate", "loadedmetadata", "seeked"]) {
    audio.addEventListener(name, updateProgress);
  }
  playback = { audio, url };
  element.progress.hidden = false;
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
  element.progress.hidden = true;
  markPlayingLine(null);
  if (!playback) return;
  playback.audio.pause();
  URL.revokeObjectURL(playback.url);
  playback = null;
}

/** The bar under the head and the line being heard follow the audio. */
function updateProgress(): void {
  if (!playback || !detail) return;
  const { audio } = playback;
  const fraction = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.currentTime / audio.duration : 0;
  const fill = element.progress.querySelector<HTMLElement>(".meeting-progress-fill");
  if (fill) fill.style.transform = `scaleX(${fraction})`;
  element.progress.setAttribute("aria-valuetext", `${clock(audio.currentTime * 1_000)} of ${clock(audio.duration * 1_000)}`);
  const at = audio.currentTime * 1_000;
  let current: number | null = null;
  for (const line of detail.lines) {
    if (line.startMs <= at) current = line.idx;
    else break;
  }
  markPlayingLine(current);
}

function markPlayingLine(idx?: number | null): void {
  if (idx === undefined) {
    if (!playback || playback.audio.paused) idx = null;
    else {
      updateProgress();
      return;
    }
  }
  element.lines.querySelector(".meeting-line.is-playing")?.classList.remove("is-playing");
  if (idx === null) return;
  element.lines.querySelector(`.meeting-line[data-idx="${idx}"]`)?.classList.add("is-playing");
}

// --- Helpers -----------------------------------------------------------------

function showError(error: unknown): void {
  options.toast(error instanceof Error ? error.message : String(error), { tone: "error" });
}

/** Copy, with a tick in its place for a moment once pressed. */
function copyButton(title: string, text: () => string): HTMLButtonElement {
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "meeting-line-copy";
  copy.append(icon("copy"), "Copy");
  copy.title = title;
  copy.setAttribute("aria-label", title);
  copy.addEventListener("click", () => {
    void navigator.clipboard
      .writeText(text())
      .then(() => copied(copy))
      .catch(showError);
  });
  return copy;
}

function copied(button: HTMLButtonElement): void {
  if (button.dataset.copied) return;
  button.dataset.copied = "1";
  const was = Array.from(button.childNodes);
  button.classList.add("is-copied");
  button.replaceChildren(icon("check"), "Copied");
  setTimeout(() => {
    button.replaceChildren(...was);
    button.classList.remove("is-copied");
    delete button.dataset.copied;
  }, 1_200);
}

function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function clock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  const h = Math.floor(seconds / 3_600);
  const m = Math.floor((seconds % 3_600) / 60);
  const s = seconds % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return `${Math.round(ms / 1_000)} s`;
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

function timeOfDay(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function longWhen(at: number): string {
  const date = new Date(at);
  const days = daysAgo(at);
  const day =
    days === 0 ? "Today" : days === 1 ? "Yesterday" : date.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
  return `${day} at ${timeOfDay(at)}`;
}

function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
}

// --- Icons -------------------------------------------------------------------

/** Lucide outlines, drawn inline so they take the text's colour. */
const ICONS = {
  mic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" x2="12" y1="19" y2="22"/>',
  stop: '<rect width="14" height="14" x="5" y="5" rx="2"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  pause: '<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  pencil:
    '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
  close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  download: '<path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/>',
  headphones:
    '<path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"/>',
  users:
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  sparkles:
    '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>',
  text: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
} as const;

type IconName = keyof typeof ICONS;

function icon(name: IconName, filled = false): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  if (filled) {
    svg.setAttribute("fill", "currentColor");
    svg.setAttribute("stroke", "none");
  } else {
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
  }
  svg.innerHTML = ICONS[name];
  return svg;
}

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
}
