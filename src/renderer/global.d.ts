import { DesktopApi } from "../shared/contracts";

declare global {
  interface Window {
    parakeetFlow: DesktopApi;
  }
}

export {};

