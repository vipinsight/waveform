/**
 * Right-click in every window.
 *
 * Left alone, the webview offers its own menu everywhere (Reload, Back,
 * Inspect Element), which makes the app read as a web page. That menu is
 * switched off, and the system's menu is given back only where it has
 * something to offer: in a text field, where it brings Cut, Copy, Paste and
 * Spelling, and over selected text, where it brings Copy. Rows that have
 * actions of their own open those with `onRowContextMenu`.
 */

/** Input types the system menu edits text in. Checkboxes, ranges and buttons get nothing. */
const TEXT_INPUT_TYPES = new Set(["", "text", "search", "email", "url", "tel", "password", "number"]);

/** The part of an element this needs, so the rule can be tested without a DOM. */
export interface MenuTarget {
  closest(selector: string): { tagName: string; getAttribute(name: string): string | null } | null;
}

/** Whether a right-click on `target` should get the system's own menu. */
export function wantsNativeMenu(target: MenuTarget | null, selectedText: string): boolean {
  if (selectedText.trim() !== "") return true;
  const field = target?.closest("input, textarea, [contenteditable]:not([contenteditable='false'])");
  if (!field) return false;
  if (field.tagName !== "INPUT") return true;
  return TEXT_INPUT_TYPES.has((field.getAttribute("type") ?? "").toLowerCase());
}

function nativeMenuFor(event: MouseEvent): boolean {
  const target = event.target instanceof Element ? event.target : null;
  return wantsNativeMenu(target, window.getSelection()?.toString() ?? "");
}

/** Switches the webview's own menu off for this window. Call once per window. */
export function installContextMenu(): void {
  document.addEventListener("contextmenu", (event) => {
    if (!nativeMenuFor(event)) event.preventDefault();
  });
}

/**
 * Opens a row's own menu on right-click, unless the click belongs to a text
 * field or selected text, which keep the system's menu.
 */
export function onRowContextMenu(row: HTMLElement, open: (event: MouseEvent) => void): void {
  row.addEventListener("contextmenu", (event) => {
    if (nativeMenuFor(event)) return;
    event.preventDefault();
    open(event);
  });
}
