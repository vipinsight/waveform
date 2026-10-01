import { getSpeechModel } from "../../shared/models";
import { DEFAULT_POLISH_MODEL_ID } from "../../shared/polish-models";
import { host } from "../host";
import { requireElement } from "../ui/dom";
import { formatBytes } from "../ui/format";
import { state } from "../state";
import { renderDictationDeck, renderShortcutCard } from "./dictation";
import { renderEmptyState } from "./history";
import { downloadModel, downloadPolishModel, isQueued, renderModelKinds } from "./models";
import { refreshMicrophones } from "./settings-panel";
import { renderWizard } from "./wizard";

/**
 * Everything that has to be true before dictation works end to end, and the
 * checklist that says which of it is not yet: on the Dictations page until
 * setup is done, and on the Dictation page beside the shortcut.
 */

const element = {
  onboardSteps: requireElement<HTMLElement>("onboard-steps"),
  onboardCount: requireElement<HTMLElement>("onboard-count"),
  onboardBar: requireElement<HTMLElement>("onboard-bar"),
  dictationSetup: requireElement<HTMLElement>("dictation-setup"),
  dictationSteps: requireElement<HTMLOListElement>("dictation-steps"),
  setupBadge: requireElement<HTMLElement>("setup-badge"),
};

export interface SetupStep {
  id: string;
  done: boolean;
  /** What the step gets you, in the words of someone who has not read a manual. */
  title: string;
  /**
   * What macOS calls the same thing.
   *
   * Said as well as the plain title rather than instead of it: the plain title
   * is what makes the step make sense, and this is the word they have to find
   * in System Settings a second later. Dropping either one strands someone.
   */
  detail: string;
  /** The button, which is a verb. */
  action: string;
  /** How the step reads inside a sentence listing what is missing. */
  label: string;
}

export function bindSetup(): void {
  // Delegated rather than bound per button: both the onboarding card and the
  // Setup page rebuild their rows whenever a step completes.
  for (const container of [element.onboardSteps, element.dictationSteps]) {
    container.addEventListener("click", (event) => {
      const button = (event.target as HTMLElement).closest<HTMLElement>("[data-fix]");
      if (button) resolveSetupStep(button.dataset.fix ?? "");
    });
  }
}

/**
 * Everything that has to be true before dictation works end to end.
 *
 * Ordered the way a person meets them: hear you, put the words somewhere, see
 * the key that starts it, and have something to do the listening with.
 *
 * Typing comes before the shortcut because it is the half people recognise --
 * "it types for you" is the app, while Input Monitoring is the plumbing that
 * notices a key -- and a list that opens with two pieces of plumbing reads as
 * more suspicious than it is.
 *
 * The model is a step like any other because it is one. Weights are not
 * bundled -- the disk image would be half a gigabyte heavier and most of it
 * unwanted -- and nothing downloads them on its own, so an install with three
 * permissions granted and no model is an install that fails on the first
 * phrase with a file path in the error. It used to do exactly that.
 */
