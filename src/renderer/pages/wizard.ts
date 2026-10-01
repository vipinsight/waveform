import { getHotkeyBinding, hotkeyKeycap, isHotkeyBindingId } from "../../shared/hotkeys";
import {
  DEFAULT_LADDER_INDEX,
  DEFAULT_LADDER_MODEL_ID,
  MODEL_LADDER,
  chooseModel,
  ladderIndexOf,
  ladderRung,
} from "../../shared/model-ladder";
import { getSpeechModel, type SpeechModelId } from "../../shared/models";
import type { ModelStatus } from "../../shared/contracts";
import { isPolishLevel } from "../../shared/polish-levels";
import { DEFAULT_POLISH_MODEL_ID } from "../../shared/polish-models";
import { transformPromptFor } from "../../shared/prompts";
import { DEFAULT_SETTINGS } from "../../shared/settings";
import { host } from "../host";
import { flash, requireElement } from "../ui/dom";
import { formatBytes, formatMemory } from "../ui/format";
import { patchSettings, state } from "../state";
import { renderKeyboard } from "./dictation";
import { downloadModel, downloadPolishModel } from "./models";
import { KEY_MASK, isPromptEditorOpen, renderAiStatus, togglePromptEditor } from "./polish";
import { isSettingsOpen, toggleSettings } from "./settings-panel";
import {
  readPolishModel,
  renderHotkeyStatus,
  resolveSetupStep,
  setupSteps,
  type SetupStep,
} from "./setup";

/**
 * The first-run wizard.
 *
 * Five pages, asked once. It exists because the checklist on the Transcripts
 * page -- which is still there, and is where anyone who skips this lands --
 * can only nag about what is missing, and two of the things that decide how
 * the app feels are not missing, they are defaulted: which key you hold, and
 * how much a model may rewrite what you said. Nobody changes a default they
 * were never shown.
 *
 * The order is load-bearing. The model is first because it is the only step
 * that takes real time, and asking it first means the download runs while the
 * other four are answered rather than after them. The key comes before the
 * permission that watches for the key, so the permission prompt is about
 * something already decided.
 *
 * There is no skip. The three macOS permissions are not preferences that can
 * be left at a default -- without them the app cannot hear you, cannot see
 * the key you hold, and cannot type the result -- so the page that asks for
 * them will not advance until they are granted. Every one of them is granted
 * in System Settings and reported back live, so there is always a way
 * forward; there is just no way around.
 */

const element = {
  app: requireElement<HTMLElement>("app-shell"),
  wizard: requireElement<HTMLElement>("wizard"),
  wizardBrand: requireElement<HTMLElement>("wizard-brand"),
  wizardNext: requireElement<HTMLButtonElement>("wizard-next"),
  ladderSlider: requireElement<HTMLInputElement>("ladder-slider"),
  ladderName: requireElement<HTMLElement>("ladder-name"),
  ladderModel: requireElement<HTMLElement>("ladder-model"),
  ladderTrade: requireElement<HTMLElement>("ladder-trade"),
  ladderTicks: requireElement<HTMLElement>("ladder-ticks"),
  ladderFacts: requireElement<HTMLElement>("ladder-facts"),
  ladderNote: requireElement<HTMLElement>("ladder-note"),
  keyboard: requireElement<HTMLElement>("keyboard"),
  keyboardCaption: requireElement<HTMLElement>("keyboard-caption"),
  wizardFnNote: requireElement<HTMLElement>("wizard-fn-note"),
  wizardChecklist: requireElement<HTMLElement>("wizard-checklist"),
  wizardPermissionsNote: requireElement<HTMLElement>("wizard-permissions-note"),
  wizardPolishLevels: requireElement<HTMLElement>("wizard-polish-levels"),
  wizardEngine: requireElement<HTMLElement>("wizard-engine"),
  wizardEngineNote: requireElement<HTMLElement>("wizard-engine-note"),
  wizardEngineDetail: requireElement<HTMLElement>("wizard-engine-detail"),
  wizardKeyRow: requireElement<HTMLElement>("wizard-key-row"),
  wizardLocalRow: requireElement<HTMLElement>("wizard-local-row"),
  wizardLocalName: requireElement<HTMLElement>("wizard-local-name"),
  wizardLocalState: requireElement<HTMLElement>("wizard-local-state"),
  wizardLocalTrack: requireElement<HTMLElement>("wizard-local-track"),
  wizardLocalBar: requireElement<HTMLElement>("wizard-local-bar"),
  wizardKeyInput: requireElement<HTMLInputElement>("wizard-key-input"),
  wizardKeySave: requireElement<HTMLButtonElement>("wizard-key-save"),
  wizardKeyState: requireElement<HTMLElement>("wizard-key-state"),
  wizardOpenOpenRouter: requireElement<HTMLButtonElement>("wizard-open-openrouter"),
  readyTitle: requireElement<HTMLElement>("ready-title"),
  readyProgress: requireElement<HTMLElement>("ready-progress"),
  readySpeechRow: requireElement<HTMLElement>("ready-speech-row"),
  readySpeechName: requireElement<HTMLElement>("ready-speech-name"),
  readySpeechState: requireElement<HTMLElement>("ready-speech-state"),
  readySpeechBar: requireElement<HTMLElement>("ready-speech-bar"),
  readyPolishRow: requireElement<HTMLElement>("ready-polish-row"),
  readyPolishName: requireElement<HTMLElement>("ready-polish-name"),
  readyPolishState: requireElement<HTMLElement>("ready-polish-state"),
  readyPolishBar: requireElement<HTMLElement>("ready-polish-bar"),
  readyKey: requireElement<HTMLElement>("ready-key"),
  readyKeyTap: requireElement<HTMLElement>("ready-key-tap"),
};

