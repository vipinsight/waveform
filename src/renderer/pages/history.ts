import type { DictationUpdate, DictionarySuggestion, SavedDictation } from "../../shared/contracts";
import { getHotkeyBinding, hotkeyKeycap } from "../../shared/hotkeys";
import { getSpeechModel } from "../../shared/models";
import { host } from "../host";
import {
  COPY_ICON,
  EDIT_ICON,
  MORE_ICON,
  PAUSE_ICON,
  PLAY_ICON,
  RETRY_ICON,
  SAVE_AUDIO_ICON,
  TRASH_ICON,
  iconButton,
  iconSvg,
  requireElement,
} from "../ui/dom";
import { audioFileName, formatDay, formatTime } from "../ui/format";
import { state } from "../state";
import { setStatus } from "./overview";
import { setupSteps } from "./setup";

/**
 * The Dictations page: every saved dictation, newest first, with its row
 * menu, playback and in-place editing; the search over them; and the card
 * offered while a failed attempt can still be retried.
 */

const element = {
  history: requireElement<HTMLElement>("history"),
  emptyState: requireElement<HTMLElement>("empty-state"),
  emptyHeadline: requireElement<HTMLElement>("empty-headline"),
  emptyHint: requireElement<HTMLElement>("empty-hint"),
  starter: requireElement<HTMLElement>("starter"),
  starterKey: document.querySelector<HTMLElement>(".starter-key")!,
  dictateNote: requireElement<HTMLElement>("dictate-note"),
  search: requireElement<HTMLElement>("search"),
  searchButton: requireElement<HTMLButtonElement>("search-button"),
  searchField: requireElement<HTMLInputElement>("search-field"),
  onboard: requireElement<HTMLElement>("onboard"),
  modelDeck: requireElement<HTMLElement>("model-deck"),
};

/**
 * A failed dictation whose audio is still held for Retry.
 *
 * Null when there is nothing to retry. Cleared on dismiss, a successful
 * re-transcription, or a new listen.
 */
let pendingRetry: { message: string } | null = null;
/** Active history playback, if any. The list does not re-render for it. */
let playback: {
  id: string;
  audio: HTMLAudioElement;
  context: AudioContext;
  url: string;
  button: HTMLButtonElement;
} | null = null;
let searchOpen = false;
let query = "";
/** The one open row menu: opening another, or clicking away, closes it. */
let entryMenu: { trigger: HTMLButtonElement; close: () => void } | null = null;

export function bindHistory(): void {
  host().onHistoryChanged((next) => {
    // The newest entry is the one that just landed, so it gets the tint.
    state.freshId = next.length > state.entries.length ? (next[0]?.id ?? null) : null;
    state.entries = next;
    renderHistory();
  });
  host().onDictationUpdate(handleDictationUpdate);

  // Without this the field blurs on mousedown, closes itself, and the click
  // that followed reopened it: the icon could never close an empty search.
  element.searchButton.addEventListener("mousedown", (event) => event.preventDefault());
  element.searchButton.addEventListener("click", () => toggleSearch(!searchOpen));
  element.searchField.addEventListener("input", () => {
    query = element.searchField.value.trim();
    renderHistory();
  });
  element.searchField.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      toggleSearch(false);
    }
  });
  // Closing an empty field tidies the head; a field with a term in it stays,
  // so clicking an entry does not silently drop the filter behind it.
  element.searchField.addEventListener("blur", () => {
    if (query === "") toggleSearch(false);
  });

  // Closing the window hides it rather than quitting; a recording must not
  // keep playing from a window nobody can see.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopPlayback();
  });
}

