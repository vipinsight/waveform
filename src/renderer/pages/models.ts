import type { ModelEvent, ModelStatus, PolishModelStatus } from "../../shared/contracts";
import { SPEECH_LANGUAGES, isSpeechLanguage } from "../../shared/languages";
import { getSpeechModel, isSpeechModelId, type SpeechModelId } from "../../shared/models";
import { isPolishModelId, polishModelLabel } from "../../shared/polish-models";
import { host } from "../host";
import { TERMINAL_ICON_PATHS, icon, requireElement } from "../ui/dom";
import { formatBytes, formatMemory } from "../ui/format";
import { patchSettings, state } from "../state";
import { renderDictationDeck } from "./dictation";
import { showView } from "../navigation";
import { setStatus } from "./overview";
import { renderAiStatus } from "./polish";
import { isSettingsOpen, toggleSettings } from "./settings-panel";
import { refreshModelInstalled, showStepProgress } from "./setup";
import { refreshReadyProgress, renderWizardLocalProgress } from "./wizard";

/**
 * The Models page: the speech catalogue on one tab and the local polish
 * models on the other, with the download queue that feeds both the page and
 * the wizard's prefetch.
 */

const element = {
  modelTabs: requireElement<HTMLElement>("model-tabs"),
  modelsSpeech: requireElement<HTMLElement>("models-speech"),
  modelsPolish: requireElement<HTMLElement>("models-polish"),
  speechKindCurrent: requireElement<HTMLElement>("speech-kind-current"),
  speechKindState: requireElement<HTMLElement>("speech-kind-state"),
  polishKindCurrent: requireElement<HTMLElement>("polish-kind-current"),
  polishKindState: requireElement<HTMLElement>("polish-kind-state"),
  speechLanguage: requireElement<HTMLSelectElement>("speech-language"),
  dictationLanguage: requireElement<HTMLSelectElement>("dictation-language"),
  modelList: requireElement<HTMLElement>("model-list"),
  polishModelList: requireElement<HTMLElement>("polish-model-list"),
};

/**
 * Downloads waiting their turn behind `state.downloading`.
 *
 * The host fetches one model at a time: parallel transfers share one
 * connection, so none would finish sooner, and the Parakeet and Qwen
 * installers share a Python environment that two at once would corrupt.
 * Without a queue a second Download press did nothing at all.
 */
interface QueuedDownload {
  id: SpeechModelId;
  /** Put into use once it lands; see `downloadModel`. */
  useWhenReady: boolean;
  /** The selection when it was asked for: a later pick overrides it. */
  selectedWhenAsked: SpeechModelId;
  finished: Promise<void>;
  resolve: () => void;
}
let downloadQueue: QueuedDownload[] = [];
let activeDownload: QueuedDownload | null = null;

/** Which half of the Models page is up: voice to text, or rewriting text. */
let modelsTab: "speech" | "polish" = "speech";