const WIZARD_STEPS = [
  "welcome",
  "voice",
  "shortcut",
  "permissions",
  "polish",
  "ready",
] as const;
type WizardStep = (typeof WIZARD_STEPS)[number];

/** Which page of the first-run wizard is up, or null when it is not open. */
let wizardStep: WizardStep | null = null;
/**
 * How each model sits in this Mac's memory, and whether its weights are here.
 *
 * The slider asks the catalogue nothing as it moves: a round trip per drag
 * would be forty of them, and the answer -- how much memory this machine has
 * -- cannot change while a window is open. The installed half is re-read each
 * time a prefetch finishes, which is the only thing that changes it.
 */
let wizardCatalog = new Map<string, ModelStatus>();
/**
 * Models the wizard is fetching without being asked, in the order it wants
 * them. The host runs one download at a time -- a second call while one is
 * running comes back "A download is already running." -- so this is drained
 * one at a time rather than started at once.
 */
let prefetchQueue: SpeechModelId[] = [];
let prefetchRunning = false;
/** Poll handle for the permissions page; null when that page is not up. */
let permissionWatch: ReturnType<typeof setInterval> | null = null;
/** Frame handle for the slider's glide, null when it is not moving on its own. */
let ladderGlide: number | null = null;
/**
 * Whether a pointer is down on the slider, and whether it has moved since.
 *
 * The difference between a click on the track and the start of a drag, which
 * a range input reports identically: both arrive as an `input` event with a
 * new value. A click should glide to where you aimed; a drag has to stay
 * under the finger.
 */
let ladderPointerDown = false;
let ladderPointerMoved = false;
/** The rung the card is currently describing, so a glide is not 60 rebuilds. */
let ladderShownRung = -1;
/** Whether the slider has been moved, which turns a default into a choice. */
let ladderTouched = false;
/**
 * Where the slider sits, which is not yet what has been chosen.
 *
 * Fractional while a drag is in progress. The track is continuous so the
 * thumb follows the pointer instead of jumping between five stops, and the
 * rung is whichever one it is nearest; letting go snaps it onto that rung.
 */
let ladderIndex: number = DEFAULT_LADDER_INDEX;

export function renderWizardBrand(appName: string): void {
  element.wizardBrand.textContent = appName;
}

/**
 * Opens the wizard, if this is the install it was written for.
 *
 * Two conditions, not one. The flag alone is not enough: it arrived after the
 * app did, so every settings file written before it reads as a fresh install,
 * and an existing user would be handed a five-page wizard on the morning they
 * updated. A machine that has already dictated has plainly been through this,
 * so it is marked done without ever being shown.
 */
export function maybeOpenWizard(): void {
  if (state.settings.onboardingCompleted) return;
  if (state.lifetimeSessions > 0) {
    void patchSettings({ onboardingCompleted: true });
    return;
  }
  openWizard();
}

function openWizard(): void {
  // A model already chosen puts the slider on its rung; anything off the
  // ladder -- a model picked from the catalogue, or a default from an older
  // build -- leaves the slider where it rests.
  ladderIndex = ladderIndexOf(state.settings.modelId) ?? DEFAULT_LADDER_INDEX;
  element.ladderSlider.max = String(MODEL_LADDER.length - 1);
  element.ladderSlider.value = String(ladderIndex);
  cancelLadderGlide();
  ladderShownRung = -1;
  ladderTouched = false;

  // Anything else modal would be underneath this, which is two dialogs deep
  // with the lower one unreachable.
  if (isSettingsOpen()) toggleSettings(false);
  if (isPromptEditorOpen()) togglePromptEditor(false);

  void readWizardFits().then(startPrefetch);
  startPolishDefault();
  renderKeypick();
  showWizardStep("welcome");
}

/**
 * Starts a first run on Light, rewriting here on this Mac.
 *
 * The stored defaults stay where they are, and this is set on the way into
 * the wizard instead, because the two cannot be moved for the same reasons.
 * `polishLevel` could be: a settings file older than the levels carries
 * `transformOnDictate`, so it never falls through to the default. But
 * `polishEngine` has no such fallback -- a file written before that field
 * existed takes whatever the default is, and moving it to "local" would
 * quietly switch everybody already polishing through OpenRouter onto a model
 * they have not downloaded. So the new answer is given to new installs only,
 * which is exactly who is looking at this wizard.
 *
 * Doing it here rather than on the polish page is what gets the model moving:
 * it is a 397 MB download, and starting it four pages early is the same trick
 * the speech models get.
 *
 * Only from the factory settings. Somebody who reached the polish page, chose
 * None and quit has answered this, and reopening must not overrule them.
 */
function startPolishDefault(): void {
  const { settings } = state;
  if (settings.polishLevel !== DEFAULT_SETTINGS.polishLevel) return;
  if (settings.polishEngine !== DEFAULT_SETTINGS.polishEngine) return;
  void patchSettings({
    polishLevel: "light",
    transformPrompt: transformPromptFor("light"),
    polishEngine: "local",
  }).then(prefetchPolishModel);
}

/**
 * Fetches the two models almost everybody ends on, before being asked to.
 *
 * Nothing about this is on screen. A first run is four pages of answering
 * questions during which the machine is doing nothing, and the reward for
 * finishing is a wait -- so the wait is moved under the questions. Base goes
 * first because it is 148 MB against 574: it lands while the permissions are
 * still being granted, and from then on there is a working model on the disk
 * whichever way the slider ends up. The recommended one follows.
 *
 * Deliberately not announced. A progress line for a download nobody asked for
 * invites the question of whether it can be stopped, and the honest answer --
 * that it is two files totalling 700 MB fetched on spec -- is a worse first
 * page than silence. What is never hidden is the result: the last page reads
 * the same setup list as everything else, so it says the model is missing
 * whenever it is.
 */
