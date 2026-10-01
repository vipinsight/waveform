import { audioFileToMonoWav, isAudioFile } from "./audio/file-wav";
import { host } from "./host";
import { renderHistory } from "./pages/history";
import { requireElement } from "./ui/dom";
import { state } from "./state";

/**
 * Drop an audio file anywhere on the window to get its text (beta).
 *
 * One overlay carries the whole thing: while a file is dragged over it says
 * what letting go will do, then it shows the work and the result -- text to
 * select, and Copy -- until it is closed. There is no page for it: the drop
 * is the way in, and it can happen from any page.
 *
 * Every drop is claimed whether or not the feature is on. A file dropped
 * where nothing handles it is opened by the webview in place of the app:
 * an audio file became a full-window player with no way back.
 */

const element = {
  dropOverlay: requireElement<HTMLElement>("drop-overlay"),
  dropOverlayTitle: requireElement<HTMLElement>("drop-overlay-title"),
  dropOverlayHint: requireElement<HTMLElement>("drop-overlay-hint"),
  dropOverlayText: requireElement<HTMLElement>("drop-overlay-text"),
  dropOverlayCopy: requireElement<HTMLButtonElement>("drop-overlay-copy"),
  dropOverlayClose: requireElement<HTMLButtonElement>("drop-overlay-close"),
};

/** True while a dropped file is being decoded or transcribed. */
let transcribeBusy = false;

export function bindDropTranscribe(): void {
  let dragDepth = 0;
  const carriesFiles = (event: DragEvent): boolean =>
    Array.from(event.dataTransfer?.types ?? []).includes("Files");
  const leaveDrag = (): void => {
    dragDepth = 0;
    if (element.dropOverlay.dataset.stage === "drag") closeDropOverlay();
  };

  document.addEventListener("dragenter", (event) => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    dragDepth += 1;
    if (dragDepth > 1 || !state.settings.transcribeOnDrop || transcribeBusy) return;
    showDropHint(event);
  });
  document.addEventListener("dragleave", (event) => {
    if (!carriesFiles(event)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) leaveDrag();
  });
  document.addEventListener("dragover", (event) => event.preventDefault());
  document.addEventListener("drop", (event) => {
    event.preventDefault();
    dragDepth = 0;
    const file = event.dataTransfer?.files?.[0];
    if (!state.settings.transcribeOnDrop || transcribeBusy) return;
    if (!file || !isAudioFile(file)) {
      closeDropOverlay();
      return;
    }
    void transcribeDroppedFile(file);
  });
  // A drag that leaves through the window edge fast can skip its last
  // dragleave; losing focus is the other sign it has gone.
  window.addEventListener("blur", leaveDrag);

  element.dropOverlayClose.addEventListener("click", closeDropOverlay);
  // The backdrop closes a finished result, not work still under way.
  element.dropOverlay.addEventListener("click", (event) => {
    const stage = element.dropOverlay.dataset.stage;
    if (event.target === element.dropOverlay && (stage === "done" || stage === "error")) {
      closeDropOverlay();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || element.dropOverlay.hidden) return;
    if (element.dropOverlay.dataset.stage === "working") return;
    event.stopPropagation();
    closeDropOverlay();
  }, true);
  element.dropOverlayCopy.addEventListener("click", () => {
    const text = element.dropOverlayText.textContent ?? "";
    if (!text) return;
    void navigator.clipboard.writeText(text);
    element.dropOverlayCopy.textContent = "Copied";
    setTimeout(() => {
      element.dropOverlayCopy.textContent = "Copy";
    }, 900);
  });
}

type DropStage = "drag" | "working" | "done" | "error";

function setDropStage(stage: DropStage, title: string, hint: string): void {
  element.dropOverlay.dataset.stage = stage;
  element.dropOverlayTitle.textContent = title;
  element.dropOverlayHint.textContent = hint;
  element.dropOverlayText.hidden = stage !== "done";
  element.dropOverlayCopy.hidden = stage !== "done";
  element.dropOverlayClose.hidden = stage === "drag" || stage === "working";
  element.dropOverlay.hidden = false;
}

/**
 * Says what letting go will do. The file cannot be read before the drop,
 * but its type usually can, so a PDF is told it will be ignored.
 */
function showDropHint(event: DragEvent): void {
  const known = Array.from(event.dataTransfer?.items ?? [])
    .filter((item) => item.kind === "file" && item.type !== "")
    .map((item) => item.type);
  const notAudio = known.length > 0 && !known.some((type) => type.startsWith("audio/"));
  element.dropOverlay.dataset.refuse = String(notAudio);
  setDropStage(
    "drag",
    notAudio ? "Only audio files can be transcribed" : "Drop to transcribe",
    notAudio
      ? "WAV, MP3, M4A, and other formats WebKit can decode."
      : "The audio stays on this Mac.",
  );
}

function closeDropOverlay(): void {
  if (element.dropOverlay.dataset.stage === "working") return;
  element.dropOverlay.hidden = true;
  element.dropOverlay.dataset.stage = "drag";
  element.dropOverlay.dataset.refuse = "false";
  element.dropOverlayText.textContent = "";
}

/** Decodes, transcribes and saves a dropped file, in the overlay. */
async function transcribeDroppedFile(file: File): Promise<void> {
  transcribeBusy = true;
  element.dropOverlay.dataset.refuse = "false";
  setDropStage("working", "Transcribing…", file.name);
  try {
    const wav = await audioFileToMonoWav(file);
    const { text } = await host().transcribe(wav);
    const trimmed = (text ?? "").trim();
    if (!trimmed) {
      setDropStage("error", "No words found", `${file.name} has no speech Waveform could hear.`);
      return;
    }
    state.entries = await host().saveDictation(trimmed, wav);
    state.freshId = state.entries[0]?.id ?? null;
    renderHistory();
    element.dropOverlayText.textContent = trimmed;
    setDropStage("done", file.name, "Saved to Dictations");
  } catch (error) {
    setDropStage(
      "error",
      "Could not transcribe",
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    transcribeBusy = false;
  }
}
