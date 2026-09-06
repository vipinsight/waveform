import { AudioCapture } from "./audio/capture";
import { microphoneDevices } from "../shared/microphones";
import { getHotkeyBinding, hotkeyCaption } from "../shared/hotkeys";
import type {
  DictationCommand,
  DictationMode,
  DictationSink,
  DictationState,
} from "../shared/contracts";
import { host } from "./host";
import { installTauriBridge } from "./tauri-bridge";

const BAR_COUNT = 7;
const BAR_GAP = 2.5;
const BAR_WIDTH = 2.5;
const MIN_BAR = 4;
/** Bar colours from the design, in sRGB. */
const BAR_INK = "246, 245, 242";
const ACCENT = "50, 132, 208";
const LEVEL_GAIN = 7;
/** Keeps the HUD up briefly after the last phrase, so it reads as finished. */
const LINGER_MS = 420;
/** Errors stay up longer: they carry information the user has to notice. */
const ERROR_LINGER_MS = 1_600;
/** Spring constants for the meter. Attack outruns release on purpose. */
const SPRING_ATTACK = 0.55;
const SPRING_RELEASE = 0.14;
const SPRING_DAMPING = 0.62;
/** Fraction of the FFT range that carries speech energy worth showing. */
const SPECTRUM_SPAN = 0.42;
const PREVIEW_MS = 2_600;

const STATE_LABEL: Record<DictationState, string> = {
  idle: "Idle",
  listening: "Listening",
  transcribing: "Transcribing",
  rewriting: "Rewriting",
  error: "Error",
};

const hud = requireElement<HTMLElement>("hud");
const srLabel = requireElement<HTMLElement>("hud-label");
const canvas = requireElement<HTMLCanvasElement>("wave");
const cancelButton = requireElement<HTMLButtonElement>("hud-cancel");
const micButton = requireElement<HTMLButtonElement>("hud-mic");
const acceptButton = requireElement<HTMLButtonElement>("hud-accept");
const hintKey = requireElement<HTMLElement>("hud-hint-key");
const context = canvas.getContext("2d");

/** Per-bar displacement and velocity, integrated each frame. */
const levels = new Float32Array(BAR_COUNT);
const velocities = new Float32Array(BAR_COUNT);
const targets = new Float32Array(BAR_COUNT);
let state: DictationState = "idle";
let sink: DictationSink = "insert";
let mode: DictationMode = "hold";
let previewing = false;
let animationFrame: number | null = null;
let lingerTimer: ReturnType<typeof setTimeout> | null = null;
let phase = 0;
let microphoneDeviceId = "";
let showFlowBarAlways = false;
/** Last hover answer from the host; see the `onOverlayHover` subscription. */
let pointerOver = false;

const capture = new AudioCapture({
  onPhrase: (text) => host().reportDictationPhrase({ text, sink }),
  onPendingChange: () => syncDerivedState(),
  onError: () => {
    setState("error");
    scheduleIdle();
  },
  transcribe: (bytes) => host().transcribe(bytes),
  requestMicrophoneAccess: () => host().requestMicrophoneAccess(),
  getMicrophoneDeviceId: () => microphoneDeviceId,
});

// Supplies window.waveform under Tauri; a no-op under Electron.
installTauriBridge();

void host().getSettings().then((settings) => {
  microphoneDeviceId = settings.microphoneDeviceId;
  showFlowBarAlways = settings.showFlowBarAlways;
  applyShortcutHint(settings.hotkeyId);
  if (showFlowBarAlways) showIdle();
});
host().onSettingsChanged((settings) => {
  microphoneDeviceId = settings.microphoneDeviceId;
  showFlowBarAlways = settings.showFlowBarAlways;
  applyShortcutHint(settings.hotkeyId);
});

/**
 * Puts the dictation shortcut in the tooltip the pill raises when hovered, so
 * it is learned from the control it belongs to rather than from Settings. A
 * native `title` cannot do this job: tooltips need the key window, which the
 * HUD is built never to be.
 */
function applyShortcutHint(hotkeyId: Parameters<typeof getHotkeyBinding>[0]): void {
  const binding = getHotkeyBinding(hotkeyId);
  hintKey.textContent = binding ? hotkeyCaption(binding) : "";
  hud.dataset.shortcut = binding ? "true" : "false";
  micButton.setAttribute(
    "aria-label",
    binding ? `Start dictation, or hold ${binding.label}` : "Start dictation",
  );
}