function startPrefetch(): void {
  enqueuePrefetch(DEFAULT_LADDER_MODEL_ID);
  // Unshifted after, so Base ends up in front of it.
  enqueuePrefetch(MODEL_LADDER[0]!.id, { first: true });
  void drainPrefetch();
}

/** Whether a model's weights are on the disk, as of the last catalogue read. */
function isHere(id: SpeechModelId): boolean {
  const model = wizardCatalog.get(id);
  return model !== undefined && model.runtimeInstalled && model.weightsInstalled;
}

/**
 * Puts a model in the queue, or moves it to the front.
 *
 * `first` is for the model the slider actually landed on: it is the one being
 * waited for, so it goes ahead of anything fetched on spec. A download
 * already in flight is left to finish rather than cancelled -- the partial
 * file would be thrown away, and the thing in flight is the small one.
 */
function enqueuePrefetch(id: SpeechModelId, options?: { first: boolean }): void {
  if (isHere(id)) return;
  prefetchQueue = prefetchQueue.filter((queued) => queued !== id);
  if (options?.first) prefetchQueue.unshift(id);
  else prefetchQueue.push(id);
}

/**
 * Runs the queue, one at a time, because the host will not run two.
 *
 * Re-reads the catalogue between items: a download that just landed is the
 * only thing that changes whether the next one is still needed, and the
 * selected model's arrival is also what the last page is waiting on.
 */
async function drainPrefetch(): Promise<void> {
  if (prefetchRunning) return;
  prefetchRunning = true;
  try {
    while (prefetchQueue.length > 0) {
      const id = prefetchQueue.shift();
      if (id === undefined || isHere(id)) continue;
      // Failures are not reported either. Nobody asked for this download, so
      // nobody is owed an error about it; the last page still says the voice
      // is missing, and the checklist behind it still offers to fetch it.
      await downloadModel(id).catch(() => {});
      await readWizardFits();
    }
  } finally {
    prefetchRunning = false;
  }
}

/**
 * Reads each ladder model's fit, so the slider can refuse to recommend one
 * this Mac cannot hold. A catalogue that will not load leaves every fit
 * unknown, and an unknown fit is not a refusal: the slider then offers
 * whatever was asked for, which is what it did before this existed.
 */
async function readWizardFits(): Promise<void> {
  const catalog = await host().getModelCatalog().catch(() => []);
  wizardCatalog = new Map(catalog.map((model) => [model.id, model]));
  // The card's cache is keyed on the rung, and the rung has not moved -- but
  // the sizes, the fit and the model it settles on all just arrived, so the
  // cache has to be dropped rather than trusted.
  ladderShownRung = -1;
  if (wizardStep === "voice") renderLadder();
}

function showWizardStep(step: WizardStep): void {
  wizardStep = step;
  // The frame reads this: the welcome page centres and enlarges its button,
  // which is a property of the page rather than of the button.
  element.wizard.dataset.step = step;
  element.wizard.hidden = false;
  // `aria-modal` tells a screen reader the rest is out of play and does
  // nothing about Tab, which would otherwise walk straight off the wizard
  // into a sidebar and a settings button that are covered but still live.
  element.app.inert = true;
  for (const section of Array.from(
    element.wizard.querySelectorAll<HTMLElement>(".wizard-step"),
  )) {
    section.hidden = section.dataset.step !== step;
  }
  renderWizard();
  // Whatever the step is about should be reachable from the keyboard without
  // first tabbing back through the page behind it.
  element.wizard
    .querySelector<HTMLElement>(`.wizard-step[data-step="${step}"] input, .wizard-step[data-step="${step}"] button`)
    ?.focus();
}

/** Everything on the frame that depends on which step is up. */
export function renderWizard(): void {
  if (wizardStep === null) return;
  element.wizardNext.textContent = wizardNextLabel(wizardStep);
  element.wizardNext.disabled = !wizardCanAdvance(wizardStep);

  if (wizardStep === "voice") renderLadder();
  if (wizardStep === "shortcut") renderKeypick();
  if (wizardStep === "permissions") renderWizardChecklist();
  watchPermissions(wizardStep === "permissions");
  if (wizardStep === "polish") renderWizardPolish();
  if (wizardStep === "ready") renderWizardReady();
}

function wizardNextLabel(step: WizardStep): string {
  if (step === "welcome") return "Get started";
  if (step === "ready") return "Start dictating";
  if (step === "voice") {
    // Untouched, the slider is a recommendation rather than a decision, and
    // saying so is more use than naming a model nobody chose. Once it has
    // been moved it is a choice, and the button names what was chosen --
    // which is also the last chance to notice the Mac stepped it down.
    if (!ladderTouched) return "Continue with default model";
    return `Continue with ${chooseModel(ladderIndex, (id) => wizardCatalog.get(id)?.fit ?? null).label}`;
  }
  return "Continue";
}

/**
 * Whether the permissions are being reported at all.
 *
 * The three booleans start false and are filled in by the native helper, so
 * "not granted" and "nobody has told us yet" arrive looking identical. That
 * matters because the page they gate has no way past it: a helper that is
 * not running, or one that cannot read the microphone's status, would hold
 * somebody on page four of a wizard with a disabled button and no
 * explanation -- and every switch already flipped in System Settings.
 *
 * Which is not hypothetical. It happened here: a dev build launched outside
 * LaunchServices had its permissions attributed elsewhere, so the helper
 * reported false for grants that were real, and the wizard would not move.
 */
