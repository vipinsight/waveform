import type { DesktopApi } from "../shared/contracts";

/**
 * The window's connection to the Rust host.
 *
 * Kept as a seam rather than reaching for the global directly: the audio
 * pipeline, the interface and the overlay all sit above it and know nothing
 * about how they are hosted, which is what let this app change shells without
 * touching any of them.
 */
declare global {
  interface Window {
    waveform: DesktopApi;
    /** Injected by Tauri when `withGlobalTauri` is enabled. */
    __TAURI__?: unknown;
  }
}

export function host(): DesktopApi {
  if (!window.waveform) {
    throw new Error("The host bridge has not been installed on window.waveform.");
  }
  return window.waveform;
}