resizeCanvasForDisplay();
window.addEventListener("resize", resizeCanvasForDisplay);
new ResizeObserver(resizeCanvasForDisplay).observe(canvas);
enableDragging();

/*
 * Hover is reported by the host, not observed here. The HUD is built
 * non-focusable so it can never steal focus from the app being dictated into,
 * which also means WebKit sends it no pointer events and matches no `:hover`:
 * its tracking area only fires for the key window. Listening for
 * `pointerenter` left the pill inert until a click had been delivered, and
 * every `:hover` rule in the stylesheet was dead.
 *
 * So the host sends a position and the HUD does its own hit testing. Nothing
 * here listens for `pointerleave`: it would fight the poll, which is the only
 * thing that actually knows where the pointer is.
 */
host().onOverlayCursor((point) => {
  const node = point ? document.elementFromPoint(point.x, point.y) : null;
  // The window is much larger than the pill -- it has to hold the tooltips --
  // so being inside it is not being on the control. Hit testing against the
  // capsule keeps the target the size it looks.
  const target = node instanceof Element ? node.closest(".hud") : null;
  pointerOver = target !== null;
  if (state === "idle") hud.dataset.expanded = pointerOver ? "true" : "false";
  hud.dataset.hover = pointerOver ? controlAt(node) : "";
});

/** Which control the pointer is over, as a `data-hover` value. */
function controlAt(node: Element | null): string {
  const button = node?.closest("button");
  if (button === micButton) return "mic";
  if (button === cancelButton) return "cancel";
  if (button === acceptButton) return "accept";
  return "";
}

hud.addEventListener("focusin", (event) => {
  if (state === "idle" && (event.target as HTMLElement).matches(":focus-visible")) {
    hud.dataset.expanded = "true";
  }
});
hud.addEventListener("focusout", (event) => {
  if (!hud.contains(event.relatedTarget as Node | null) && !pointerOver) {
    hud.dataset.expanded = "false";
  }
});

cancelButton.addEventListener("click", () => void host().cancelDictation());
micButton.addEventListener("click", async () => {
  if (state !== "idle") return;
  micButton.disabled = true;
  try {
    await host().startOverlayDictation();
  } catch {
    setState("error");
    scheduleIdle();
  } finally {
    micButton.disabled = false;
  }
});
acceptButton.addEventListener("click", async () => {
  acceptButton.disabled = true;
  try {
    await host().acceptDictation();
  } catch {
    acceptButton.disabled = false;
  }
});

host().onDictationCommand((command) => void handleCommand(command));

async function handleCommand(command: DictationCommand): Promise<void> {
  if (command.action === "preview") {
    startPreview();
    return;
  }

  if (command.action === "idle") {
    showIdle();
    return;
  }

  // Something went wrong out of sight of the app window; show it rather than
  // vanishing, which reads as the shortcut doing nothing at all.
  if (command.action === "fail") {
    cancelLinger();
    previewing = false;
    hud.dataset.mode = "hold";
    setState("error");
    startAnimation();
    scheduleIdle();
    return;
  }

  if (command.action === "busy") {
    cancelLinger();
    previewing = false;
    hud.dataset.mode = "hold";
    setState("rewriting");
    startAnimation();
    return;
  }

  sink = command.sink;
  mode = command.mode;
  hud.dataset.mode = mode;

  if (command.action === "start") {
    cancelLinger();
    previewing = false;
    acceptButton.disabled = false;
    if (capture.isRunning) {
      setState("listening");
      return;
    }
    // Paint first, open the microphone second. getUserMedia costs 100-300ms,
    // and waiting for it before showing the HUD is the difference between the
    // indicator feeling instant and feeling broken.
    setState("listening");
    startAnimation();
    try {
      await capture.start();
      void syncAvailableMicrophones();
    } catch {
      setState("error");
      scheduleIdle();
    }
    return;
  }

  if (command.action === "cancel") {
    capture.cancel();
    finish();
    return;
  }

  capture.stop();
  acceptButton.disabled = true;
  syncDerivedState();
  scheduleIdle();
}

/** After first capture WebKit exposes readable labels, so populate the tray. */
async function syncAvailableMicrophones(): Promise<void> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    await host().setAvailableMicrophones(microphoneDevices(devices));
  } catch {
    // Capture itself succeeded; a missing tray refresh must not interrupt it.
  }
}

/** Shows the HUD with synthetic levels so it can be found without dictating. */
function startPreview(): void {
  cancelLinger();
  previewing = true;
  mode = "latched";
  hud.dataset.mode = mode;
  setState("listening");
  startAnimation();
  lingerTimer = setTimeout(() => {
    lingerTimer = null;
    previewing = false;
    finish();
  }, PREVIEW_MS);
}