function permissionsAreKnown(): boolean {
  const { hotkeyStatus } = state;
  if (hotkeyStatus === null) return false;
  // `running` is the helper process; without it the two booleans are stale
  // defaults rather than answers.
  if (!hotkeyStatus.running) return false;
  return hotkeyStatus.microphone !== "unknown";
}

/**
 * Whether this step has been answered well enough to leave.
 *
 * Only the permissions can fail it, and only when they are refusing rather
 * than silent. The model has one selected from the moment the page opens,
 * the key has one too, and None is a real answer to the polish question
 * rather than an unanswered one.
 */
function wizardCanAdvance(step: WizardStep): boolean {
  if (step !== "permissions") return true;
  // Gate on denial, never on ignorance. Refusing to advance because nothing
  // answered is the difference between a firm wizard and a trapped one.
  if (!permissionsAreKnown()) return true;
  return permissionSteps().every((one) => one.done);
}

/**
 * The three macOS permissions, named rather than filtered by exception.
 *
 * This used to be the setup list minus "model", which quietly took in every
 * step added afterwards: the polish model turned up on the permissions page
 * -- and, because this list is also the page's gate, made Continue wait on a
 * 397 MB download before it would let anyone past. A download is not a
 * permission, and neither is anything else that might be added here later.
 */
const WIZARD_PERMISSIONS = ["microphone", "accessibility", "input-monitoring"] as const;

function permissionSteps(): SetupStep[] {
  return setupSteps().filter((step) =>
    WIZARD_PERMISSIONS.some((id) => id === step.id),
  );
}

/* -------------------------------------------------------------------------
 * 1. The voice
 * ---------------------------------------------------------------------- */

/**
 * What the slider is currently pointing at, and what that costs.
 *
 * The name under the slider is the rung's name, but the model beside it is
 * what `chooseModel` settled on -- which is a rung lower when this Mac cannot
 * hold what was asked for. The two disagreeing on screen with no explanation
 * is why the note exists.
 */
function renderLadder(): void {
  // The track paints its own filled portion from this, because a range input
  // gives no way to style "everything to the left of the thumb". Written on
  // every frame of a glide, which is what makes the fill move with the thumb.
  const span = Math.max(1, MODEL_LADDER.length - 1);
  element.ladderSlider.style.setProperty(
    "--fill",
    `${(Math.min(span, Math.max(0, ladderIndex)) / span) * 100}%`,
  );

  // Everything below describes a rung, not a position, so it is rebuilt when
  // the rung changes rather than sixty times a second on the way there --
  // replaceChildren on the ticks and the facts every frame is itself enough
  // to make a glide stutter.
  const rung = Math.round(Math.min(span, Math.max(0, ladderIndex)));
  if (rung === ladderShownRung) return;
  ladderShownRung = rung;
  renderVoiceButton();

  const choice = chooseModel(rung, (id) => wizardCatalog.get(id)?.fit ?? null);

  // The name follows the handle, because a label that disagreed with where
  // the slider physically is reads as a broken control. The sentence under it
  // follows the model, because it is a claim about what you will get -- and
  // "near the best transcription there is" over the name of a small model is
  // the one thing on this page that could be flatly untrue.
  element.ladderName.textContent = ladderRung(rung).name;
  element.ladderModel.textContent = choice.label;
  element.ladderTrade.textContent = ladderRung(choice.index).trade;

  renderLadderTicks();
  renderLadderFacts(choice.id);

  element.ladderNote.hidden = choice.askedFor === null;
  element.ladderNote.textContent =
    choice.askedFor === null
      ? ""
      : `${getSpeechModel(choice.askedFor.id).label} wants more memory than this Mac has to spare, so ${choice.label} is the most accurate one that fits.`;
}

/**
 * Moves the slider to a rung over a couple of hundred milliseconds.
 *
 * A range input cannot be asked to animate: the thumb is drawn wherever
 * `value` says, and no CSS transition reaches it -- so clicking the track
 * teleported the thumb to the rung you aimed at. The value itself is tweened
 * instead, which the thumb, the filled track and the notches all follow for
 * free because they are all drawn from it.
 *
 * Not used while dragging. A drag has to stay under the finger, and anything
 * easing its way toward the pointer is lag rather than polish.
 */
function glideLadderTo(target: number): void {
  const span = MODEL_LADDER.length - 1;
  const to = Math.min(span, Math.max(0, target));
  cancelLadderGlide();

  const from = ladderIndex;
  const distance = Math.abs(to - from);
  // Somebody who has asked for less movement has asked for this too.
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduced || distance < 0.001) {
    setLadderIndex(to);
    return;
  }

  // Put the thumb back where it was, now, before anything is painted. A
  // click on the track has already moved the input's own value to where it
  // was aimed, and the first eased frame is a whole frame away -- long
  // enough to show the thumb at the destination and then yank it back to
  // start the journey it was supposed to make.
  setLadderIndex(from);

  // Scaled by distance, so a nudge to the next rung is not given the same
  // couple of hundred milliseconds as a jump across the whole ladder, and
  // capped so the long one still feels like a control rather than a tour.
  const duration = Math.min(260, 110 + distance * 55);
  const start = performance.now();

  const frame = (now: number): void => {
    const progress = Math.min(1, (now - start) / duration);
    // Out-cubic: leaves immediately, arrives gently, which is what reads as
    // the thumb being thrown rather than dragged.
    const eased = 1 - (1 - progress) ** 3;
    setLadderIndex(from + (to - from) * eased);
    if (progress < 1) {
      ladderGlide = requestAnimationFrame(frame);
      return;
    }
    ladderGlide = null;
    setLadderIndex(to);
  };
  ladderGlide = requestAnimationFrame(frame);
}

