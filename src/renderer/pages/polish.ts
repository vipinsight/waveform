import type { AiStatus } from "../../shared/contracts";
import { isPolishLevel, type PolishLevel } from "../../shared/polish-levels";
import { polishModelLabel } from "../../shared/polish-models";
import { DEFAULT_POLISH_PROMPT, SUGGESTED_MODELS, transformPromptFor } from "../../shared/prompts";
import { POLISH_SHORTCUTS, type AppSettings } from "../../shared/settings";
import { host } from "../host";
import { flash, requireElement } from "../ui/dom";
import { describeAccelerator, nameAccelerator, promptPreview } from "../ui/format";
import { patchSettings, state } from "../state";
import { renderModelKinds, renderPolishModels } from "./models";
import { isSettingsOpen, setScrimHidden, toggleSettings } from "./settings-panel";
import { refreshWizardKey } from "./wizard";

/**
 * The AI Polish page: how much a dictation may be rewritten, where the
 * rewriting runs, the key or model that needs, the shortcut that polishes a
 * selection, and the two instructions behind both -- with the editor that
 * opens over the window to change them.
 */

const element = {
  openOpenRouter: requireElement<HTMLButtonElement>("open-openrouter"),
  keyInput: requireElement<HTMLInputElement>("key-input"),
  keySave: requireElement<HTMLButtonElement>("key-save"),
  keyRemove: requireElement<HTMLButtonElement>("key-remove"),
  keyState: requireElement<HTMLElement>("key-state"),
  aiModel: requireElement<HTMLSelectElement>("ai-model"),
  polishLevels: requireElement<HTMLElement>("polish-levels"),
  cleanupWhat: requireElement<HTMLElement>("cleanup-what"),
  cleanupTyped: requireElement<HTMLElement>("cleanup-typed"),
  polishLevelHint: requireElement<HTMLElement>("polish-level-hint"),
  polishModelLine: requireElement<HTMLElement>("polish-model-line"),
  polishBlockerText: requireElement<HTMLElement>("polish-blocker-text"),
  polishBlockerAction: requireElement<HTMLButtonElement>("polish-blocker-action"),
  transformPromptWhere: requireElement<HTMLElement>("transform-prompt-where"),
  transformPromptPreview: requireElement<HTMLElement>("transform-prompt-preview"),
  polishPromptPreview: requireElement<HTMLElement>("polish-prompt-preview"),
  polishShortcut: requireElement<HTMLElement>("polish-shortcut"),
  polishShortcutCaption: requireElement<HTMLElement>("polish-shortcut-caption"),
  polishDeckStatus: requireElement<HTMLElement>("polish-deck-status"),
  polishDeckTitle: requireElement<HTMLElement>("polish-deck-title"),
  polishDeckDescription: requireElement<HTMLElement>("polish-deck-description"),
  polishDeckKey: requireElement<HTMLElement>("polish-deck-key"),
  polishDeckKeyLabel: requireElement<HTMLElement>("polish-deck-key-label"),
  polishDeckDictation: requireElement<HTMLElement>("polish-deck-dictation"),
  polishEngine: requireElement<HTMLElement>("polish-engine"),
  promptEditor: requireElement<HTMLElement>("prompt-editor"),
  promptEditorTitle: requireElement<HTMLElement>("prompt-editor-title"),
  promptEditorWhere: requireElement<HTMLElement>("prompt-editor-where"),
  promptEditorBody: requireElement<HTMLTextAreaElement>("prompt-editor-body"),
  promptEditorReset: requireElement<HTMLButtonElement>("prompt-editor-reset"),
  promptEditorSave: requireElement<HTMLButtonElement>("prompt-editor-save"),
};

/**
 * A stand-in for a saved key.
 *
 * The key is write-only: it goes to the keychain and is never handed back, so
 * the field can only ever show that one exists. `pristine` marks the mask as
 * untouched, which is what stops Save from writing these bullets in as the key.
 */
export const KEY_MASK = "•".repeat(20);

/** Which instruction the popup is editing, if any. */
let promptEditorKind: "transform" | "polish" | null = null;
/** Whether closing the popup should put the settings panel back where it was. */
let promptEditorFromSettings = false;

export function isPromptEditorOpen(): boolean {
  return promptEditorKind !== null;
}

