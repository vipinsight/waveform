import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync("src/renderer/index.html", "utf8");
const overlayHtml = readFileSync("src/renderer/overlay.html", "utf8");
const css = readFileSync("src/renderer/styles.css", "utf8");
const overlayCss = readFileSync("src/renderer/overlay.css", "utf8");

function classesIn(markup: string): string[] {
  const found = new Set<string>();
  for (const match of markup.matchAll(/class="([^"]+)"/g)) {
    for (const name of match[1]!.split(/\s+/)) if (name) found.add(name);
  }
  return [...found].sort();
}

function idsIn(markup: string): string[] {
  return [...markup.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]!).sort();
}

/**
 * These guard a real regression: a stylesheet edit spliced between two section
 * markers silently removed every rule for the setup checklist and the banner.
 * The markup still referenced them, so the page rendered unstyled rather than
 * failing, and nothing caught it until it was looked at.
 */
describe("stylesheet covers the markup", () => {
  it("styles every class the window uses", () => {
    const unstyled = classesIn(html).filter((name) => !css.includes(`.${name}`));
    expect(unstyled).toEqual([]);
  });

  it("styles every class the overlay uses", () => {
    const unstyled = classesIn(overlayHtml).filter(
      (name) => !overlayCss.includes(`.${name}`),
    );
    expect(unstyled).toEqual([]);
  });

  /*
   * Cancel and accept were once hidden with `display: none` in the idle state
   * and restored one selector at a time; accept was missed, so a session came
   * back with no way to finish it. The controls now share one layer that is
   * revealed for every non-idle state at once.
   */
  it("reveals the session controls for every state but idle", () => {
    expect(overlayCss).toContain(
      '.hud[data-state]:not([data-state="idle"]) .hud-session',
    );
    expect(overlayCss).not.toMatch(/\.hud\[data-state="idle"\][^{]*\{[^}]*display:\s*none/);
  });
});

describe("markup provides what the renderer requires", () => {
  it("defines every element looked up by id", () => {
    const renderer = readFileSync("src/renderer/renderer.ts", "utf8");
    const required = [...renderer.matchAll(/requireElement<[^>]+>\("([^"]+)"\)/g)].map(
      (match) => match[1]!,
    );
    expect(required.length).toBeGreaterThan(20);

    const present = new Set(idsIn(html));
    expect(required.filter((id) => !present.has(id))).toEqual([]);
  });

  it("defines every element the overlay looks up", () => {
    const overlay = readFileSync("src/renderer/overlay.ts", "utf8");
    const required = [...overlay.matchAll(/requireElement<[^>]+>\("([^"]+)"\)/g)].map(
      (match) => match[1]!,
    );
    const present = new Set(idsIn(overlayHtml));
    expect(required.filter((id) => !present.has(id))).toEqual([]);
  });
});