function syncDerivedState(): void {
  if (state === "error") return;
  if (capture.isRunning) {
    setState(capture.pendingCount > 0 ? "transcribing" : "listening");
    return;
  }
  if (capture.pendingCount > 0) {
    setState("transcribing");
    return;
  }
  scheduleIdle();
}

function scheduleIdle(): void {
  cancelLinger();
  lingerTimer = setTimeout(
    () => {
      lingerTimer = null;
      if (capture.isRunning || capture.pendingCount > 0) return;
      finish();
    },
    state === "error" ? ERROR_LINGER_MS : LINGER_MS,
  );
}

function cancelLinger(): void {
  if (lingerTimer === null) return;
  clearTimeout(lingerTimer);
  lingerTimer = null;
}

function finish(): void {
  stopAnimation();
  levels.fill(0);
  velocities.fill(0);
  targets.fill(0);
  state = "idle";
  hud.dataset.mode = "hold";
  hud.dataset.state = "idle";
  hud.dataset.visible = showFlowBarAlways ? "true" : "false";
  srLabel.textContent = STATE_LABEL.idle;
  syncIdleHover();
  host().reportDictationState({ state: "idle", sink, mode });
}

/**
 * Accepting or cancelling collapses the pill under a pointer that never left
 * it, so nothing else would tell the bar it is still hovered until the cursor
 * moved away and back.
 */
function syncIdleHover(): void {
  const hovered = pointerOver && hud.dataset.visible === "true";
  hud.dataset.expanded = hovered ? "true" : "false";
  hud.dataset.hover = "";
}

/** Renders the persistent Wave Bar without starting capture or reporting a session. */
function showIdle(): void {
  cancelLinger();
  previewing = false;
  stopAnimation();
  levels.fill(0);
  velocities.fill(0);
  targets.fill(0);
  state = "idle";
  hud.dataset.state = "idle";
  hud.dataset.visible = "true";
  srLabel.textContent = STATE_LABEL.idle;
  syncIdleHover();
}

function setState(next: DictationState): void {
  hud.dataset.expanded = "false";
  const changed = next !== state;
  state = next;
  hud.dataset.state = next;
  hud.dataset.visible = "true";
  srLabel.textContent = STATE_LABEL[next];
  if (next === "rewriting" || next === "error") acceptButton.disabled = true;
  // A preview is a UI affordance, not a real session; the app must not think
  // dictation started.
  if (changed && !previewing) {
    host().reportDictationState({ state: next, sink, mode });
  }
}

function startAnimation(): void {
  if (animationFrame !== null) return;
  const step = (): void => {
    animationFrame = requestAnimationFrame(step);
    advance();
    draw();
  };
  animationFrame = requestAnimationFrame(step);
}

function stopAnimation(): void {
  if (animationFrame === null) return;
  cancelAnimationFrame(animationFrame);
  animationFrame = null;
  draw();
}

function advance(): void {
  phase += 0.11;
  fillTargets();

  for (let index = 0; index < BAR_COUNT; index += 1) {
    const target = targets[index] ?? 0;
    const level = levels[index] ?? 0;
    // Critically damped spring. Fast attack, softer release, the asymmetry a
    // hardware VU meter has -- it is what stops the bars looking digital.
    const stiffness = target > level ? SPRING_ATTACK : SPRING_RELEASE;
    const velocity =
      ((velocities[index] ?? 0) + (target - level) * stiffness) * SPRING_DAMPING;
    velocities[index] = velocity;
    levels[index] = Math.max(0, Math.min(1, level + velocity));
  }
}