/** The controls the markup leaves empty: one keycap per shortcut, one option per model. */
export function populatePolishControls(): void {
  for (const accelerator of POLISH_SHORTCUTS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "keyboard-key shortcut-key";
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", "false");
    button.setAttribute("aria-label", nameAccelerator(accelerator));
    button.dataset.shortcut = accelerator;
    // A keycap, so the glyphs alone: "⌥1". The card and caption spell it out.
    button.textContent = describeAccelerator(accelerator).replace(" + ", "");
    element.polishShortcut.append(button);
  }
  for (const model of SUGGESTED_MODELS) {
    element.aiModel.append(new Option(model, model));
  }
}

export function bindPolish(): void {
  element.polishEngine.addEventListener("click", (event) => {
    const engine = (event.target as HTMLElement).closest<HTMLElement>("[data-engine]")
      ?.dataset.engine;
    if (engine === "local" || engine === "openrouter") {
      void patchSettings({ polishEngine: engine });
    }
  });
  // Typing anything means the field no longer holds the placeholder mask.
  element.keyInput.addEventListener("input", () => {
    element.keyInput.dataset.pristine = "false";
    syncKeyButtons();
  });
  // Save is the only way the key changes. Typing edits the field and nothing
  // more, so a half-pasted key cannot be committed by a stray keystroke.
  element.keySave.addEventListener("click", saveApiKey);
  element.keyRemove.addEventListener("click", removeApiKey);
  element.aiModel.addEventListener("change", () => {
    void patchSettings({ openRouterModel: element.aiModel.value });
  });
  // A level is also an instruction, so choosing one writes that instruction.
  // An edit made to the previous level's text is not carried across: it was
  // written about a different amount of rewriting. None writes nothing, so
  // turning polish off and on again leaves an edited instruction alone.
  element.polishLevels.addEventListener("click", (event) => {
    const card = (event.target as HTMLElement).closest<HTMLElement>("[data-level]");
    const level = card?.dataset.level;
    if (!isPolishLevel(level) || level === state.settings.polishLevel) return;
    void patchSettings(
      level === "none"
        ? { polishLevel: level }
        : { polishLevel: level, transformPrompt: transformPromptFor(level) },
    );
  });
  element.polishShortcut.addEventListener("click", (event) => {
    const shortcut = (event.target as HTMLElement).closest<HTMLElement>("[data-shortcut]")
      ?.dataset.shortcut;
    if (shortcut && shortcut !== state.settings.polishShortcut) {
      void patchSettings({ polishShortcut: shortcut });
    }
  });
  for (const card of Array.from(
    document.querySelectorAll<HTMLButtonElement>(".prompt-card[data-prompt]"),
  )) {
    card.addEventListener("click", () => {
      const kind = card.dataset.prompt;
      if (kind === "transform" || kind === "polish") togglePromptEditor(true, kind);
    });
  }
  element.promptEditorReset.addEventListener("click", () => {
    if (!promptEditorKind) return;
    element.promptEditorBody.value =
      promptEditorKind === "transform"
        ? transformPromptFor(state.settings.polishLevel)
        : DEFAULT_POLISH_PROMPT;
    element.promptEditorBody.focus();
  });
  element.promptEditorSave.addEventListener("click", () => {
    if (!promptEditorKind) return;
    const value = element.promptEditorBody.value;
    const patch =
      promptEditorKind === "transform" ? { transformPrompt: value } : { polishPrompt: value };
    void patchSettings(patch).then(() => togglePromptEditor(false));
  });
  element.openOpenRouter.addEventListener("click", () => {
    void host().openUrl("https://openrouter.ai/keys");
  });
}

/** Everything on this page that is read straight from the settings. */
export function renderPolishSettings(next: AppSettings): void {
  // A model chosen before this list existed is still a valid choice, so it is
  // added rather than silently swapped for the first option.
  if (!SUGGESTED_MODELS.some((model) => model === next.openRouterModel)) {
    element.aiModel.append(new Option(next.openRouterModel, next.openRouterModel));
  }
  element.aiModel.value = next.openRouterModel;
  renderPolishEngine(next.polishEngine);
  renderPolishModelLine();
  renderPolishLevel(next.polishLevel);
  renderPromptPreviews(next);
  renderPolishShortcut(next.polishShortcut);
}