/** The Continue button names the model, so it moves when the slider does. */
function renderVoiceButton(): void {
  if (wizardStep !== "voice") return;
  element.wizardNext.textContent = wizardNextLabel("voice");
}

function cancelLadderGlide(): void {
  if (ladderGlide === null) return;
  cancelAnimationFrame(ladderGlide);
  ladderGlide = null;
}

/** Writes a position to both the control and the card drawn from it. */
function setLadderIndex(value: number): void {
  ladderIndex = value;
  // Assigning `value` does not fire `input`, so this cannot feed back into
  // the handler that started the glide.
  element.ladderSlider.value = String(value);
  renderLadder();
}

/**
 * A notch per rung, under the track.
 *
 * Five positions on a continuous-looking slider is not something anyone
 * discovers by dragging it. The notches say up front that this has stops
 * rather than a range, and how many.
 */
function renderLadderTicks(): void {
  element.ladderTicks.replaceChildren(
    ...MODEL_LADDER.map((rung, index) => {
      const tick = document.createElement("li");
      tick.className = "ladder-tick";
      const at = Math.round(ladderIndex);
      tick.dataset.state = index === at ? "here" : index < at ? "below" : "above";
      tick.title = rung.name;
      return tick;
    }),
  );
}

/**
 * What the chosen model costs, from the catalogue rather than from adjectives.
 *
 * "More accurate" is a promise with nothing behind it until there is a number
 * beside it. These three are the ones that differ down the ladder and that
 * somebody choosing would actually weigh: what it fetches, what it keeps
 * resident, and how often it is wrong.
 */
function renderLadderFacts(id: SpeechModelId): void {
  const model = wizardCatalog.get(id);
  const facts: Array<[string, string]> = [
    ["Download", model?.downloadBytes != null ? formatBytes(model.downloadBytes) : "—"],
    ["Memory", model ? formatMemory(model.memoryMb) : "—"],
    // Word error rate, said as the thing it measures. "WER 2.1" is a term of
    // art; "about 2 words in 100" is the same fact to someone who has never
    // read a speech paper.
    [
      "Gets wrong",
      model?.wer != null ? `~${model.wer.toFixed(1)} words in 100` : "—",
    ],
  ];

  element.ladderFacts.replaceChildren(
    ...facts.map(([term, value]) => {
      const cell = document.createElement("div");
      cell.className = "ladder-fact";
      const label = document.createElement("dt");
      label.textContent = term;
      const detail = document.createElement("dd");
      detail.textContent = value;
      cell.append(label, detail);
      return cell;
    }),
  );
}

/**
 * Selects the model the slider landed on and makes sure it is being fetched.
 *
 * Usually there is nothing to start: the two the queue was primed with are
 * the two most people leave the slider on. A third choice is put at the front
 * of the queue rather than downloaded separately, because the host runs one
 * download at a time and starting a second here would simply be refused.
 */
async function commitLadderChoice(): Promise<void> {
  const choice = chooseModel(ladderIndex, (id) => wizardCatalog.get(id)?.fit ?? null);
  if (choice.id !== state.settings.modelId) await patchSettings({ modelId: choice.id });
  enqueuePrefetch(choice.id, { first: true });
  void drainPrefetch();
}

/* -------------------------------------------------------------------------
 * 2. The key
 * ---------------------------------------------------------------------- */

/** Draws the keyboard and marks the chosen key. */
function renderKeypick(): void {
  renderKeyboard(element.keyboard, element.keyboardCaption);
  // Reserved, not removed: see the comment on the note in index.html.
  element.wizardFnNote.classList.toggle("is-reserved", state.settings.hotkeyId !== "fn");
}

/* -------------------------------------------------------------------------
 * 3. The permissions
 * ---------------------------------------------------------------------- */

/**
 * The same three rows the Setup page draws, from the same list.
 *
 * Built here rather than moved out into a shared helper because the Setup
 * page's version carries the model step and this one must not: the download
 * is already running behind this page, and a row offering to start it again
 * would be a second Download button for a file that is arriving.
 */
function renderWizardChecklist(): void {
  const outstanding = permissionSteps().filter((step) => !step.done);
  // A Continue that is greyed out with no reason beside it is a dead end.
  element.wizardPermissionsNote.textContent =
    outstanding.length === 0
      ? "macOS ties these to the app's signature. If one looks granted but is refused, remove Waveform from the list and add it again."
      : permissionsAreKnown()
        ? "All three are needed before Waveform can dictate, so this is the one page that waits for you."
        : "These cannot be read just now, so this page will not hold you up. The card on Transcripts will keep offering them.";

  element.wizardChecklist.replaceChildren(
    ...permissionSteps().map((step) => {
      const row = document.createElement("li");
      row.className = "check";
      row.dataset.check = step.id;
      row.dataset.done = String(step.done);

      const mark = document.createElement("span");
      mark.className = "check-mark";
      mark.setAttribute("aria-hidden", "true");

      const body = document.createElement("span");
      body.className = "check-body";
      const title = document.createElement("strong");
      title.textContent = step.title;
      body.append(title);

      // A granted permission needs no instructions for granting it. The
      // detail line explains where to find the switch and what macOS calls
      // it, which is worth two lines while it is outstanding and is clutter
      // the moment it is not.
      if (!step.done) {
        const detail = document.createElement("small");
        detail.textContent = step.detail;
        body.append(detail);
      }

      row.append(mark, body);

      if (!step.done) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "pill-button is-primary";
        button.dataset.fix = step.id;
        button.textContent = step.action;
        row.append(button);
      }
      return row;
    }),
  );
}

