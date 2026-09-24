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

  /*
   * The check above reads the markup, and the models page is no longer in it:
   * its rows, group headings and detail lines are built in the renderer, so a
   * stylesheet edit could remove every rule for them and the markup scan would
   * still pass. This reads the classes the renderer assigns instead.
   */
  it("styles every class the renderer assigns at runtime", () => {
    const renderer = readFileSync("src/renderer/renderer.ts", "utf8");
    const assigned = [...renderer.matchAll(/className = "([^"]+)"/g)].flatMap((match) =>
      match[1]!.split(/\s+/),
    );
    expect(assigned.length).toBeGreaterThan(10);
    expect(assigned.filter((name) => !css.includes(`.${name}`))).toEqual([]);
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
  it("reveals the session controls for every listening state", () => {
    expect(overlayCss).toContain(
      '.hud[data-state]:not([data-state="idle"]):not([data-busy="true"]) .hud-session',
    );
    expect(overlayCss).not.toMatch(/\.hud\[data-state="idle"\][^{]*\{[^}]*display:\s*none/);
  });

  it("shows Retry controls on a hold-mode failed transcription", () => {
    expect(overlayCss).toContain(
      '.hud[data-state="error"][data-retry="true"] .hud-accept',
    );
  });

  /*
   * Status used to sit beside Check for Updates. Long copy wrapped the
   * copyright onto a new line, so it jumped left. The button now carries every
   * stage itself, and the footer is forbidden from wrapping.
   */
  it("keeps the About copyright from shifting when an update check runs", () => {
    const foot = css.match(/\.about-foot\s*\{[^}]+\}/)?.[0];
    const updates = css.match(/\.about-updates\s*\{[^}]+\}/)?.[0];
    expect(foot).toContain("flex-wrap: nowrap");
    expect(updates).toContain("min-width: 0");
    expect(css).toMatch(
      /\.about-legal \{\n  display: flex;\n  flex: none;[\s\S]*?white-space: nowrap;/,
    );
    expect(html).toMatch(/id="update-check"[^>]*aria-live="polite"/);
    expect(html).not.toContain('id="update-state"');
    expect(html).not.toContain('id="update-install"');
  });

  /*
   * The wait circle inherited the pill's top-edge inset highlight, which on a
   * 28px disc reads as a rim that only exists at the top — especially on the
   * blue polish fill.
   */
  it("does not put a top-only highlight on the wait circle", () => {
    const rewriting = overlayCss.match(
      /\.hud\[data-busy="true"\]\[data-state="rewriting"\]\s*\{[^}]+\}/,
    )?.[0];
    const transcribing = overlayCss.match(
      /\.hud\[data-busy="true"\]\[data-state="transcribing"\]\s*\{[^}]+\}/,
    )?.[0];
    expect(rewriting).toBeDefined();
    expect(transcribing).toBeDefined();
    expect(rewriting).not.toMatch(/inset\s+0\s+1px\s+0/);
    expect(transcribing).not.toMatch(/inset\s+0\s+1px\s+0/);
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

  /*
   * Polish completion reuses action "stop". Falling through to the dictation
   * release tail called capture.stop() with no session and froze the HUD.
   */
  it("finishes polish-only stop without the microphone release tail", () => {
    const overlay = readFileSync("src/renderer/overlay.ts", "utf8");
    expect(overlay).toContain('command.action === "stop" && !capture.isRunning');
  });
});

/*
 * The prompts exist twice: as text files the host embeds, and as constants the
 * interface shows in Settings. Nothing makes them agree, so a change to one and
 * not the other would ship a default the app does not actually use.
 */
describe("prompt defaults match the files the host embeds", () => {
  const cases = [
    ["transform.txt", "DEFAULT_TRANSFORM_PROMPT"],
    ["polish.txt", "DEFAULT_POLISH_PROMPT"],
    ["transform-retired.txt", "RETIRED_TRANSFORM_PROMPTS"],
    ["transform-retired-grammar.txt", "RETIRED_TRANSFORM_PROMPTS"],
    ["polish-retired.txt", "RETIRED_POLISH_PROMPTS"],
  ] as const;

  it.each(cases)("keeps %s in step with %s", (file, constant) => {
    const embedded = readFileSync(`src-tauri/src/prompts/${file}`, "utf8").trim();
    const shared = readFileSync("src/shared/prompts.ts", "utf8");
    expect(shared).toContain(constant);
    expect(shared).toContain(embedded);
  });
});