function handleDictationUpdate(update: DictationUpdate): void {
  // The pill outside the app is the listening indicator, and it is the one you
  // can actually see while dictating into another window. Mirroring its state
  // in here gave two things to watch that could disagree, so the sidebar
  // carries only the engine: which model, ready or not, and anything that
  // went wrong.
  const { status } = update;
  const retryable = status.state === "error" && Boolean(status.canRetry);
  const nextRetry = retryable
    ? { message: status.message ?? "Transcription failed." }
    : null;
  const retryChanged =
    (pendingRetry?.message ?? null) !== (nextRetry?.message ?? null) ||
    Boolean(pendingRetry) !== Boolean(nextRetry);
  pendingRetry = nextRetry;
  if (retryChanged) renderHistory();

  // Errors, and the one outcome that is not an error and still needs saying:
  // a polish that changed nothing looks exactly like a shortcut that missed.
  if ((status.state === "error" || status.state === "idle") && status.message) {
    setStatus(status.message);
  }
  else if (state.modelReady) setStatus(`${getSpeechModel(state.settings.modelId).label} ready`);
}

/**
 * The list's resting state, which is the app's only real onboarding.
 *
 * Someone who has never dictated needs to be told what to do; someone who has
 * done it a hundred times needs the panel to be quiet.
 */
export function renderEmptyState(): void {
  const outstanding = setupSteps().filter((step) => !step.done);
  const shortcut = getHotkeyBinding(state.settings.hotkeyId);
  const glyph = shortcut ? hotkeyKeycap(shortcut) : "your shortcut";
  const firstRun = state.lifetimeSessions === 0;

  // The onboarding card is already saying what to do, at length. A second
  // paragraph under it saying the same thing more vaguely is the page talking
  // over itself.
  element.emptyState.hidden = outstanding.length > 0 || !state.setupKnown;
  if (element.emptyState.hidden) return;

  element.starter.hidden = !firstRun;
  element.starterKey.textContent = glyph;

  if (firstRun) {
    element.emptyHeadline.textContent = "You're set. Try it once.";
    element.emptyHint.textContent =
      "Dictation works in any app. Here is the whole thing:";
    return;
  }

  element.emptyHeadline.textContent = "Your words will land here.";
  element.emptyHint.textContent = `Hold ${glyph} anywhere in macOS and speak. Release to transcribe, or tap twice to keep listening.`;
}

/** Renders the saved dictations, newest first, grouped by the day they landed. */
export function renderHistory(): void {
  // Its row is about to be replaced; a menu left floating would act on nothing.
  closeEntryMenu();
  const { entries } = state;
  const matches =
    query === ""
      ? entries
      : entries.filter((entry) => entryMatches(entry, query));

  // Both cards stay in the tree; renderDictationDeck decides which is showing.
  element.history.replaceChildren(element.onboard, element.modelDeck);
  element.history.classList.toggle("is-empty", matches.length === 0 && !pendingRetry);

  if (pendingRetry) element.history.append(renderRetryCard(pendingRetry.message));

  if (matches.length === 0 && query !== "") {
    const note = document.createElement("p");
    note.className = "no-matches";
    note.textContent = `Nothing matches “${query}”.`;
    element.history.append(note);
  } else if (matches.length === 0) {
    // renderEmptyState decides whether it is shown: during setup the
    // onboarding card is already saying all of this.
    element.history.append(element.emptyState);
    renderEmptyState();
  } else {
    for (const day of groupByDay(matches)) element.history.append(renderDay(day));
  }

  element.dictateNote.textContent = describeCount(matches.length);
}

/**
 * Offered while the overlay still holds the failed clips, so Retry does not
 * require speaking again or digging through a log.
 */
function renderRetryCard(message: string): HTMLElement {
  const card = document.createElement("section");
  card.className = "retry-card";

  const title = document.createElement("h2");
  title.className = "retry-title";
  title.textContent = "Dictation failed";

  const body = document.createElement("p");
  body.className = "retry-message";
  body.textContent = message;

  const actions = document.createElement("div");
  actions.className = "retry-actions";

  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "pill-button";
  dismiss.textContent = "Dismiss";
  dismiss.addEventListener("click", () => {
    void host().dismissDictationRetry();
  });

  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "pill-button is-primary";
  retry.textContent = "Retry";
  retry.addEventListener("click", () => {
    void host().retryDictation();
  });

  actions.append(dismiss, retry);
  card.append(title, body, actions);
  return card;
}

function describeCount(matched: number): string {
  const { entries } = state;
  if (entries.length === 0) return "";
  if (query !== "") return `${matched.toLocaleString()} of ${entries.length.toLocaleString()}`;
  return `${entries.length.toLocaleString()} ${entries.length === 1 ? "dictation" : "dictations"}`;
}

