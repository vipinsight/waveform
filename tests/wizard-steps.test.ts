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

  it("asks for the polish model only when something here will run it", () => {
    // At None nothing rewrites, and through OpenRouter the rewriting happens
    // somewhere else -- a missing local model stops neither, so a checklist
    // row for it would be a chore invented out of nothing.
    expect(renderer).toMatch(
      /settings\.polishLevel !== "none" && settings\.polishEngine === "local"/,
    );
  });
});