export function setupSteps(): SetupStep[] {
  const { settings, modelInstalled, modelDownloadSize, polishInstalled, polishLabel, polishDownloadSize } = state;
  const status = state.hotkeyStatus;
  const model = getSpeechModel(settings.modelId);
  return [
    {
      id: "microphone",
      done: status?.microphone === "granted",
      title: "Let Waveform hear you",
      detail: "Microphone — macOS will ask, and the audio stays on this Mac",
      action: "Allow",
      label: "microphone access",
    },
    {
      id: "accessibility",
      done: status?.accessibility === true,
      title: "Let it type for you",
      detail: "Accessibility — so your words land wherever your cursor is",
      action: "Allow",
      label: "Accessibility",
    },
    {
      id: "input-monitoring",
      done: status?.inputMonitoring === true,
      title: "Let it watch for your shortcut",
      detail: "Input Monitoring — so your key works in every app, not just this one",
      action: "Allow",
      label: "Input Monitoring",
    },
    {
      id: "model",
      done: modelInstalled,
      title: "Download a speech model",
      detail: `${model.label}${modelDownloadSize === "" ? "" : ` · ${modelDownloadSize}`} — the part that turns speech into words`,
      action: "Download",
      label: "a speech model",
    },
    // A fifth step only when something is set to rewrite with it. At None no
    // model runs on the dictation path, and through OpenRouter the rewriting
    // happens elsewhere -- in both cases a missing local model stops nothing,
    // and a checklist row for it would be a chore invented out of nothing.
    ...(settings.polishLevel !== "none" && settings.polishEngine === "local"
      ? [
          {
            id: "polish-model",
            done: polishInstalled,
            title: "Download the AI polish model",
            detail: `${polishLabel}${polishDownloadSize === "" ? "" : ` · ${polishDownloadSize}`} — the part that tidies what you said`,
            action: "Download",
            label: "the AI polish model",
          },
        ]
      : []),
  ];
}

/**
 * Whether the chosen model's weights are on this Mac.
 *
 * Kept here rather than asked for at each render: it comes from the catalogue,
 * which is a round trip to the host, and four different things on this page
 * want to know it.
 */
export async function refreshModelInstalled(): Promise<void> {
  const catalog = await host().getModelCatalog().catch(() => []);
  const current = catalog.find((model) => model.selected);
  state.modelInstalled = current ? current.runtimeInstalled && current.weightsInstalled : false;
  state.modelDownloadSize =
    current && current.downloadBytes !== null ? formatBytes(current.downloadBytes) : "";

  // The polish model is the other half of "can this app do what it is set to
  // do", and it is read here so both halves are known at the same moment --
  // a list that ticks one row a round trip after the other reads as broken.
  await readPolishModel();
  const polish = state.wizardPolishModel;
  state.polishInstalled = polish?.installed ?? false;
  state.polishLabel = polish?.label ?? "";
  state.polishDownloadSize = polish ? formatBytes(polish.downloadBytes) : "";

  state.setupKnown = true;
  renderSetup();
  renderDictationDeck();
  renderModelKinds();
}

/** The polish model as the catalogue last described it. */
export async function readPolishModel(): Promise<void> {
  const catalog = await host().getPolishModelCatalog().catch(() => []);
  state.wizardPolishModel =
    catalog.find((model) => model.id === state.settings.localModelId) ??
    catalog.find((model) => model.id === DEFAULT_POLISH_MODEL_ID) ??
    null;
}

/**
 * The first thing a new install shows, and the thing it keeps showing until
 * dictation actually works.
 *
 * It sits where the deck sits, on the page someone lands on, rather than
 * behind a button that opens Settings. Setup used to be three rows inside a
 * modal, reached by pressing "Finish setup" on a card that had already
 * explained nothing -- which is two decisions and a dialog between someone and
 * the first thing they want to do.
 *
 * Each step says what it gets you first and what macOS calls it second. The
 * plain sentence is what makes the step make sense; the macOS term is the one
 * they have to recognise in System Settings ten seconds later.
 */
function renderOnboarding(steps: SetupStep[]): void {
  const done = steps.filter((step) => step.done).length;
  element.onboardCount.textContent = `${done} of ${steps.length}`;
  element.onboardBar.style.width = `${(done / steps.length) * 100}%`;

  const rows = (list: HTMLElement) =>
    list.replaceChildren(...steps.map((step, index) => stepRow(step, index)));
  rows(element.onboardSteps);
  rows(element.dictationSteps);
  element.dictationSetup.hidden = done === steps.length;
}