/** Consecutive runs, not a map: the list is already ordered by time. */
function groupByDay(list: SavedDictation[]): SavedDictation[][] {
  const days: SavedDictation[][] = [];
  let key = "";
  let current: SavedDictation[] = [];
  for (const entry of list) {
    const day = new Date(entry.createdAt).toDateString();
    if (day !== key) {
      current = [];
      days.push(current);
      key = day;
    }
    current.push(entry);
  }
  return days;
}

function renderDay(day: SavedDictation[]): HTMLElement {
  const section = document.createElement("section");
  section.className = "day";

  const label = document.createElement("h2");
  label.className = "day-label";
  label.textContent = formatDay(day[0]?.createdAt ?? Date.now());

  const card = document.createElement("div");
  card.className = "entry-card";
  for (const entry of day) card.append(renderEntry(entry));

  section.append(label, card);
  return section;
}

/**
 * Whether a search hits an entry. The words as spoken count as well as the
 * polished ones: what someone remembers saying is not always what polish
 * left on the page.
 */
function entryMatches(entry: SavedDictation, query: string): boolean {
  const needle = query.toLowerCase();
  if (entry.text.toLowerCase().includes(needle)) return true;
  return Boolean(entry.transcribedText?.toLowerCase().includes(needle));
}

/** Which models made an entry, for the tooltip on its time. */
function entryProvenance(entry: SavedDictation): string {
  const parts: string[] = [];
  if (entry.speechModel && entry.speechModel !== "unknown") {
    parts.push(`Transcribed by ${entry.speechModel}`);
  }
  if (entry.polishModel) parts.push(`Polished by ${entry.polishModel}`);
  return parts.join("\n");
}

