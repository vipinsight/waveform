import { requireElement } from "./dom";

export interface ToastOptions {
  tone?: "error";
  action?: { label: string; run(): void };
}

let toastTimer: number | null = null;

/**
 * One brief message at the bottom of the window, whatever page is up.
 *
 * Errors used to land in a corner of the Overview page, which is only seen
 * if the user happens to be there. This is seen from anywhere.
 */
export function showToast(message: string, options: ToastOptions = {}): void {
  const toast = requireElement<HTMLElement>("toast");
  const text = requireElement<HTMLElement>("toast-text");
  const action = requireElement<HTMLButtonElement>("toast-action");
  text.textContent = message;
  toast.classList.toggle("is-error", options.tone === "error");
  action.hidden = !options.action;
  if (options.action) {
    action.textContent = options.action.label;
    action.onclick = () => {
      options.action?.run();
      toast.hidden = true;
    };
  }
  toast.hidden = false;
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.hidden = true;
  }, options.tone === "error" ? 8_000 : 4_000);
}
