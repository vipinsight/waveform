import { describe, expect, it } from "vitest";
import { wantsNativeMenu, type MenuTarget } from "../src/renderer/context-menu";

/** A clicked element whose nearest text field is `field`, or that is in none. */
function inside(field: { tag: string; type?: string } | null): MenuTarget {
  return {
    closest: () =>
      field && {
        tagName: field.tag.toUpperCase(),
        getAttribute: (name: string) => (name === "type" ? (field.type ?? null) : null),
      },
  };
}

describe("right-click menu", () => {
  it("keeps the webview's menu off where there is nothing to edit or copy", () => {
    expect(wantsNativeMenu(inside(null), "")).toBe(false);
    expect(wantsNativeMenu(null, "")).toBe(false);
    expect(wantsNativeMenu(inside(null), "  \n")).toBe(false);
  });

  it("gives text fields the system menu for cut, copy and paste", () => {
    expect(wantsNativeMenu(inside({ tag: "input" }), "")).toBe(true);
    expect(wantsNativeMenu(inside({ tag: "input", type: "text" }), "")).toBe(true);
    expect(wantsNativeMenu(inside({ tag: "input", type: "Search" }), "")).toBe(true);
    expect(wantsNativeMenu(inside({ tag: "textarea" }), "")).toBe(true);
    expect(wantsNativeMenu(inside({ tag: "div" }), "")).toBe(true);
  });

  it("gives switches, sliders and buttons nothing", () => {
    for (const type of ["checkbox", "range", "radio", "button", "file"]) {
      expect(wantsNativeMenu(inside({ tag: "input", type }), "")).toBe(false);
    }
  });

  it("gives selected text the system menu, so it can be copied", () => {
    expect(wantsNativeMenu(inside(null), "said in the meeting")).toBe(true);
  });
});