function renderEntry(entry: SavedDictation): HTMLElement {
  const article = document.createElement("article");
  const isActive = playback?.id === entry.id;
  article.className = [
    entry.id === state.freshId ? "entry is-fresh" : "entry",
    isActive ? "is-playing" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const time = document.createElement("span");
  time.className = "entry-time";
  time.textContent = formatTime(entry.createdAt);
  time.title = [new Date(entry.createdAt).toLocaleString(), entryProvenance(entry)]
    .filter(Boolean)
    .join("\n");

  const text = document.createElement("p");
  text.className = "entry-text";
  text.textContent = entry.text;
  text.title = "Double-click to edit";
  text.addEventListener("dblclick", () => beginEntryEdit(entry, text));

  const actions = document.createElement("span");
  actions.className = "entry-actions";
  if (entry.hasAudio) {
    const playing = Boolean(isActive && playback && !playback.audio.paused);
    const play = iconButton(
      playing ? "Pause audio" : "Play audio",
      playing ? PAUSE_ICON : PLAY_ICON,
      `is-play${playing ? " is-playing" : ""}`,
      () => {
        void togglePlayback(entry.id, play);
      },
    );
    play.dataset.playId = entry.id;
    if (isActive) playback!.button = play;
    actions.append(play);
  }
  // Play and Copy are the everyday actions and stay on the row; the rest
  // (one of them destructive) wait behind the menu.
  actions.append(
    iconButton("Copy", COPY_ICON, "", () => {
      void navigator.clipboard.writeText(entry.text);
    }),
    entryMenuButton(entry, text),
  );

  article.append(time, text, actions);
  return article;
}

interface EntryMenuItem {
  label: string;
  icon: string;
  danger?: boolean;
  onSelect: () => void;
}

function entryMenuButton(entry: SavedDictation, text: HTMLElement): HTMLButtonElement {
  const trigger = iconButton("More actions", MORE_ICON, "is-more", () => {
    if (entryMenu?.trigger === trigger) {
      closeEntryMenu();
      return;
    }
    openEntryMenu(trigger, entryMenuItems(entry, trigger, text));
  });
  trigger.setAttribute("aria-haspopup", "menu");
  trigger.setAttribute("aria-expanded", "false");
  return trigger;
}

function entryMenuItems(
  entry: SavedDictation,
  trigger: HTMLButtonElement,
  text: HTMLElement,
): EntryMenuItem[] {
  const items: EntryMenuItem[] = [];
  if (entry.transcribedText !== "" || !entry.hasAudio) {
    items.push({
      label: "Edit text",
      icon: EDIT_ICON,
      onSelect: () => beginEntryEdit(entry, text),
    });
  }
  if (entry.hasAudio) {
    items.push({
      label: "Retry transcript",
      icon: RETRY_ICON,
      // The trigger shows the busy state: the menu is gone by then.
      onSelect: () => void retryHistoryTranscription(entry, trigger, text),
    });
  }
  // Polish rewrote this one; the words as spoken are still worth having.
  if (entry.polishedText && entry.transcribedText) {
    const original = entry.transcribedText;
    items.push({
      label: "Copy original transcript",
      icon: COPY_ICON,
      onSelect: () => void navigator.clipboard.writeText(original),
    });
  }
  items.push({
    label: "Delete transcript",
    icon: TRASH_ICON,
    danger: true,
    onSelect: () => deleteEntry(entry),
  });
  if (entry.hasAudio) {
    items.push({
      label: "Save audio",
      icon: SAVE_AUDIO_ICON,
      onSelect: () => void saveEntryAudio(entry),
    });
  }
  return items;
}

/**
 * Floats the menu on the body, beside its trigger.
 *
 * Inside the row it would be clipped by the day card's rounded corners, and
 * the last row of the list has no room below it, so it flips above.
 */
function openEntryMenu(trigger: HTMLButtonElement, items: EntryMenuItem[]): void {
  closeEntryMenu();
  const menu = document.createElement("div");
  menu.className = "entry-menu";
  menu.setAttribute("role", "menu");
  const buttons = items.map((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = item.danger ? "entry-menu-item is-danger" : "entry-menu-item";
    button.setAttribute("role", "menuitem");
    button.innerHTML = iconSvg(item.icon);
    const label = document.createElement("span");
    label.textContent = item.label;
    button.append(label);
    button.addEventListener("click", () => {
      closeEntryMenu();
      item.onSelect();
    });
    return button;
  });
  menu.append(...buttons);
  document.body.append(menu);

  const anchor = trigger.getBoundingClientRect();
  const gap = 6;
  const margin = 8;
  const below = anchor.bottom + gap;
  const top =
    below + menu.offsetHeight > window.innerHeight - margin
      ? anchor.top - gap - menu.offsetHeight
      : below;
  const left = Math.min(anchor.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - margin);
  menu.style.top = `${Math.max(margin, top)}px`;
  menu.style.left = `${Math.max(margin, left)}px`;

  const row = trigger.closest(".entry");
  trigger.setAttribute("aria-expanded", "true");
  row?.classList.add("is-menu-open");
  buttons[0]?.focus();

  const onPointer = (event: PointerEvent): void => {
    const target = event.target as Node;
    if (!menu.contains(target) && !trigger.contains(target)) closeEntryMenu();
  };
  // Captured, so Escape closes this menu and not Settings behind it.
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeEntryMenu();
      trigger.focus();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    buttons[(current + step + buttons.length) % buttons.length]?.focus();
  };
  // A floating menu left behind by a scroll points at the wrong row.
  const onMove = (): void => closeEntryMenu();

  document.addEventListener("pointerdown", onPointer, true);
  document.addEventListener("keydown", onKey, true);
  document.addEventListener("scroll", onMove, true);
  window.addEventListener("resize", onMove);
  window.addEventListener("blur", onMove);

  entryMenu = {
    trigger,
    close: () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("blur", onMove);
      menu.remove();
      trigger.setAttribute("aria-expanded", "false");
      row?.classList.remove("is-menu-open");
    },
  };
}

function closeEntryMenu(): void {
  const current = entryMenu;
  entryMenu = null;
  current?.close();
}

function deleteEntry(entry: SavedDictation): void {
  if (playback?.id === entry.id) stopPlayback();
  void host().deleteDictation(entry.id).then((next) => {
    state.entries = next;
    state.freshId = null;
    renderHistory();
  });
}

