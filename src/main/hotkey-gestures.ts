/**
 * Turns raw down/up events for a single modifier key into dictation commands.
 *
 * Three gestures share one key:
 *   hold        press, speak, release              → transcribe what was said
 *   double tap  tap, tap                           → stay listening until pressed again
 *   lone tap    a single tap that goes nowhere     → discard; nothing useful was said
 *
 * A lone tap still opens the microphone, because at the moment of the first tap
 * we cannot know whether a second one is coming, and the alternative is losing
 * the first syllable of every latched session.
 */
export type GestureCommand =
  | { type: "start"; mode: "hold" }
  | { type: "latch" }
  | { type: "commit" }
  | { type: "discard" };

type State =
  | "idle"
  | "holding"
  | "tap-wait"
  | "latch-arming"
  | "latched"
  | "latch-releasing";

export interface GestureOptions {
  holdMs?: number;
  doubleTapMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class HotkeyGestureMachine {
  private readonly holdMs: number;
  private readonly doubleTapMs: number;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  private state: State = "idle";
  private pressedAt = 0;
  private tapTimer: unknown = null;

  constructor(
    private readonly emit: (command: GestureCommand) => void,
    options: GestureOptions = {},
  ) {
    this.holdMs = options.holdMs ?? 300;
    this.doubleTapMs = options.doubleTapMs ?? 420;
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer =
      options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  get isActive(): boolean {
    return this.state !== "idle";
  }

  get isLatched(): boolean {
    return this.state === "latched";
  }

  keyDown(): void {
    switch (this.state) {
      case "idle":
        this.pressedAt = this.now();
        this.state = "holding";
        this.emit({ type: "start", mode: "hold" });
        return;
      case "tap-wait":
        this.cancelTapTimer();
        this.state = "latch-arming";
        return;
      case "latched":
        this.state = "latch-releasing";
        this.emit({ type: "commit" });
        return;
      default:
        // A repeat down while already held: the OS can emit these, ignore them.
        return;
    }
  }

  keyUp(): void {
    switch (this.state) {
      case "holding": {
        if (this.now() - this.pressedAt >= this.holdMs) {
          this.state = "idle";
          this.emit({ type: "commit" });
          return;
        }
        this.state = "tap-wait";
        this.tapTimer = this.setTimer(() => this.expireTapWindow(), this.doubleTapMs);
        return;
      }
      case "latch-arming":
        this.state = "latched";
        this.emit({ type: "latch" });
        return;
      case "latch-releasing":
        this.state = "idle";
        return;
      default:
        return;
    }
  }

  /** Ends an in-flight session from outside the keyboard, e.g. a click on the HUD. */
  stop(): void {
    if (this.state === "idle") return;
    this.cancelTapTimer();
    this.state = "idle";
    this.emit({ type: "commit" });
  }

  /** Abandons an in-flight session and throws away the audio, e.g. Escape. */
  cancel(): void {
    if (this.state === "idle") return;
    this.cancelTapTimer();
    this.state = "idle";
    this.emit({ type: "discard" });
  }

  /** Clears all state without emitting, for when the binding itself changes. */
  reset(): void {
    this.cancelTapTimer();
    this.state = "idle";
  }

  private expireTapWindow(): void {
    this.tapTimer = null;
    if (this.state !== "tap-wait") return;
    this.state = "idle";
    this.emit({ type: "discard" });
  }

  private cancelTapTimer(): void {
    if (this.tapTimer === null) return;
    this.clearTimer(this.tapTimer);
    this.tapTimer = null;
  }
}