export function bindModels(): void {
  host().onModelEvent(handleModelEvent);
  host().onPolishModelEvent(showPolishDownloadProgress);

  element.modelList.addEventListener("click", (event) => {
    // The card link sits inside the row, so it is checked first: otherwise
    // reading about a model would also switch to it. Download, cancel and
    // delete are the same kind of exception.
    const card = (event.target as HTMLElement).closest<HTMLElement>("[data-card]");
    if (card?.dataset.card) {
      void host().openUrl(card.dataset.card);
      return;
    }
    const remove = (event.target as HTMLElement).closest<HTMLElement>("[data-remove]");
    if (remove?.dataset.remove && isSpeechModelId(remove.dataset.remove)) {
      void deleteModel(remove.dataset.remove);
      return;
    }
    const fetch = (event.target as HTMLElement).closest<HTMLElement>("[data-fetch]");
    if (fetch?.dataset.fetch && isSpeechModelId(fetch.dataset.fetch)) {
      void downloadModel(fetch.dataset.fetch, { useWhenReady: true });
      return;
    }
    const cancel = (event.target as HTMLElement).closest<HTMLElement>("[data-cancel-download]");
    if (cancel) {
      void host().cancelModelDownload();
      return;
    }
    const unqueue = (event.target as HTMLElement).closest<HTMLElement>("[data-cancel-queued]");
    if (unqueue?.dataset.cancelQueued && isSpeechModelId(unqueue.dataset.cancelQueued)) {
      cancelQueuedDownload(unqueue.dataset.cancelQueued);
      return;
    }
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-model]");
    const id = row?.dataset.model;
    if (!id || !isSpeechModelId(id)) return;
    if (row?.getAttribute("aria-disabled") === "true") return;
    void host().selectModel(id);
  });

  // Installed polish models are chosen by the row; missing ones only by their
  // Download button, so a press meant for the HF link cannot start a fetch.
  element.polishModelList.addEventListener("click", (event) => {
    const card = (event.target as HTMLElement).closest<HTMLElement>("[data-card]");
    if (card?.dataset.card) {
      void host().openUrl(card.dataset.card);
      return;
    }
    const remove = (event.target as HTMLElement).closest<HTMLElement>("[data-remove]");
    if (remove?.dataset.remove && isPolishModelId(remove.dataset.remove)) {
      void deletePolishModel(remove.dataset.remove);
      return;
    }
    const fetch = (event.target as HTMLElement).closest<HTMLElement>("[data-fetch]");
    if (fetch?.dataset.fetch && isPolishModelId(fetch.dataset.fetch)) {
      void downloadPolishModel(fetch.dataset.fetch);
      return;
    }
    const cancel = (event.target as HTMLElement).closest<HTMLElement>("[data-cancel-download]");
    if (cancel) {
      void host().cancelPolishModelDownload();
      return;
    }
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-model]");
    const id = row?.dataset.model;
    if (!id || !isPolishModelId(id)) return;
    if (row?.getAttribute("aria-disabled") === "true") return;
    void patchSettings({ localModelId: id });
  });

  element.speechLanguage.addEventListener("change", () => {
    const value = element.speechLanguage.value;
    if (isSpeechLanguage(value)) void patchSettings({ speechLanguage: value });
  });
  element.dictationLanguage.addEventListener("change", () => {
    const value = element.dictationLanguage.value;
    if (isSpeechLanguage(value)) void patchSettings({ speechLanguage: value });
  });
}

/** Opens the Models page on one kind of model, closing Settings if it is up. */
export function showModelsTab(tab: "speech" | "polish"): void {
  modelsTab = tab;
  for (const button of Array.from(
    element.modelTabs.querySelectorAll<HTMLElement>("[data-model-tab]"),
  )) {
    const active = button.dataset.modelTab === tab;
    button.setAttribute("aria-selected", String(active));
  }
  element.modelsSpeech.hidden = tab !== "speech";
  element.modelsPolish.hidden = tab !== "polish";
  if (isSettingsOpen()) toggleSettings(false);
  showView("models");
}

/**
 * Re-reads whichever tab is up. Both lists describe files on the disk, which
 * arrive while the section is closed -- from a download here, or from a
 * terminal -- so each is re-read on the way in rather than trusted from
 * startup.
 */
export function refreshModelsView(): void {
  if (modelsTab === "polish") void renderPolishModels();
  else void renderModels();
}

/**
 * The two cards at the top of the Models page: which model each kind is set
 * to, and the one thing standing between it and working, if anything.
 */