export function renderAiStatus(status: AiStatus): void {
  state.aiStatus = status;
  // The wizard shows the same key, so it is repainted from the same status.
  refreshWizardKey();
  // Never overwrite an edit in progress: reopening settings used to discard a
  // key that had been typed but not yet saved.
  if (element.keyInput.dataset.pristine !== "false") {
    element.keyInput.value = status.hasApiKey ? KEY_MASK : "";
    element.keyInput.dataset.pristine = "true";
  }
  element.keyState.classList.toggle("key-saved", status.hasApiKey && !status.memoryOnly);

  element.keyState.textContent = status.memoryOnly ? "This session only" : "";

  // Nothing to fetch once there is a key, and the row is long enough already.
  element.openOpenRouter.hidden = status.hasApiKey;
  element.keyRemove.hidden = !status.hasApiKey;
  syncKeyButtons();

  // Nothing above None can run until there is something to run it with, so
  // the levels that need one say where to get it rather than being selectable
  // and then quietly doing nothing.
  const ready = status.engine === "local" ? status.localReady : status.hasApiKey;
  const local = status.engine === "local";
  element.polishBlockerText.textContent = local
    ? `Active needs ${polishModelLabel(status.localModelId)} on this Mac.`
    : "Active needs an OpenRouter key.";
  element.polishBlockerAction.textContent = local ? "Download it" : "Add a key";
  element.polishLevelHint.hidden = ready;
  renderModelKinds();
  for (const card of polishLevelCards()) {
    card.disabled = !ready && card.dataset.level !== "none";
  }
  renderPolishDeck();
}

function polishLevelCards(): HTMLButtonElement[] {
  return Array.from(element.polishLevels.querySelectorAll<HTMLButtonElement>("[data-level]"));
}

function renderPolishLevel(level: PolishLevel): void {
  for (const card of polishLevelCards()) {
    card.setAttribute("aria-checked", String(card.dataset.level === level));
  }
  element.cleanupWhat.textContent =
    level === "none"
      ? "Off: typed exactly as you said it, mistakes included."
      : "Filler words and grammar fixed, by the model on the AI Polish page.";
  element.cleanupTyped.textContent =
    level === "none"
      ? "so um i was thinking maybe we could push the demo to thursday the API stuff isn't isn't quite done"
      : "I was thinking maybe we could push the demo to Thursday. The API stuff isn't quite done.";
}

function renderPolishShortcut(shortcut: string): void {
  for (const button of Array.from(
    element.polishShortcut.querySelectorAll<HTMLElement>("[data-shortcut]"),
  )) {
    button.setAttribute("aria-checked", String(button.dataset.shortcut === shortcut));
  }
  const name = document.createElement("strong");
  // Written like the Dictation caption's "Right Option (⌥→)": the name, then
  // the keycap it appears as.
  name.textContent =
    shortcut === "none"
      ? "Off."
      : `${nameAccelerator(shortcut)} (${describeAccelerator(shortcut).replace(" + ", "")})`;
  element.polishShortcutCaption.replaceChildren(
    name,
    shortcut === "none"
      ? " Pick a key to polish selected text from any app."
      : " Select text in any app and press it. Nothing selected? It takes the field you are typing in.",
  );
  renderPolishDeck();
}

/**
 * The card at the top of AI Polish: the shortcut, whether polish can run, and
 * what it does to a dictation. Read from settings and the AI status together,
 * so it is repainted whenever either changes.
 */
function renderPolishDeck(): void {
  const { settings, aiStatus } = state;
  const shortcut = settings.polishShortcut;
  const local = settings.polishEngine === "local";
  const ready = aiStatus === null ? null : local ? aiStatus.localReady : aiStatus.hasApiKey;

  element.polishDeckStatus.textContent =
    ready === false
      ? local
        ? "Model not downloaded"
        : "Needs an OpenRouter key"
      : shortcut === "none"
        ? "Shortcut off"
        : "Ready anywhere";
  if (ready === false) element.polishDeckStatus.dataset.tone = "attention";
  else delete element.polishDeckStatus.dataset.tone;

  element.polishDeckTitle.textContent =
    shortcut === "none" ? "Polish is off for selections" : `Select text, press ${describeAccelerator(shortcut)}`;
  element.polishDeckDescription.textContent =
    shortcut === "none"
      ? "Choose a shortcut below to fix selected text in place, in any app."
      : "Spelling, grammar, punctuation and capitals fixed in place, in any app.";
  // "Press Off" read as an instruction to press a key called Off.
  element.polishDeckKeyLabel.textContent = shortcut === "none" ? "Shortcut" : "Press";
  element.polishDeckKey.textContent = describeAccelerator(shortcut).replace(" + ", "");
  element.polishDeckDictation.textContent =
    settings.polishLevel === "none" ? "Inserted as spoken" : "Cleaned up before it is typed";
}

/**
 * Which engine is selected, and therefore which half of the page applies.
 *
 * The two halves are not alternatives to read side by side: a key is nothing to
 * a local model and a download is nothing to a hosted one. So the other half is
 * hidden rather than dimmed.
 */