/**
 * Re-reads the permissions while that page is the one on screen.
 *
 * All three are granted in System Settings, in another window, and two of
 * them never tell this one anything: the native helper notices within a
 * second and a half, but nothing asks it while the click that opened System
 * Settings is the last thing that happened. So the row kept its Allow button
 * long after the switch had been flipped, which reads as a button that does
 * not work.
 *
 * Only while the page is up, and stopped on the way out: this is a poll, and
 * one that outlived the step it belongs to would run for the life of the app.
 */
function watchPermissions(on: boolean): void {
  if (permissionWatch !== null) {
    clearInterval(permissionWatch);
    permissionWatch = null;
  }
  if (!on) return;
  permissionWatch = setInterval(() => {
    void host()
      .getHotkeyStatus()
      .then((status) => {
        // Rendering on every tick would rebuild the rows under the pointer
        // four times a second for no reason.
        if (JSON.stringify(status) === JSON.stringify(state.hotkeyStatus)) return;
        state.hotkeyStatus = status;
        renderHotkeyStatus();
      })
      .catch(() => {});
  }, 1_000);
}

/* -------------------------------------------------------------------------
 * 4. The polish level
 * ---------------------------------------------------------------------- */

/**
 * The three levels, and -- above None -- where the rewrite would run.
 *
 * Neither engine is finished being set up here: the local one is a second
 * download and the hosted one is an API key, and both belong on a page that
 * can show a progress bar and a password field. What this page settles is
 * which of those two the answer is, so Settings opens on the right half of
 * the page rather than on a choice nobody knew they had.
 */
function renderWizardPolish(): void {
  const { settings } = state;
  for (const card of Array.from(
    element.wizardPolishLevels.querySelectorAll<HTMLElement>("[data-level]"),
  )) {
    card.setAttribute("aria-checked", String(card.dataset.level === settings.polishLevel));
  }

  // Always on screen, whatever the level. It used to appear with the first
  // choice above None and take the key field with it, which moved the three
  // cards -- and the pointer that had just clicked one -- halfway up the
  // window. The page now has one height, and the parts that do not apply yet
  // say so instead of vanishing.
  for (const button of Array.from(
    element.wizardEngine.querySelectorAll<HTMLElement>("[data-engine]"),
  )) {
    button.setAttribute("aria-checked", String(button.dataset.engine === settings.polishEngine));
  }
  element.wizardEngineNote.textContent =
    settings.polishLevel === "none"
      ? "Nothing rewrites at None; this is what would run it."
      : settings.polishEngine === "local"
        ? "A second, smaller model, downloaded here. Your words never leave this Mac."
        : "A hosted model; your dictated text is sent to it. The key is free to create, and can wait until Settings.";

  renderWizardKey();
}

/** The AI status changed; the polish page shows the same key as Settings. */
export function refreshWizardKey(): void {
  if (wizardStep === "polish") renderWizardKey();
}

/**
 * The key field, which only exists while the hosted engine is the answer.
 *
 * A saved key is shown as saved rather than as a field to fill in again: the
 * key itself never leaves the host, so there is nothing to put back in the
 * box, and an empty box beside "OpenRouter" reads as work still to do.
 */
function renderWizardKey(): void {
  const { settings, aiStatus } = state;
  // Three occupants of one slot. Hidden outright rather than reserved with
  // `visibility`, because the slot itself holds the height -- and a slot that
  // is always occupied does not need anything reserving.
  const off = settings.polishLevel === "none";
  const wanted = !off && settings.polishEngine === "openrouter";
  const local = !off && settings.polishEngine === "local";
  // Nothing rewrites at None, so there is nothing to set up and nothing to
  // describe. The slot closes rather than explaining itself.
  element.wizardEngineDetail.hidden = off;
  element.wizardLocalRow.hidden = !local;
  element.wizardKeyRow.hidden = !wanted;
  if (local) void renderWizardLocal();
  if (!wanted) return;

  const saved = aiStatus?.hasApiKey === true;
  element.wizardKeyState.textContent = saved
    ? aiStatus?.memoryOnly === true
      ? "Saved for this session only"
      : "Saved"
    : "";
  element.wizardKeyState.classList.toggle("key-saved", saved && aiStatus?.memoryOnly !== true);

  // Never overwrite something half-typed; only fill the box the first time.
  if (element.wizardKeyInput.dataset.pristine !== "false") {
    element.wizardKeyInput.value = saved ? KEY_MASK : "";
    element.wizardKeyInput.dataset.pristine = "true";
  }
  syncWizardKeyButton();
}

/**
 * What choosing "This Mac" costs and how far along it is.
 *
 * The slot used to be blank here: the key field is only for the hosted
 * engine, so picking the local one left a rectangle of nothing where the
 * setup for it should be. There is something to say -- a second model is
 * being fetched on the strength of that choice -- and not saying it made the
 * download invisible on the one page it is relevant to.
 */
