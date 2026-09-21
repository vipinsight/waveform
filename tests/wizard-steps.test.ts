import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The wizard's permissions page is built from the same list as the setup
 * checklist, narrowed to the three macOS switches. It used to narrow by
 * exception -- everything except the speech model -- which meant the next
 * step added to that list joined the permissions page uninvited, and joined
 * the gate that will not let anyone past until every row on it is done. The
 * polish model did exactly that: a 397 MB download standing between a first
 * run and the rest of the wizard.
 *
 * Read from the source because the renderer needs a window to run in.
 */
const renderer = readFileSync("src/renderer/renderer.ts", "utf8");

describe("the wizard's permissions page", () => {
  it("names the permissions it shows rather than excluding what it does not", () => {
    const list = renderer.match(/const WIZARD_PERMISSIONS = \[([^\]]*)\]/);
    expect(list).not.toBeNull();
    const ids = [...list![1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual(["microphone", "accessibility", "input-monitoring"]);

    // A filter that says which ids are *not* permissions is the shape of the
    // bug: it silently adopts whatever is added to setupSteps() later.
    expect(renderer).not.toMatch(/permissionSteps[\s\S]{0,200}step\.id !== /);
  });

  it("offers every permission it gates on as a step you can actually resolve", () => {
    // A gate on a row with no way to satisfy it is a dead end, and there is
    // no skip past this page.
    const steps = renderer.slice(renderer.indexOf("function setupSteps("));
    for (const id of ["microphone", "accessibility", "input-monitoring"]) {
      expect(steps).toContain(`id: "${id}"`);
      expect(renderer).toContain(`"${id}"`);
    }
  });

  it("waits on a refusal, never on silence", () => {
    // The three booleans start false and are filled in by the helper, so
    // "denied" and "nobody has said yet" look identical. Gating on the
    // second holds somebody on a page with no way past it and every switch
    // already flipped -- which happened, when a dev build's grants were
    // attributed elsewhere and the helper reported false for real ones.
    expect(renderer).toContain("function permissionsAreKnown()");
    const gate = renderer.slice(
      renderer.indexOf("function wizardCanAdvance("),
      renderer.indexOf("function wizardCanAdvance(") + 500,
    );
    expect(gate).toMatch(/if \(!permissionsAreKnown\(\)\) return true;/);

    // Known means: a helper that is running, and a microphone status that is
    // an answer rather than a shrug.
    const known = renderer.slice(
      renderer.indexOf("function permissionsAreKnown()"),
      renderer.indexOf("function permissionsAreKnown()") + 400,
    );
    expect(known).toContain("hotkeyStatus.running");
    expect(known).toContain('hotkeyStatus.microphone !== "unknown"');
  });

  it("asks for the polish model only when something here will run it", () => {
    // At None nothing rewrites, and through OpenRouter the rewriting happens
    // somewhere else -- a missing local model stops neither, so a checklist
    // row for it would be a chore invented out of nothing.
    expect(renderer).toMatch(
      /settings\.polishLevel !== "none" && settings\.polishEngine === "local"/,
    );
  });
});