export function renderModelKinds(): void {
  const { settings, aiStatus, setupKnown, modelInstalled } = state;
  element.speechKindCurrent.textContent = getSpeechModel(settings.modelId).label;
  setKindState(
    element.speechKindState,
    setupKnown && !modelInstalled ? "Not downloaded yet" : "In use",
    setupKnown && !modelInstalled,
  );

  const local = settings.polishEngine === "local";
  element.polishKindCurrent.textContent = local
    ? `${polishModelLabel(settings.localModelId)}, on this Mac`
    : `${settings.openRouterModel}, through OpenRouter`;
  const level = settings.polishLevel;
  const missing = local
    ? aiStatus !== null && !aiStatus.localReady
      ? "Not downloaded yet"
      : null
    : aiStatus !== null && !aiStatus.hasApiKey
      ? "Needs an OpenRouter key"
      : null;
  if (level === "none") {
    setKindState(element.polishKindState, "Off: AI Polish is set to None", false);
  } else if (missing) {
    setKindState(element.polishKindState, missing, true);
  } else {
    setKindState(element.polishKindState, "In use", false);
  }
}

function setKindState(target: HTMLElement, text: string, attention: boolean): void {
  target.textContent = text;
  if (attention) target.dataset.tone = "attention";
  else delete target.dataset.tone;
}

/** The language pickers on the Models and Dictation pages, which are one setting. */
export function renderLanguageSelect(): void {
  for (const select of [element.speechLanguage, element.dictationLanguage]) {
    if (select.options.length === 0) {
      select.append(...SPEECH_LANGUAGES.map(({ code, label }) => new Option(label, code)));
    }
    select.value = state.settings.speechLanguage;
  }
}

/**
 * The models, and what is on this machine for each.
 *
 * All of them, every time. They used to arrive folded, with a `Show every size`
 * button holding back the eleven nobody had downloaded -- which meant the page
 * opened having already decided the question it exists to ask.
 *
 * What makes the full list readable instead is that each row is four facts in
 * one line: how accurate, how big to fetch, how much memory to keep loaded, and
 * a link to the page those came from.
 */
export async function renderModels(): Promise<void> {
  const catalog = await host().getModelCatalog().catch(() => []);

  // Group headings come from the catalogue in its own order, so the interface
  // does not hold a second opinion about which groups exist.
  const groups = catalog.reduce<{ heading: string; models: ModelStatus[] }[]>((all, model) => {
    const group = all.find((candidate) => candidate.heading === model.group);
    if (group) group.models.push(model);
    else all.push({ heading: model.group, models: [model] });
    return all;
  }, []);

  const sections = groups.flatMap(({ heading, models }) => {
    const rows = document.createElement("div");
    rows.className = "model-list";
    // One radio group per heading: arrow keys then move within a group rather
    // than sweeping from Parakeet through fourteen Whisper sizes.
    rows.setAttribute("role", "radiogroup");
    rows.setAttribute("aria-label", heading || models.map((model) => model.label).join(", "));
    rows.append(...models.map(modelRow));
    // Parakeet and Qwen sit at the top unnamed: a heading here used to say
    // "Other engines", which made them sound like leftovers.
    if (heading === "") return [rows];
    const title = document.createElement("h2");
    title.className = "model-group";
    title.textContent = heading;
    return [title, rows];
  });

  element.modelList.replaceChildren(...sections);
}

/** Frees installed weights — same pill shape as Download. */
function removeButton(id: string, label: string, size: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "pill-button model-remove";
  button.dataset.remove = id;
  button.textContent = "Remove";
  button.title = size === "" ? `Remove ${label}` : `Remove ${label} — free ${size}`;
  button.setAttribute(
    "aria-label",
    size === "" ? `Remove ${label}` : `Remove ${label} to free ${size}`,
  );
  return button;
}

/**
 * Installed at rest; Remove on hover / focus. Keeps the slot filled so a
 * downloaded row does not look like a missing Download, and only offers
 * destructive action when the pointer is on this control.
 */
function installedControls(id: string, label: string, size: string): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "model-installed-controls";

  const installed = document.createElement("span");
  installed.className = "pill-button model-installed";
  installed.textContent = "Installed";
  installed.setAttribute("aria-hidden", "true");

  wrap.append(installed, removeButton(id, label, size));
  return wrap;
}

/** Starts a fetch the row itself no longer does. */
function fetchButton(id: string, label: string, size: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "pill-button model-fetch";
  button.dataset.fetch = id;
  button.textContent = "Download";
  button.title = `Download ${label} — ${size}`;
  button.setAttribute("aria-label", `Download ${label}, ${size}`);
  return button;
}

