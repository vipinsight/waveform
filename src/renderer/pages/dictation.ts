import {
  getHotkeyBinding,
  hotkeyKeycap,
  isHotkeyBindingId,
  type HotkeyBindingId,
} from "../../shared/hotkeys";
import { getSpeechModel } from "../../shared/models";
import type { AppSettings } from "../../shared/settings";
import { host } from "../host";
import { keycap, requireElement, textNode } from "../ui/dom";
import { patchSettings, state } from "../state";
import { openView } from "../navigation";
import { toggleSettings } from "./settings-panel";
import { setupSteps } from "./setup";

/**
 * The Dictation page: the card that says how to dictate right now, the
 * keyboard the trigger key is chosen on, and the microphone and dictionary
 * notes beneath it. The sidebar's shortcut card is drawn from here too,
 * since it names the same key.
 */

const element = {
  dictationDeck: requireElement<HTMLElement>("dictation-deck"),
  deckStatus: requireElement<HTMLElement>("deck-status"),
  deckTitle: requireElement<HTMLElement>("deck-title"),
  deckDescription: requireElement<HTMLElement>("deck-description"),
  deckKey: requireElement<HTMLElement>("deck-key"),
  deckKeyLabel: requireElement<HTMLElement>("deck-key-label"),
  deckSettings: requireElement<HTMLButtonElement>("deck-settings"),
  dictationSetup: requireElement<HTMLElement>("dictation-setup"),
  dictationKeyboard: requireElement<HTMLElement>("dictation-keyboard"),
  dictationKeyboardCaption: requireElement<HTMLElement>("dictation-keyboard-caption"),
  dictationTryLevel: requireElement<HTMLElement>("dictation-try-level"),
  dictationMicLevel: requireElement<HTMLElement>("dictation-mic-level"),
  dictationMicName: requireElement<HTMLElement>("dictation-mic-name"),
  dictationMicChange: requireElement<HTMLButtonElement>("dictation-mic-change"),
  dictationDictionaryOpen: requireElement<HTMLButtonElement>("dictation-dictionary-open"),
  fnNote: requireElement<HTMLElement>("fn-note"),
  hintKey: requireElement<HTMLElement>("hint-key"),
  shortcutHint: requireElement<HTMLElement>("shortcut-hint"),
  onboard: requireElement<HTMLElement>("onboard"),
  modelDeck: requireElement<HTMLElement>("model-deck"),
  modelDeckStatus: requireElement<HTMLElement>("model-deck-status"),
  modelDeckTitle: requireElement<HTMLElement>("model-deck-title"),
  modelDeckDescription: requireElement<HTMLElement>("model-deck-description"),
  modelDeckLanguage: requireElement<HTMLElement>("model-deck-language"),
  modelDeckPolish: requireElement<HTMLElement>("model-deck-polish"),
};