/** Fills the per-bar targets for the current state. */
function fillTargets(): void {
  if (previewing) {
    // A speech-like envelope so the preview looks like real use.
    for (let index = 0; index < BAR_COUNT; index += 1) {
      const offset = index * 0.45;
      targets[index] =
        0.3 +
        Math.sin(phase * 1.9 + offset) * 0.24 +
        Math.sin(phase * 4.7 + offset * 1.7) * 0.13;
    }
    return;
  }

  if (state === "transcribing") {
    // Nothing to meter while the model works, so a travelling wave stands in.
    for (let index = 0; index < BAR_COUNT; index += 1) {
      targets[index] = 0.1 + Math.sin(phase * 2.4 - index * 0.42) * 0.09;
    }
    return;
  }

  if (state === "error") {
    targets.fill(0.03);
    return;
  }

  const spectrum = capture.isRunning ? capture.sampleSpectrum() : null;
  if (!spectrum) {
    targets.fill(0);
    return;
  }

  // Speech energy lives low in the spectrum, so only the lower bins are mapped;
  // spreading across all of them would leave most bars permanently flat.
  const usableBins = Math.floor(spectrum.length * SPECTRUM_SPAN);
  const half = Math.ceil(BAR_COUNT / 2);

  for (let index = 0; index < half; index += 1) {
    const from = Math.floor((index / half) * usableBins);
    const to = Math.max(from + 1, Math.floor(((index + 1) / half) * usableBins));

    let peak = 0;
    for (let bin = from; bin < to; bin += 1) peak = Math.max(peak, spectrum[bin] ?? 0);

    // Lift the high bands, which carry far less energy than the low ones.
    const tilt = 1 + (index / half) * 1.5;
    const value = Math.min(1, (peak / 255) * LEVEL_GAIN * 0.24 * tilt);

    // Mirror around the centre so the meter reads as one symmetric shape.
    targets[half - 1 - index] = value;
    if (half + index < BAR_COUNT) targets[half + index] = value;
  }
}

function draw(): void {
  if (!context) return;
  const { width, height } = meterSize();
  context.clearRect(0, 0, width, height);

  const total = BAR_COUNT * BAR_WIDTH + (BAR_COUNT - 1) * BAR_GAP;
  const left = (width - total) / 2;
  const centre = height / 2;

  // While a rewrite runs the meter stops being a meter: the bars flatten and
  // fill from the left, which reads as progress rather than as sound.
  const rewriting = state === "rewriting";
  const filled = rewriting ? Math.floor(((phase * 0.6) % 1) * (BAR_COUNT + 1)) : 0;

  for (let index = 0; index < BAR_COUNT; index += 1) {
    const value = levels[index] ?? 0;
    const barHeight = rewriting ? MIN_BAR : Math.max(MIN_BAR, value * height);
    const x = left + index * (BAR_WIDTH + BAR_GAP);

    context.fillStyle = rewriting
      ? index < filled
        ? `rgb(${ACCENT})`
        : `rgba(${BAR_INK}, 0.28)`
      : `rgba(${BAR_INK}, ${(0.5 + 0.5 * Math.min(1, value * 2.2)).toFixed(3)})`;

    context.beginPath();
    context.roundRect(x, centre - barHeight / 2, BAR_WIDTH, barHeight, BAR_WIDTH / 2);
    context.fill();
  }
}

/**
 * Drag-to-move. The window is deliberately non-focusable so it never steals
 * focus from the app being dictated into, which rules out the usual
 * `-webkit-app-region: drag`; the main process moves the window from deltas
 * measured in screen coordinates instead.
 */
function enableDragging(): void {
  let origin: { x: number; y: number } | null = null;

  hud.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    // The buttons sit inside the drag surface; pressing one must press it
    // rather than start moving the window.
    if ((event.target as HTMLElement).closest("button")) return;
    origin = { x: event.screenX, y: event.screenY };
    hud.dataset.dragging = "true";
    hud.setPointerCapture(event.pointerId);
    host().beginOverlayDrag();
  });

  hud.addEventListener("pointermove", (event) => {
    if (!origin) return;
    host().moveOverlay(event.screenX - origin.x, event.screenY - origin.y);
  });

  const end = (event: PointerEvent): void => {
    if (!origin) return;
    origin = null;
    hud.dataset.dragging = "false";
    hud.releasePointerCapture(event.pointerId);
    host().endOverlayDrag();
  };
  hud.addEventListener("pointerup", end);
  hud.addEventListener("pointercancel", end);
}

/**
 * The meter's layout size, which is not what `getBoundingClientRect` reports:
 * the controls layer scales from 0.5 to 1 as it is revealed, and a rect
 * carries ancestor transforms. Measuring that way sized the backing store
 * against a half-scale canvas and drew the bars at twice the size they should
 * be. `clientWidth` is the untransformed box.
 */
function meterSize(): { width: number; height: number } {
  return { width: canvas.clientWidth, height: canvas.clientHeight };
}

/** Backs the canvas with real device pixels so the bars are not blurry. */
function resizeCanvasForDisplay(): void {
  const ratio = window.devicePixelRatio || 1;
  const { width, height } = meterSize();
  if (width === 0 || height === 0) return;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  context?.setTransform(ratio, 0, 0, ratio, 0, 0);
  draw();
}

function requireElement<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
}
