import type { DesktopApi } from "../shared/contracts";

/**
 * The window's connection to its host process.
 *
 * Everything above this line -- the UI, the audio pipeline, the overlay -- is
 * host-agnostic. Electron supplies `window.waveform` from a preload script;
 * Tauri supplies the same shape from `tauri-bridge`. Keeping the surface
 * identical is what lets one frontend serve both.
 */
declare global {
  interface Window {
    waveform: DesktopApi;
    /** Present only under Tauri, and only with withGlobalTauri enabled. */
    __TAURI__?: unknown;
  }
}

export function isTauriHost(): boolean {
  return typeof window.__TAURI__ !== "undefined";
}

/**
 * Resolves the host bridge.
 *
 * Under Electron the preload script has already installed it before any
 * renderer script runs. Under Tauri the bridge installs itself on import.
 */
export function host(): DesktopApi {
  if (!window.waveform) {
    throw new Error("No host bridge is available on window.waveform.");
  }
  return window.waveform;
}