/** Stops the in-flight fetch; progress sits beside it while it runs. */
function cancelDownloadButton(): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "model-download-controls";

  const progress = document.createElement("span");
  progress.className = "model-progress";
  progress.textContent = "0%";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "pill-button model-cancel";
  button.dataset.cancelDownload = "true";
  button.textContent = "Cancel";
  button.setAttribute("aria-label", "Cancel download");

  wrap.append(progress, button);
  return wrap;
}

/** Waiting behind another download; Cancel takes it out of the line. */
function queuedDownloadControls(id: string, label: string): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "model-download-controls";

  const queued = document.createElement("span");
  queued.className = "model-progress";
  queued.textContent = "Queued";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "pill-button model-cancel";
  button.dataset.cancelQueued = id;
  button.textContent = "Cancel";
  button.setAttribute("aria-label", `Remove ${label} from the download queue`);

  wrap.append(queued, button);
  return wrap;
}

/**
 * One model: the numbers to choose on, and what it would take to have it.
 *
 * The row is not the button. Choosing a model and reading about it are
 * different acts, and a link inside a button is not a thing a browser will
 * render -- so the press target is a transparent layer over the whole row, and
 * everything visible sits on top of it and lets clicks through. The arrow out
 * to Hugging Face, the Download / Cancel controls, and delete are exceptions.
 *
 * A model whose weights are here is chosen by pressing the row. One whose
 * weights are not is fetched only by its Download button -- pressing the row
 * must not start a gigabyte transfer by accident.
 */
function modelRow(model: ModelStatus): HTMLElement {
  const ready = model.runtimeInstalled && model.weightsInstalled;
  const fetchable = !ready && model.downloadBytes !== null;
  const busy = state.downloading === model.id;
  const queued = !busy && isQueued(model.id);
  const size = model.downloadBytes === null ? "" : formatBytes(model.downloadBytes);

  // The numbers the choice is made on. A third line of prose is dropped: the
  // group heading and the figures already say what the model is for.
  const facts = [
    model.wer === null ? "" : `${model.wer.toFixed(1)}% errors`,
    size,
    `${formatMemory(model.memoryMb)} RAM`,
  ]
    .filter((part) => part !== "")
    .join(" · ");
  // Only when the app cannot fetch the weights: that command is the next act,
  // not a description.
  const aside = ready || fetchable ? "" : `Run ${model.setupCommand}`;

  const pick = document.createElement("button");
  pick.type = "button";
  pick.className = "model-pick";
  pick.dataset.model = model.id;
  if (ready) {
    pick.setAttribute("role", "radio");
    pick.setAttribute("aria-checked", String(model.selected));
    pick.setAttribute("aria-label", `${model.label} — ${facts}`);
  } else {
    // Nothing the row press does: Download has its own button, and a terminal
    // model needs a command typed elsewhere.
    pick.setAttribute("aria-disabled", "true");
    pick.setAttribute(
      "aria-label",
      fetchable ? `${model.label} — ${facts}` : `${model.label} — run ${model.setupCommand}`,
    );
  }

  const card = document.createElement("button");
  card.type = "button";
  card.className = "model-card";
  card.dataset.card = model.cardUrl;
  // The arrow a link out of the app is drawn with, sitting against the name it
  // belongs to rather than at the far end of the row.
  card.textContent = "↗";
  card.setAttribute("aria-label", `Open ${model.label} on Hugging Face`);
  card.title = `Open ${model.label} on Hugging Face`;

  const name = document.createElement("span");
  name.className = "model-name";
  const title = document.createElement("strong");
  title.textContent = model.label;
  name.append(title, card);

  const factLine = document.createElement("small");
  factLine.className = "model-facts";
  factLine.textContent = facts;
  if (model.wer !== null) {
    factLine.title = "Word error rate — lower is more accurate";
  }

  const body = document.createElement("span");
  body.className = "model-body";
  body.append(name, factLine);
  if (aside !== "") {
    const detail = document.createElement("small");
    detail.className = "model-detail";
    detail.textContent = aside;
    body.append(detail);
  }

  const row = document.createElement("div");
  row.className = "model-row";
  row.setAttribute("role", "presentation");
  // What the row is, in one word, so the stylesheet can say the rest: a model
  // that is not here reads dimmer than one that is.
  row.dataset.state = ready
    ? "here"
    : busy || queued
      ? "busy"
      : fetchable
        ? "download"
        : "terminal";
  row.append(pick, body);

  if (ready && model.selected) {
    const tag = document.createElement("span");
    tag.className = "model-tag";
    tag.dataset.ready = "true";
    tag.textContent = "In use";
    row.append(tag);
  }

  if (busy) {
    row.append(cancelDownloadButton());
  } else if (queued) {
    row.append(queuedDownloadControls(model.id, model.label));
  } else if (fetchable) {
    row.append(fetchButton(model.id, model.label, size));
  } else if (!ready) {
    const action = document.createElement("span");
    action.className = "model-action";
    action.append(icon("terminal", TERMINAL_ICON_PATHS));
    action.title = `Run ${model.setupCommand}`;
    row.append(action);
  }

  // Installed slot (Remove on hover). weightsInstalled alone covers a runtime
  // that is still missing — Remove clears the cache; Download finishes setup.
  if (model.weightsInstalled && !busy) {
    row.append(installedControls(model.id, model.label, size));
  }

  return row;
}

