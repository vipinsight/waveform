/**
 * Right-click in every window.
 *
 * Left alone, the webview offers its own menu everywhere (Reload, Back,
 * Inspect Element), which makes the app read as a web page. That menu is
 * switched off, and the system's menu is given back only where it has
 * something to offer: in a text field, where it brings Cut, Copy, Paste and
 * Spelling, and over selected text, where it brings Copy. Rows that have
 * actions of their own open those instead, with `onRowContextMenu`.
 */

/** Input types the system menu edits text in. Checkboxes, ranges and buttons get nothing. */
const TEXT_INPUT_TYPES = new Set(["", "text", "search", "email", "url", "tel", "password", "number"]);

/** The part of an element this needs, so the rule can be tested without a DOM. */
export interface MenuTarget {
  closest(selector: string): { tagName: string; getAttribute(name: string): string | null } | null;
}

/** Whether a right-click on `target` should get the system's own menu. */
export function wantsNativeMenu(target: MenuTarget | null, selectedText: string): boolean {
  return selectedText.trim() !== "" || inTextField(target);
}

/** Whether `target` is in a field that edits text. */
export function inTextField(target: MenuTarget | null): boolean {
  const field = target?.closest("input, textarea, [contenteditable]:not([contenteditable='false'])");
  if (!field) return false;
  if (field.tagName !== "INPUT") return true;
  return TEXT_INPUT_TYPES.has((field.getAttribute("type") ?? "").toLowerCase());
}

function targetOf(event: MouseEvent): Element | null {
  return event.target instanceof Element ? event.target : null;
}

/** Switches the webview's own menu off for this window. Call once per window. */
export function installContextMenu(): void {
  document.addEventListener("contextmenu", (event) => {
    if (!wantsNativeMenu(targetOf(event), window.getSelection()?.toString() ?? "")) event.preventDefault();
  });
}

/**
 * Opens a row's own menu on right-click. Only a text field inside the row
 * keeps the system's menu: right-click selects the word under the pointer,
 * and that word is not what the row's menu acts on, so it is let go.
 */
export function onRowContextMenu(row: HTMLElement, open: (event: MouseEvent) => void): void {
  row.addEventListener("contextmenu", (event) => {
    if (inTextField(targetOf(event))) return;
    event.preventDefault();
    window.getSelection()?.removeAllRanges();
    open(event);
  });
}