export function bindDictation(): void {
  element.deckSettings.addEventListener("click", () => {
    element.dictationSetup.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  element.dictationMicChange.addEventListener("click", () => toggleSettings(true, "audio"));
  element.dictationDictionaryOpen.addEventListener("click", () => openView("dictionary"));
  element.dictationKeyboard.addEventListener("click", (event) => {
    const id = (event.target as HTMLElement).closest<HTMLElement>("[data-hotkey]")?.dataset.hotkey;
    if (isHotkeyBindingId(id)) void patchSettings({ hotkeyId: id });
  });
  // The microphone's level while dictating: proof the mic is live before
  // anyone blames the app.
  let levelFade: number | null = null;
  host().onCaptureLevel((level) => {
    const amount = `${Math.min(100, Math.round(Math.sqrt(Math.min(1, level * 4)) * 100))}%`;
    element.dictationTryLevel.style.height = amount;
    element.dictationMicLevel.style.width = amount;
    if (levelFade !== null) window.clearTimeout(levelFade);
    levelFade = window.setTimeout(() => {
      element.dictationTryLevel.style.height = "0%";
      element.dictationMicLevel.style.width = "0%";
    }, 600);
  });
}

/** What this page reads straight from the settings. */
export function renderDictationSettings(next: AppSettings): void {
  element.dictationMicName.textContent =
    next.microphoneDeviceName || "Auto-detect: the built-in microphone unless you pick one";
  renderKeyboard(element.dictationKeyboard, element.dictationKeyboardCaption);
}

/** The key named in the empty state's hint, and the note that only Fn needs. */
export function renderHotkeyLabels(): void {
  const { settings } = state;
  const binding = getHotkeyBinding(settings.hotkeyId);
  const glyph = binding ? hotkeyKeycap(binding) : "—";
  element.hintKey.textContent = glyph;
  element.fnNote.hidden = settings.hotkeyId !== "fn";
}

/** The first thing on Dictation is a live instruction, not a static welcome. */
export function renderDictationDeck(): void {
  const { settings, setupKnown, hotkeyStatus, modelLoading, modelReady } = state;
  const outstanding = setupSteps().filter((step) => !step.done);
  const binding = getHotkeyBinding(settings.hotkeyId);
  const key = binding ? hotkeyKeycap(binding) : "—";

  // One card in this slot at a time. Until dictation works, the thing worth
  // saying is how to make it work -- and until the host has answered, neither
  // is true yet, so the slot stays empty rather than guessing.
  const known = setupKnown && hotkeyStatus !== null;
  element.onboard.hidden = !known || outstanding.length === 0;
  element.modelDeck.hidden = !known || outstanding.length > 0;
  renderModelDeck();

  // The shortcut card lives on the Dictation page. Unfinished setup is said
  // there too, pointing back to the checklist rather than repeating it.
  element.dictationDeck.hidden = !known;
  if (!known) return;
  // As on the polish card: no key reads "Shortcut Off", not "Hold —".
  element.deckKeyLabel.textContent = binding ? "Hold" : "Shortcut";
  element.deckKey.textContent = binding ? key : "Off";
  element.deckSettings.hidden = outstanding.length === 0;
  if (outstanding.length > 0) element.deckStatus.dataset.tone = "attention";
  else delete element.deckStatus.dataset.tone;
  if (outstanding.length > 0) {
    element.deckStatus.textContent = "Setup unfinished";
    element.deckTitle.textContent =
      outstanding.length === 1 ? "One step before you can dictate" : `${outstanding.length} steps before you can dictate`;
    element.deckDescription.textContent = "macOS needs to let Waveform hear you and type for you. The steps are just below.";
    return;
  }

  if (!binding) {
    element.deckStatus.textContent = "Shortcut off";
    element.deckTitle.textContent = "Choose a key to start dictating";
    element.deckDescription.textContent = "Pick a modifier key that will not type into the app you are using.";
    return;
  }

  if (modelLoading) {
    element.deckStatus.textContent = "Preparing speech model";
    element.deckTitle.textContent = "Your words are about to be ready";
    element.deckDescription.textContent = `${getSpeechModel(settings.modelId).label} is loading on this Mac.`;
    return;
  }

  element.deckStatus.textContent = modelReady ? "Ready anywhere" : "Ready on demand";
  element.deckTitle.textContent = `Hold ${key}, talk, let go`;
  element.deckDescription.textContent = modelReady
    ? `Your words land where your cursor is. Tap ${key} twice to keep listening; press it again to finish. Esc throws the phrase away.`
    : "Your speech model wakes when you use the shortcut. Nothing leaves this Mac.";
}

/**
 * The Transcripts card: which model turns speech into these words, whether it
 * is ready, the language it listens for, and what AI Polish does after it.
 */
function renderModelDeck(): void {
  const { settings, setupKnown, modelInstalled, modelLoading, modelReady } = state;
  const missing = setupKnown && !modelInstalled;
  element.modelDeckStatus.textContent = missing
    ? "Not downloaded"
    : modelLoading
      ? "Loading"
      : modelReady
        ? "Ready"
        : "Loads when you dictate";
  if (missing) element.modelDeckStatus.dataset.tone = "attention";
  else delete element.modelDeckStatus.dataset.tone;

  element.modelDeckTitle.textContent = getSpeechModel(settings.modelId).label;
  element.modelDeckDescription.textContent = "Speech model, running on this Mac.";
  element.modelDeckLanguage.textContent = settings.speechLanguage
    ? settings.speechLanguage.toUpperCase()
    : "Auto";

  // On or off only: which model polishes is the AI Polish card's to say, and
  // the label links there.
  element.modelDeckPolish.textContent = settings.polishLevel === "none" ? "Off" : "On";
}

/** The shortcut is the way in, so the sidebar says which one to hold. */
export function renderShortcutCard(): void {
  const { settings, hotkeyStatus } = state;
  const hint = element.shortcutHint;
  hint.replaceChildren();

  // Nothing to hold yet. The card told a new install to hold a key that could
  // not have worked, beside a panel explaining why not.
  hint.hidden = setupSteps().some((step) => !step.done);
  if (hint.hidden) return;

  // With no button on the page, an unusable shortcut would leave no way in at
  // all, so say which one it is instead of repeating the instruction.
  const binding = getHotkeyBinding(settings.hotkeyId);
  if (!binding || hotkeyStatus?.supported === false) {
    hint.append(textNode("Choose a shortcut in Settings to start dictating."));
    return;
  }

  hint.append(
    textNode("Hold "),
    keycap(hotkeyKeycap(binding)),
    textNode(" anywhere in macOS to dictate, or tap twice to keep listening."),
  );
}

/**
 * The two rows of a Mac keyboard that hold every key Waveform can watch.
 *
 * Drawn rather than listed. The whole difference between Left Option and
 * Right Option is which thumb reaches it, and a column of names made you read
 * all six labels to discover that -- while a keyboard says it without a word.
 *
 * `u` is the key's width in twelfths of a letter key -- a grid column count,
 * not a flex weight. Every row sums to 60, so the rows are exactly as wide as
 * each other: with flex and a gap, a row of twelve keys lost twice as much
 * width to gaps as a row of eight and came up visibly short. The keys with no
 * `id` are not offered: Control and the arrows are not held comfortably, the
 * space bar types, and the left Shift has no binding. They are drawn anyway
 * and dimmed, because the ones that can be chosen are only findable relative
 * to the ones that cannot.
 */
interface KeyboardKey {
  id?: HotkeyBindingId;
  glyph: string;
  u: number;
  /** A letter key: drawn as an unlabelled cap, purely to shape the row. */
  filler?: boolean;
}

const KEYBOARD_COLUMNS = 60;

const KEYBOARD_ROWS: readonly (readonly KeyboardKey[])[] = [
  [
    { glyph: "⇧", u: 10 },
    ...Array.from({ length: 10 }, () => ({ glyph: "", u: 4, filler: true })),
    { id: "right-shift", glyph: "⇧", u: 10 },
  ],
  [
    { id: "fn", glyph: "fn", u: 5 },
    { glyph: "⌃", u: 5 },
    { id: "left-option", glyph: "⌥", u: 5 },
    { id: "left-command", glyph: "⌘", u: 7 },
    { glyph: "", u: 21, filler: true },
    { id: "right-command", glyph: "⌘", u: 7 },
    { id: "right-option", glyph: "⌥", u: 5 },
    { glyph: "◀▶", u: 5 },
  ],
];

/**
 * What choosing each key costs you, which the old list did not say at all.
 *
 * Six equally-weighted options with no guidance is not a choice, it is a
 * quiz. These are the reasons somebody would pick one over another.
 */
const KEY_ADVICE: Partial<Record<HotkeyBindingId, string>> = {
  fn: "The default, and the only one here that does nothing else on its own.",
  "left-option": "Option is free on most keyboards, and this one falls under your left thumb.",
  "right-option": "Option is free on most keyboards, and this one falls under your right thumb.",
  "left-command": "Command starts most keyboard shortcuts, so it is the busiest key on this row.",
  "right-command": "Command starts most keyboard shortcuts, so it is the busiest key on this row.",
  "right-shift": "Rarely held on its own, and easy to reach without moving your hand.",
};

/**
 * The keyboard picker, drawn into the wizard or the Dictation page.
 *
 * Rebuilt from `KEYBOARD_ROWS` rather than toggled in place: the rows are
 * static, and one function that draws the whole thing is easier to be sure of
 * than one that draws it and another that edits it.
 */
export function renderKeyboard(target: HTMLElement, caption: HTMLElement): void {
  const { settings } = state;
  for (const row of KEYBOARD_ROWS) {
    const width = row.reduce((total, key) => total + key.u, 0);
    // Not a guard against user input -- a guard against editing the table
    // above and quietly pushing a key onto a second line.
    if (width !== KEYBOARD_COLUMNS) {
      void host().log("error", "wizard", `Keyboard row is ${width} of ${KEYBOARD_COLUMNS} columns`);
    }
  }

  target.replaceChildren(
    ...KEYBOARD_ROWS.map((row) => {
      const line = document.createElement("div");
      line.className = "keyboard-row";
      line.append(
        ...row.map((key) => {
          const binding = key.id ? getHotkeyBinding(key.id) : null;
          // A key that can be chosen is a button; one that cannot is not,
          // so it is not in the tab order and cannot be clicked at all.
          const cap = document.createElement(binding ? "button" : "span");
          cap.className = "keyboard-key";
          cap.style.gridColumn = `span ${key.u}`;
          cap.textContent = key.glyph;
          if (key.filler) cap.dataset.filler = "true";
          if (!binding) {
            cap.dataset.available = "false";
            return cap;
          }
          (cap as HTMLButtonElement).type = "button";
          cap.dataset.hotkey = binding.id;
          cap.setAttribute("role", "radio");
          cap.setAttribute("aria-checked", String(binding.id === settings.hotkeyId));
          cap.setAttribute("aria-label", binding.label);
          cap.title = binding.label;
          return cap;
        }),
      );
      return line;
    }),
  );

  // The glyphs on the keys are shared -- two Commands, two Options -- so the
  // caption is what says which one is chosen, in words.
  const chosen = getHotkeyBinding(settings.hotkeyId);
  caption.replaceChildren();
  if (chosen) {
    const name = document.createElement("strong");
    // The glyph as well as the name. The name is what disambiguates the two
    // Commands and the two Options, and the glyph is what is actually
    // printed on the key you are about to go and hold.
    name.textContent = `${chosen.label} (${hotkeyKeycap(chosen)})`;
    caption.append(name, textNode(` ${KEY_ADVICE[chosen.id] ?? ""}`));
  } else {
    caption.append(textNode("Pick a key to hold while you speak."));
  }
}