async function saveEntryAudio(entry: SavedDictation): Promise<void> {
  try {
    const path = await host().saveDictationAudio(entry.id, audioFileName(entry.createdAt));
    setStatus(`Saved ${path.split("/").pop() ?? "the audio"} to Downloads`);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Turns an entry's text into a field, saving on Enter or blur.
 *
 * A correction here is the one moment the app can see what the engine wrote
 * and what the user meant side by side, so the save also asks the dictionary
 * what it would learn, and offers that under the row.
 */
function beginEntryEdit(entry: SavedDictation, text: HTMLElement): void {
  if (text.parentElement?.querySelector(".entry-editor")) return;
  const before = entry.text;
  const editor = document.createElement("textarea");
  editor.className = "entry-editor";
  editor.value = before;
  editor.rows = Math.max(1, Math.min(6, Math.ceil(before.length / 70)));
  editor.setAttribute("aria-label", "Edit transcript");
  text.replaceWith(editor);
  editor.focus();
  editor.setSelectionRange(editor.value.length, editor.value.length);

  let settled = false;
  const finish = (save: boolean) => {
    if (settled) return;
    settled = true;
    const after = editor.value.trim();
    editor.replaceWith(text);
    if (!save || !after || after === before) return;
    void saveEntryEdit(entry, after, text);
  };
  editor.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      finish(false);
    }
  });
  editor.addEventListener("blur", () => finish(true));
}

async function saveEntryEdit(entry: SavedDictation, after: string, text: HTMLElement): Promise<void> {
  try {
    const outcome = await host().editDictation(entry.id, after);
    state.entries = outcome.entries;
    entry.text = after;
    text.textContent = after;
    setStatus("Transcript updated");
    const row = text.closest(".entry");
    if (row && outcome.suggestions.length > 0) {
      offerSuggestions(row as HTMLElement, outcome.suggestions);
    }
    if (outcome.added.length > 0) {
      const names = outcome.added.map((added) => added.text).join(", ");
      setStatus(`Added ${names} to the dictionary`);
    }
  } catch (error) {
    text.textContent = entry.text;
    setStatus(error instanceof Error ? error.message : String(error));
  }
}

/**
 * One line under the row per suggestion: add it, or not this time.
 *
 * Asked, never assumed: an edit is as often a rewording as a fix, and a
 * dictionary full of rewordings makes every prompt worse.
 */
function offerSuggestions(row: HTMLElement, suggestions: DictionarySuggestion[]): void {
  row.querySelectorAll(".entry-suggest").forEach((node) => node.remove());
  for (const suggestion of suggestions) {
    const bar = document.createElement("div");
    bar.className = "entry-suggest";
    bar.setAttribute("role", "status");

    const prompt = document.createElement("span");
    prompt.className = "entry-suggest-text";
    prompt.append("Add ");
    const term = document.createElement("strong");
    term.textContent = suggestion.text;
    prompt.append(term, " to the dictionary? It was heard as ");
    const heard = document.createElement("em");
    heard.textContent = suggestion.heardAs;
    prompt.append(heard, ".");

    const add = document.createElement("button");
    add.type = "button";
    add.className = "pill-button is-primary is-small";
    add.textContent = "Add";
    add.addEventListener("click", () => {
      add.disabled = true;
      void host()
        .addDictionaryTerm(suggestion.text, [suggestion.heardAs], true)
        .then(() => {
          bar.remove();
          setStatus(`Added ${suggestion.text} to the dictionary`);
        })
        .catch((error: unknown) => {
          add.disabled = false;
          setStatus(error instanceof Error ? error.message : String(error));
        });
    });

    const skip = document.createElement("button");
    skip.type = "button";
    skip.className = "pill-button is-small";
    skip.textContent = "Not now";
    skip.addEventListener("click", () => {
      bar.remove();
      void host().declineDictionarySuggestion(suggestion).catch(() => {});
    });

    bar.append(prompt, add, skip);
    row.after(bar);
  }
}

