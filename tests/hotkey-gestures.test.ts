import { describe, expect, it } from "vitest";
import {
  HotkeyGestureMachine,
  type GestureCommand,
} from "../src/main/hotkey-gestures";

/** Drives the machine on a fake clock so tap timing is exact, not racy. */
function createHarness(holdMs = 300, doubleTapMs = 420) {
  const commands: GestureCommand[] = [];
  let clock = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  let nextTimer = 1;

  const machine = new HotkeyGestureMachine((command) => commands.push(command), {
    holdMs,
    doubleTapMs,
    now: () => clock,
    setTimer: (callback, ms) => {
      const handle = nextTimer++;
      timers.set(handle, { at: clock + ms, callback });
      return handle;
    },
    clearTimer: (handle) => {
      timers.delete(handle as number);
    },
  });

  function advance(ms: number): void {
    clock += ms;
    for (const [handle, timer] of [...timers]) {
      if (timer.at > clock) continue;
      timers.delete(handle);
      timer.callback();
    }
  }

  return { machine, commands, advance, types: () => commands.map((c) => c.type) };
}

describe("HotkeyGestureMachine", () => {
  it("treats press-and-hold as push-to-talk", () => {
    const { machine, advance, types } = createHarness();

    machine.keyDown();
    advance(1200);
    machine.keyUp();

    expect(types()).toEqual(["start", "commit"]);
    expect(machine.isActive).toBe(false);
  });

  it("opens the microphone on the very first press, before the gesture is known", () => {
    const { machine, commands } = createHarness();

    machine.keyDown();

    expect(commands).toEqual([{ type: "start", mode: "hold" }]);
  });

  it("latches on a double tap and stays listening", () => {
    const { machine, advance, types } = createHarness();

    machine.keyDown();
    advance(80);
    machine.keyUp();
    advance(120);
    machine.keyDown();
    advance(60);
    machine.keyUp();

    expect(types()).toEqual(["start", "latch"]);
    expect(machine.isLatched).toBe(true);

    // Nothing should end the session on its own once latched.
    advance(10_000);
    expect(types()).toEqual(["start", "latch"]);
  });

  it("ends a latched session on the next press, not the next release", () => {
    const { machine, advance, types } = createHarness();

    machine.keyDown();
    advance(80);
    machine.keyUp();
    advance(120);
    machine.keyDown();
    advance(60);
    machine.keyUp();
    advance(5_000);

    machine.keyDown();
    expect(types()).toEqual(["start", "latch", "commit"]);

    machine.keyUp();
    expect(types()).toEqual(["start", "latch", "commit"]);
    expect(machine.isActive).toBe(false);
  });

  it("discards a lone tap once the double-tap window closes", () => {
    const { machine, advance, types } = createHarness();

    machine.keyDown();
    advance(80);
    machine.keyUp();
    expect(types()).toEqual(["start"]);

    advance(500);
    expect(types()).toEqual(["start", "discard"]);
    expect(machine.isActive).toBe(false);
  });

  it("counts a release exactly at the hold threshold as a hold", () => {
    const { machine, advance, types } = createHarness(300);

    machine.keyDown();
    advance(300);
    machine.keyUp();

    expect(types()).toEqual(["start", "commit"]);
  });

  it("does not restart on auto-repeated key-down events", () => {
    const { machine, advance, types } = createHarness();

    machine.keyDown();
    machine.keyDown();
    machine.keyDown();
    advance(700);
    machine.keyUp();

    expect(types()).toEqual(["start", "commit"]);
  });

  it("ignores a release that arrives with no matching press", () => {
    const { machine, types } = createHarness();

    machine.keyUp();

    expect(types()).toEqual([]);
  });

  it("commits when stopped from outside the keyboard", () => {
    const { machine, advance, types } = createHarness();

    machine.keyDown();
    advance(50);
    machine.keyUp();
    machine.stop();

    expect(types()).toEqual(["start", "commit"]);

    // The pending tap timer must not fire a stray discard afterwards.
    advance(1_000);
    expect(types()).toEqual(["start", "commit"]);
  });

  it("throws the audio away when cancelled", () => {
    const { machine, advance, types } = createHarness();

    machine.keyDown();
    advance(900);
    machine.cancel();

    expect(types()).toEqual(["start", "discard"]);
  });

  it("stays quiet when stopped or cancelled while idle", () => {
    const { machine, types } = createHarness();

    machine.stop();
    machine.cancel();

    expect(types()).toEqual([]);
  });

  it("drops pending state when the binding is reset", () => {
    const { machine, advance, types } = createHarness();

    machine.keyDown();
    advance(50);
    machine.keyUp();
    machine.reset();
    advance(1_000);

    expect(types()).toEqual(["start"]);
    expect(machine.isActive).toBe(false);
  });
});