/**
 * Frees the weight file, so a model that is no longer wanted is not occupying
 * a gigabyte. The list is rebuilt afterwards: the row's whole text depends on
 * whether the file is there now.
 */
async function deleteModel(id: SpeechModelId): Promise<void> {
  try {
    await host().deleteModel(id);
  } catch {
    // The failure already arrived as an error, or there was nothing to delete.
  } finally {
    await renderModels();
    await refreshModelInstalled();
  }
}

async function deletePolishModel(id: string): Promise<void> {
  try {
    await host().deletePolishModel(id);
  } catch {
    // Same as speech: the row rebuild is what says whether the file is gone.
  } finally {
    await renderPolishModels();
    renderAiStatus(await host().getAiStatus());
  }
}

/**
 * Asks for a model, joining the queue if another is downloading.
 *
 * Resolves when this model's download ends, however it ends, so the wizard's
 * prefetch can still take its models one after another.
 *
 * `useWhenReady` is for the Models page's Download button: pressing it is
 * choosing the model, and making someone come back to select it once it
 * lands read as the download not having worked. It is skipped if another
 * model was picked in the meantime -- that is the later choice. The wizard's
 * background prefetch and the setup card do not pass it.
 */
export function downloadModel(
  id: SpeechModelId,
  options: { useWhenReady?: boolean } = {},
): Promise<void> {
  const existing =
    activeDownload?.id === id ? activeDownload : downloadQueue.find((entry) => entry.id === id);
  if (existing) {
    // Asked again from the Models page after the wizard queued it on spec.
    if (options.useWhenReady && !existing.useWhenReady) {
      existing.useWhenReady = true;
      existing.selectedWhenAsked = state.settings.modelId;
    }
    return existing.finished;
  }

  let resolve = (): void => {};
  const finished = new Promise<void>((done) => {
    resolve = done;
  });
  downloadQueue.push({
    id,
    useWhenReady: options.useWhenReady ?? false,
    selectedWhenAsked: state.settings.modelId,
    finished,
    resolve,
  });
  void pumpDownloads();
  return finished;
}

export function isQueued(id: string): boolean {
  return downloadQueue.some((entry) => entry.id === id);
}