async function renderWizardLocal(): Promise<void> {
  const catalog = await host().getPolishModelCatalog().catch(() => []);
  const model =
    catalog.find((one) => one.id === state.settings.localModelId) ??
    catalog.find((one) => one.id === DEFAULT_POLISH_MODEL_ID);
  if (!model) return;

  element.wizardLocalName.textContent = `${model.label} · ${formatBytes(model.downloadBytes)}`;
  const downloading = state.polishDownloading === model.id;
  element.wizardLocalState.textContent = model.installed
    ? "Ready"
    : downloading
      ? "Downloading…"
      : "Downloads in the background";
  element.wizardLocalState.dataset.state = model.installed
    ? "ready"
    : downloading
      ? "working"
      : "waiting";
  // The bar is only honest while something is moving; a full or empty one
  // sitting under a finished download is a progress bar lying.
  element.wizardLocalTrack.classList.toggle("is-reserved", !downloading);
}

/**
 * The polish model's download, as it arrives, on the row that said it would.
 * Only while that row is showing: this is called for every progress event.
 */
export function renderWizardLocalProgress(downloading: boolean): void {
  if (wizardStep !== "polish" || element.wizardLocalRow.hidden) return;
  const percent = state.polishPercent;
  element.wizardLocalTrack.classList.toggle("is-reserved", !downloading);
  element.wizardLocalBar.style.width = `${percent}%`;
  element.wizardLocalState.textContent = downloading ? `Downloading… ${percent}%` : "Ready";
  element.wizardLocalState.dataset.state = downloading ? "working" : "ready";
}

function syncWizardKeyButton(): void {
  const edited = element.wizardKeyInput.dataset.pristine === "false";
  element.wizardKeySave.disabled =
    !edited || element.wizardKeyInput.value.trim().length === 0;
}

function saveWizardApiKey(): void {
  const value = element.wizardKeyInput.value.trim();
  if (element.wizardKeyInput.dataset.pristine === "true" || !value) return;
  void host()
    .setOpenRouterKey(value)
    .then((status) => {
      element.wizardKeyInput.dataset.pristine = "true";
      // Repaints both copies of this row: the one here and the one in
      // Settings, which is the same key.
      renderAiStatus(status);
      renderWizardKey();
      flash(element.wizardKeySave, "Saved");
    });
}

/**
 * Fetches the model that does the rewriting, as soon as rewriting is asked for.
 *
 * Any level above None needs something to run it, and for somebody who has
 * just installed the app that is almost certainly the model on this Mac: the
 * hosted engine cannot rewrite a word until an OpenRouter key has been pasted
 * in, and nobody has one four pages into a first run. So the download starts
 * on the choice rather than on the page in Settings where they would later
 * discover it was needed.
 *
 * Silent, like the speech prefetch, and on a separate lane -- Rust runs one
 * speech download and one polish download, so this does not queue behind the
 * voice still arriving. Whichever local model is selected is the one fetched,
 * which on a fresh install is the smallest.
 */
async function prefetchPolishModel(): Promise<void> {
  if (state.settings.polishLevel === "none") return;
  if (state.polishDownloading !== null) return;
  const catalog = await host().getPolishModelCatalog().catch(() => []);
  // Whatever is selected, which on a fresh install is Qwen3 0.6B Q4 -- the
  // lightest, and the only one most Macs need to tidy a paragraph. The
  // fallback covers a stored id the catalogue no longer carries.
  const wanted =
    catalog.find((model) => model.id === state.settings.localModelId) ??
    catalog.find((model) => model.id === DEFAULT_POLISH_MODEL_ID);
  if (!wanted || wanted.installed) return;
  void renderWizardLocal();
  // Not awaited by the caller and not reported: nobody asked for it, so a
  // failure is not theirs to answer. The AI polish page still offers it.
  await downloadPolishModel(wanted.id).catch(() => {});
}

/* -------------------------------------------------------------------------
 * 5. The gesture
 * ---------------------------------------------------------------------- */

function renderWizardReady(): void {
  const binding = getHotkeyBinding(state.settings.hotkeyId);
  const glyph = binding ? hotkeyKeycap(binding) : "—";
  element.readyKey.textContent = glyph;
  element.readyKeyTap.textContent = `${glyph} ${glyph}`;

  // Saying "That's everything" over a model that has not arrived is the one
  // way this page can be actively misleading.
  const outstanding = setupSteps().filter((step) => !step.done);
  element.readyTitle.textContent = outstanding.length === 0 ? "That's everything" : "Nearly there";

  void readPolishModel().then(renderReadyProgress);
  renderReadyProgress();
}

/** A download moved; the last page draws its bars from the new percentage. */
export function refreshReadyProgress(): void {
  if (wizardStep === "ready") renderReadyProgress();
}

/**
 * The two downloads, on the one page where whether they have finished is the
 * answer to the question being asked.
 *
 * A row appears only while its model is not here yet, so somebody whose
 * downloads landed during the questions -- which is most people, which is
 * the whole point of starting them early -- sees nothing at all.
 */
function renderReadyProgress(): void {
  const { settings, modelInstalled, downloading, speechPercent, polishDownloading, polishPercent } = state;
  const speech = getSpeechModel(settings.modelId);
  const speechPending = !modelInstalled;
  element.readySpeechRow.hidden = !speechPending;
  if (speechPending) {
    element.readySpeechName.textContent = speech.label;
    const busy = downloading === settings.modelId;
    element.readySpeechState.textContent = busy ? `${speechPercent}%` : "Waiting to start";
    element.readySpeechBar.style.width = `${busy ? speechPercent : 0}%`;
  }

  // Only when something above None is selected: at None no model rewrites,
  // so one arriving is not something this page is waiting on.
  const polish = state.wizardPolishModel;
  const polishPending =
    settings.polishLevel !== "none" && polish !== null && !polish.installed;
  element.readyPolishRow.hidden = !polishPending;
  if (polishPending && polish) {
    element.readyPolishName.textContent = `${polish.label} · AI polish`;
    const busy = polishDownloading !== null;
    element.readyPolishState.textContent = busy ? `${polishPercent}%` : "Waiting to start";
    element.readyPolishBar.style.width = `${busy ? polishPercent : 0}%`;
  }

  element.readyProgress.hidden = !speechPending && !polishPending;
}