function renderPolishEngine(engine: AppSettings["polishEngine"]): void {
  for (const button of Array.from(
    element.polishEngine.querySelectorAll<HTMLElement>("[data-engine]"),
  )) {
    button.setAttribute("aria-checked", String(button.dataset.engine === engine));
  }
  for (const section of Array.from(
    document.querySelectorAll<HTMLElement>("[data-engine-only]"),
  )) {
    section.hidden = section.dataset.engineOnly !== engine;
  }
  if (engine === "local") void renderPolishModels();
  // Switching engines changes what "ready" means, and the rows that say so were
  // drawn for the other one.
  const { aiStatus } = state;
  if (aiStatus && aiStatus.engine !== engine) {
    void host().getAiStatus().then(renderAiStatus);
  }
}

/**
 * Names the polish model on the AI Polish page, since that is where the
 * level it serves is chosen -- and "which model" was otherwise only answered
 * two screens away.
 */
export function renderPolishModelLine(): void {
  const { settings } = state;
  element.polishModelLine.textContent =
    settings.polishEngine === "local"
      ? `${polishModelLabel(settings.localModelId)}, on this Mac`
      : `${settings.openRouterModel}, through OpenRouter`;
  renderModelKinds();
  renderPolishDeck();
}

/** Saves, replaces or removes the key depending on what the field holds. */
function saveApiKey(): void {
  const value = element.keyInput.value.trim();
  if (element.keyInput.dataset.pristine === "true" || !value) return;

  void host()
    .setOpenRouterKey(value)
    .then((status) => {
      element.keyInput.dataset.pristine = "true";
      renderAiStatus(status);
      flash(element.keySave, "Saved");
    });
}

/**
 * Removing is its own button rather than a mode of saving.
 *
 * Saving an empty field used to delete the key, which is a destructive action
 * hidden inside a button that says Save -- and the only sign of which was the
 * word the button flashed afterwards.
 */
function removeApiKey(): void {
  void host()
    .clearOpenRouterKey()
    .then((status) => {
      element.keyInput.dataset.pristine = "true";
      renderAiStatus(status);
    });
}

/** Save is only offered when there is an edit worth saving. */
function syncKeyButtons(): void {
  const edited = element.keyInput.dataset.pristine === "false";
  element.keySave.disabled = !edited || element.keyInput.value.trim().length === 0;
}

/**
 * Opens or closes the instruction editor over the settings panel.
 *
 * The cards only show a preview; editing happens here so two long prompts do
 * not take the whole page. Reset puts the selected level's default back into
 * the field; Save is what writes it. Closing without Save leaves the stored
 * prompt alone.
 *
 * The panel is closed underneath rather than stacked with, because two dialogs
 * deep is one too many to find the way out of -- and put back on the way out,
 * since the cards that open this are on one of its pages.
 */
export function togglePromptEditor(open: boolean, kind: "transform" | "polish" = "transform"): void {
  if (!open) {
    promptEditorKind = null;
    element.promptEditor.hidden = true;
    if (promptEditorFromSettings) {
      promptEditorFromSettings = false;
      toggleSettings(true);
      return;
    }
    setScrimHidden(!isSettingsOpen());
    return;
  }
  promptEditorFromSettings = isSettingsOpen();
  if (isSettingsOpen()) toggleSettings(false);
  promptEditorKind = kind;
  const { settings } = state;
  element.promptEditorTitle.textContent = kind === "transform" ? "Dictation" : "Selection";
  element.promptEditorWhere.textContent =
    kind === "transform"
      ? transformPromptWhere(settings.polishLevel)
      : "Used when you polish selected text with the shortcut.";
  element.promptEditorBody.value =
    kind === "transform" ? settings.transformPrompt : settings.polishPrompt;
  element.promptEditor.hidden = false;
  setScrimHidden(false);
  element.promptEditorBody.focus();
}

/**
 * Which level the dictation instruction belongs to.
 *
 * At None nothing runs it, and the card says so rather than showing an
 * instruction that reads as though it were in force.
 */
function transformPromptWhere(level: PolishLevel): string {
  if (level === "none") return "Not in use: AI Polish is set to None.";
  return "Used on every dictation while AI Polish is Active.";
}

/** First lines of each prompt on the cards, so the page stays scannable. */
function renderPromptPreviews(next: AppSettings): void {
  element.transformPromptWhere.textContent = transformPromptWhere(next.polishLevel);
  element.transformPromptPreview.textContent = promptPreview(next.transformPrompt);
  element.polishPromptPreview.textContent = promptPreview(next.polishPrompt);
}