/** Starts the next queued download when nothing is running. */
async function pumpDownloads(): Promise<void> {
  if (activeDownload) {
    // Still running: only the new "Queued" row needs drawing.
    await renderModels();
    return;
  }
  const next = downloadQueue.shift();
  if (!next) return;
  activeDownload = next;
  state.downloading = next.id;
  if (next.id === state.settings.modelId) state.speechPercent = 0;
  await renderModels();
  try {
    await host().downloadModel(next.id);
    if (
      next.useWhenReady &&
      state.settings.modelId === next.selectedWhenAsked &&
      state.settings.modelId !== next.id
    ) {
      // Not awaited, like a row click: loading the engine is the models
      // page's own progress, not the download's.
      void host().selectModel(next.id);
    }
  } catch {
    // Cancelled or failed: the event already said which, and the rebuild below
    // puts the Download button back.
  } finally {
    activeDownload = null;
    state.downloading = null;
    next.resolve();
    await renderModels();
    // The model is a setup step, so its arrival is what closes the last row of
    // the onboarding card.
    await refreshModelInstalled();
    void pumpDownloads();
  }
}

function cancelQueuedDownload(id: SpeechModelId): void {
  const entry = downloadQueue.find((queued) => queued.id === id);
  if (!entry) return;
  downloadQueue = downloadQueue.filter((queued) => queued !== entry);
  entry.resolve();
  void renderModels();
}

/**
 * Writes progress next to Cancel rather than rebuilding the list.
 *
 * A rebuild four times a second would ask the host for the whole catalogue
 * each time, and replace the button under the pointer that started it. The
 * facts line keeps size and RAM — the percent beside Cancel is enough.
 */
function showDownloadProgress(event: ModelEvent): void {
  // The onboarding card offers the same download without the models page ever
  // being opened, so it gets the same progress.
  const percent = Math.round((event.progress ?? 0) * 100);
  // The setup card and the wizard's last page wait on the selected model;
  // a queued neighbour's percentage would be a number about something else.
  const forSelected = event.modelId === state.settings.modelId;
  if (forSelected) state.speechPercent = percent;
  if (forSelected) refreshReadyProgress();
  // Nothing for the wizard beyond the last page. It fetches two models on
  // spec before anyone asks for one, and a percentage counting up in its
  // footer would be announcing a download the person never started.
  if (forSelected) showStepProgress("model", `${percent}%`, { detail: event.message });

  const pick = element.modelList.querySelector<HTMLElement>(
    `[data-model="${event.modelId}"]`,
  );
  const row = pick?.closest(".model-row");
  if (!row) return;
  const progress = row.querySelector<HTMLElement>(".model-progress");
  if (progress) {
    progress.textContent = `${percent}%`;
  }
}

export function handleModelEvent(event: ModelEvent): void {
  // A download runs for whichever row was pressed, which is not necessarily
  // the selected model, so this cannot be filtered by selection: the progress
  // would go on the floor for every model but one.
  if (event.stage === "downloading") {
    showDownloadProgress(event);
    return;
  }
  if (event.modelId !== state.settings.modelId) {
    // Nothing about the running engine changed, but a download that failed is
    // still worth saying out loud.
    if (event.stage === "error") setStatus(event.message);
    return;
  }

  if (event.stage === "ready") {
    state.modelReady = true;
    state.modelLoading = false;
  } else if (event.stage === "error") {
    state.modelReady = false;
    state.modelLoading = false;
  } else if (event.stage === "idle") {
    // Not loaded, and not loading either: the engine waits for a first
    // session, so this must not read as work in progress.
    state.modelReady = false;
    state.modelLoading = false;
  } else {
    state.modelLoading = true;
  }

  setStatus(event.message);
  renderDictationDeck();
}

/**
 * The models the local engine can run, and what it would take to have one.
 *
 * The same rows as the speech catalogue, with fewer numbers on them: there is
 * no runtime to install and no error rate to compare, so what is left is how
 * big the download is and what keeping it loaded costs.
 */
export async function renderPolishModels(): Promise<void> {
  const catalog = await host().getPolishModelCatalog().catch(() => []);
  element.polishModelList.replaceChildren(...catalog.map(polishModelRow));
}