/* -------------------------------------------------------------------------
 * Moving through it
 * ---------------------------------------------------------------------- */

async function advanceWizard(): Promise<void> {
  if (wizardStep === null) return;
  // Checked here as well as on the button: a disabled button is a rendering
  // of this rule, not the rule itself, and this is also reached from the
  // Return key on the default-model link.
  if (!wizardCanAdvance(wizardStep)) return;
  if (wizardStep === "voice") await commitLadderChoice();
  const at = WIZARD_STEPS.indexOf(wizardStep);
  const next = WIZARD_STEPS[at + 1];
  if (!next) {
    closeWizard();
    return;
  }
  showWizardStep(next);
}

/**
 * Puts the wizard away for good, from the last page.
 *
 * The flag is the only thing written here; everything the wizard asks was
 * saved as it was answered, so quitting halfway through loses nothing and
 * reopens where it stood.
 */
function closeWizard(): void {
  wizardStep = null;
  watchPermissions(false);
  element.wizard.hidden = true;
  element.app.inert = false;
  void patchSettings({ onboardingCompleted: true });
}

export function bindWizard(): void {
  element.wizardNext.addEventListener("click", () => void advanceWizard());

  // A click on the track and the first instant of a drag are the same event
  // with the same value. These two tell them apart.
  element.ladderSlider.addEventListener("pointerdown", () => {
    ladderPointerDown = true;
    ladderPointerMoved = false;
  });
  // On the window, not the slider: the pointer is captured by the input for
  // the length of a drag, but a drag that leaves the control still has to
  // count as movement.
  window.addEventListener("pointermove", () => {
    if (!ladderPointerDown || ladderPointerMoved) return;
    ladderPointerMoved = true;
    // From here the thumb belongs to the finger.
    cancelLadderGlide();
  });
  window.addEventListener("pointerup", () => {
    ladderPointerDown = false;
  });

  element.ladderSlider.addEventListener("input", () => {
    const raw = Number(element.ladderSlider.value);
    // Touched by hand: from here the button names the model rather than
    // calling it the default. Written before the branch below, because a
    // click that lands on the rung it was already on changes no rung and so
    // would never reach the card's redraw.
    ladderTouched = true;
    renderVoiceButton();
    if (ladderPointerDown && !ladderPointerMoved) {
      // Pressed somewhere along the track without dragging. The input has
      // already jumped its value there; put it back and travel.
      glideLadderTo(Math.round(raw));
      return;
    }
    cancelLadderGlide();
    ladderIndex = raw;
    renderLadder();
  });

  // Released after a drag: settle onto the rung it is nearest, so the thumb
  // never comes to rest between two notches the card is not describing. A
  // click is already gliding and must not be restarted.
  element.ladderSlider.addEventListener("change", () => {
    if (!ladderPointerMoved) return;
    glideLadderTo(Math.round(Number(element.ladderSlider.value)));
  });
  // `step="any"` is what makes the drag continuous, and it would otherwise
  // make an arrow key move a hundredth of a rung. The keyboard gets the stops
  // the pointer no longer has.
  element.ladderSlider.addEventListener("keydown", (event) => {
    const last = MODEL_LADDER.length - 1;
    const step =
      event.key === "ArrowRight" || event.key === "ArrowUp"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowDown"
          ? -1
          : 0;
    let next = step === 0 ? null : Math.round(ladderIndex) + step;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = last;
    if (next === null) return;
    event.preventDefault();
    ladderTouched = true;
    renderVoiceButton();
    glideLadderTo(next);
  });
  element.keyboard.addEventListener("click", (event) => {
    const option = (event.target as HTMLElement).closest<HTMLElement>("[data-hotkey]");
    const id = option?.dataset.hotkey;
    if (!isHotkeyBindingId(id)) return;
    void patchSettings({ hotkeyId: id });
  });

  element.wizardPolishLevels.addEventListener("click", (event) => {
    const card = (event.target as HTMLElement).closest<HTMLElement>("[data-level]");
    const level = card?.dataset.level;
    if (!isPolishLevel(level)) return;
    // The same write the AI Polish page makes: the level owns the instruction
    // the dictation path runs, so choosing one puts that level's default back.
    void patchSettings({
      polishLevel: level,
      transformPrompt: transformPromptFor(level),
    }).then(prefetchPolishModel);
  });

  element.wizardKeyInput.addEventListener("input", () => {
    element.wizardKeyInput.dataset.pristine = "false";
    syncWizardKeyButton();
  });
  element.wizardKeyInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") saveWizardApiKey();
  });
  element.wizardKeySave.addEventListener("click", saveWizardApiKey);
  element.wizardOpenOpenRouter.addEventListener("click", () => {
    void host().openUrl("https://openrouter.ai/keys");
  });

  element.wizardEngine.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>("[data-engine]");
    const engine = button?.dataset.engine;
    if (engine !== "local" && engine !== "openrouter") return;
    void patchSettings({ polishEngine: engine });
  });

  // The permission rows are rebuilt whenever one is granted, so the button is
  // found on the way up rather than bound to a node that will be replaced.
  element.wizardChecklist.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLElement>("[data-fix]");
    if (button) resolveSetupStep(button.dataset.fix ?? "");
  });
}