function stepRow(step: SetupStep, index: number): HTMLLIElement {
  const item = document.createElement("li");
  item.className = "onboard-step";
  item.dataset.done = String(step.done);
  item.dataset.step = step.id;

  const mark = document.createElement("span");
  mark.className = "onboard-mark";
  // The tick replaces the number rather than joining it: a row that is
  // done is no longer a thing with a position in a queue.
  mark.textContent = step.done ? "" : String(index + 1);
  mark.setAttribute("aria-hidden", "true");

  const body = document.createElement("span");
  body.className = "onboard-body";
  const title = document.createElement("strong");
  title.textContent = step.title;
  const detail = document.createElement("small");
  detail.textContent = step.detail;
  body.append(title, detail);

  item.append(mark, body);

  if (!step.done) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "pill-button is-primary onboard-action";
    button.dataset.fix = step.id;
    // Only the selected model's download is this step's. Another one
    // running (the wizard's prefetch) just means this one queues.
    const selectedState =
      step.id !== "model"
        ? null
        : state.downloading === state.settings.modelId
          ? "Downloading…"
          : isQueued(state.settings.modelId)
            ? "Queued"
            : null;
    button.textContent = selectedState ?? step.action;
    button.disabled = selectedState !== null;
    button.setAttribute("aria-label", `${step.action} ${step.label}`);
    item.append(button);
  }
  return item;
}

/**
 * Writes a download's progress onto its row of the onboarding card, so the
 * card shows the same percentage the Models page does rather than a button
 * that says Download while the file is already arriving.
 */
export function showStepProgress(
  id: "model" | "polish-model",
  label: string,
  options: { detail?: string; disable?: boolean } = {},
): void {
  const step = element.onboardSteps.querySelector<HTMLElement>(`[data-step="${id}"]`);
  const action = step?.querySelector("button");
  if (action) {
    action.textContent = label;
    if (options.disable) action.disabled = true;
  }
  if (options.detail !== undefined) {
    const detail = step?.querySelector("small");
    if (detail) detail.textContent = options.detail;
  }
}

function renderSetup(): void {
  const steps = setupSteps();
  const outstanding = steps.filter((step) => !step.done);
  // The wizard draws the same permissions and the same download progress, and
  // a permission granted in System Settings arrives here with nothing else
  // watching for it.
  renderWizard();

  renderOnboarding(steps);
  // On the Transcripts item, where the checklist is, so a step that goes
  // missing later -- a permission reset by an update -- shows from any page.
  element.setupBadge.hidden = outstanding.length === 0;
  element.setupBadge.textContent = String(outstanding.length);

  renderEmptyState();
}

export function resolveSetupStep(id: string): void {
  if (id === "model") {
    void downloadModel(state.settings.modelId);
    return;
  }
  if (id === "polish-model") {
    void downloadPolishModel(state.settings.localModelId).then(refreshModelInstalled);
    return;
  }
  if (id === "microphone") {
    // Same path as opening Dictation: getUserMedia shows the allow prompt.
    // If macOS already refused, only System Settings can flip it back on.
    void refreshMicrophones(true).then((ok) => {
      if (!ok) {
        void host().openPrivacySettings("microphone");
        return;
      }
      // Granted through the WKWebView prompt, which the host did not see. Ask
      // for the status rather than waiting for something to volunteer it.
      void host()
        .getHotkeyStatus()
        .then((status) => {
          state.hotkeyStatus = status;
          renderHotkeyStatus();
        })
        .catch(() => {});
    });
    return;
  }
  if (id !== "accessibility" && id !== "input-monitoring") return;
  if (isScopeGranted(id)) return;
  void host().requestHotkeyPermission(id);
  void host().openPrivacySettings(id);
}

/** Everything drawn from the permissions, after `state.hotkeyStatus` changes. */
export function renderHotkeyStatus(): void {
  // The shortcut card names the binding, and it is rendered from here rather
  // than from anything that could describe a different one.
  renderShortcutCard();
  renderSetup();
  renderDictationDeck();
}

function isScopeGranted(scope: "accessibility" | "input-monitoring"): boolean {
  const status = state.hotkeyStatus;
  if (!status) return false;
  return scope === "accessibility" ? status.accessibility : status.inputMonitoring;
}
