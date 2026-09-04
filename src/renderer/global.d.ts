import { DesktopApi } from "../shared/contracts";

declare global {
  interface Window {
    waveform: DesktopApi;
  }
}

export {};