/** Runs the speech engine again on a saved recording and updates that row. */
async function retryHistoryTranscription(
  entry: SavedDictation,
  button: HTMLButtonElement,
  text: HTMLElement,
): Promise<void> {
  if (button.disabled) return;
  button.disabled = true;
  button.classList.add("is-busy");
  setStatus("Retrying transcription…");
  try {
    const bytes = await host().getDictationAudio(entry.id);
    const { text: transcribed } = await host().transcribe(bytes);
    const trimmed = transcribed.trim();
    if (!trimmed) {
      setStatus("No words found in that recording.");
      return;
    }
    state.entries = await host().updateDictation(entry.id, trimmed);
    state.freshId = entry.id;
    entry.text = trimmed;
    text.textContent = trimmed;
    setStatus("Transcription updated");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error));
  } finally {
    button.disabled = false;
    button.classList.remove("is-busy");
  }
}

/**
 * Plays or pauses a saved recording without rebuilding the list.
 *
 * Clips are stored at the level the speech engine wants, which is quiet for
 * listening. Peak-normalising on the way out keeps the beginning audible
 * without changing what was sent to the model.
 */
async function togglePlayback(id: string, button: HTMLButtonElement): Promise<void> {
  if (playback?.id === id) {
    if (playback.audio.paused) {
      await playback.audio.play();
      setPlaybackButton(button, true);
      button.closest(".entry")?.classList.add("is-playing");
    } else {
      playback.audio.pause();
      setPlaybackButton(button, false);
    }
    return;
  }

  stopPlayback();
  try {
    const bytes = await host().getDictationAudio(id);
    const copy = new Uint8Array(bytes);
    const decoded = await decodeAudioPeak(copy);
    const blob = new Blob([copy], { type: "audio/wav" });
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    const context = new AudioContext();
    const source = context.createMediaElementSource(audio);
    const gain = context.createGain();
    gain.gain.value = decoded;
    source.connect(gain);
    gain.connect(context.destination);
    playback = { id, audio, context, url, button };
    audio.addEventListener("ended", () => {
      if (playback?.id === id) {
        setPlaybackButton(button, false);
        button.closest(".entry")?.classList.remove("is-playing");
        stopPlayback();
      }
    });
    button.closest(".entry")?.classList.add("is-playing");
    setPlaybackButton(button, true);
    await audio.play();
  } catch (error) {
    stopPlayback();
    setPlaybackButton(button, false);
    setStatus(error instanceof Error ? error.message : String(error));
  }
}

/** Peak-normalise gain for a WAV, without holding the decoded buffer. */
async function decodeAudioPeak(bytes: Uint8Array): Promise<number> {
  const context = new AudioContext();
  try {
    const copy = new Uint8Array(bytes);
    const buffer = await context.decodeAudioData(copy.buffer);
    return listeningGain(buffer);
  } finally {
    void context.close();
  }
}

/** Lift a quiet ASR clip to a comfortable listening level without clipping. */
function listeningGain(buffer: AudioBuffer): number {
  let peak = 0;
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let index = 0; index < data.length; index += 1) {
      peak = Math.max(peak, Math.abs(data[index] ?? 0));
    }
  }
  if (peak < 0.001) return 1;
  return Math.min(8, 0.85 / peak);
}

function setPlaybackButton(button: HTMLButtonElement, playing: boolean): void {
  const label = playing ? "Pause audio" : "Play audio";
  button.title = label;
  button.setAttribute("aria-label", label);
  button.classList.toggle("is-playing", playing);
  button.innerHTML = iconSvg(playing ? PAUSE_ICON : PLAY_ICON);
}

export function stopPlayback(): void {
  const current = playback;
  playback = null;
  if (!current) return;
  current.button.closest(".entry")?.classList.remove("is-playing");
  setPlaybackButton(current.button, false);
  current.audio.pause();
  current.audio.removeAttribute("src");
  current.audio.load();
  void current.context.close();
  URL.revokeObjectURL(current.url);
}

function toggleSearch(open: boolean): void {
  searchOpen = open;
  element.search.classList.toggle("is-open", open);
  element.searchButton.setAttribute("aria-expanded", String(open));

  if (open) {
    element.searchField.focus();
    return;
  }
  element.searchField.value = "";
  if (query !== "") {
    query = "";
    renderHistory();
  }
}