function polishModelRow(model: PolishModelStatus): HTMLElement {
  const size = formatBytes(model.downloadBytes);
  const facts = `${size} · ${formatMemory(model.memoryMb)} RAM`;
  const busy = state.polishDownloading === model.id;

  const pick = document.createElement("button");
  pick.type = "button";
  pick.className = "model-pick";
  pick.dataset.model = model.id;
  // A radio only where there is something to choose. Missing weights are
  // fetched by their own button, so the row itself must not start a download.
  if (model.installed) {
    pick.setAttribute("role", "radio");
    pick.setAttribute("aria-checked", String(model.selected));
    pick.setAttribute("aria-label", `${model.label} — ${facts}`);
  } else {
    pick.setAttribute("aria-disabled", "true");
    pick.setAttribute("aria-label", `${model.label} — ${facts}`);
  }

  const card = document.createElement("button");
  card.type = "button";
  card.className = "model-card";
  card.dataset.card = model.cardUrl;
  card.textContent = "↗";
  card.setAttribute("aria-label", `Open ${model.label} on Hugging Face`);
  card.title = `Open ${model.label} on Hugging Face`;

  const name = document.createElement("span");
  name.className = "model-name";
  const title = document.createElement("strong");
  title.textContent = model.label;
  name.append(title, card);

  const factLine = document.createElement("small");
  factLine.className = "model-facts";
  factLine.textContent = facts;

  const body = document.createElement("span");
  body.className = "model-body";
  body.append(name, factLine);

  const row = document.createElement("div");
  row.className = "model-row";
  row.setAttribute("role", "presentation");
  row.dataset.state = model.installed ? "here" : busy ? "busy" : "download";
  row.append(pick, body);

  if (model.installed && model.selected) {
    const tag = document.createElement("span");
    tag.className = "model-tag";
    tag.dataset.ready = "true";
    tag.textContent = "In use";
    row.append(tag);
  }

  if (busy) {
    row.append(cancelDownloadButton());
  } else if (!model.installed) {
    row.append(fetchButton(model.id, model.label, size));
  } else {
    row.append(installedControls(model.id, model.label, size));
  }

  return row;
}

/**
 * Fetches a polish model, with the row saying how far it has got.
 *
 * One at a time, and the list is rebuilt afterwards either way -- and so is the
 * AI status, because a model arriving is what turns the tidy-everything switch
 * from unavailable into off.
 */
export async function downloadPolishModel(id: string): Promise<void> {
  if (state.polishDownloading) return;
  state.polishDownloading = id;
  await renderPolishModels();
  try {
    await host().downloadPolishModel(id);
  } catch {
    // Cancelled or failed: the event already said which, and the rebuild below
    // puts the Download button back.
  } finally {
    state.polishDownloading = null;
    await renderPolishModels();
    renderAiStatus(await host().getAiStatus());
    // It is a setup step now, so its arrival is what closes that row.
    await refreshModelInstalled();
  }
}

/** Progress written next to Cancel — the facts line stays as size and RAM. */
function showPolishDownloadProgress(event: ModelEvent): void {
  // The wizard shows this model arriving on its polish page, which is where
  // the choice that started the download was made.
  state.polishPercent = Math.round((event.progress ?? 0) * 100);
  refreshReadyProgress();
  // The onboarding card carries this model as a step, so it shows the same
  // percentage the speech row does rather than a button that says Download
  // while the file is already arriving.
  showStepProgress("polish-model", `${state.polishPercent}%`, { disable: true });
  renderWizardLocalProgress(event.stage === "downloading");

  const pick = element.polishModelList.querySelector<HTMLElement>(
    `[data-model="${event.modelId}"]`,
  );
  const row = pick?.closest(".model-row");
  if (!row) return;
  const progress = row.querySelector<HTMLElement>(".model-progress");
  if (progress && event.progress !== undefined) {
    progress.textContent = `${Math.round(event.progress * 100)}%`;
  }
}
