import type {
  AiStatus,
  HotkeyStatus,
  PolishModelStatus,
  SavedDictation,
} from "../shared/contracts";
import type { SpeechModelId } from "../shared/models";
import { DEFAULT_SETTINGS, type AppSettings } from "../shared/settings";
import { host } from "./host";

/**
 * What more than one page reads: the settings, the host's last word on the
 * permissions and the AI side, and whether the chosen models are here yet.
 *
 * Plain fields on one object rather than a store with subscribers. Every
 * change here is followed by an explicit call to the render function that
 * cares, which is how the file worked before it was split and is what makes
 * a repaint traceable from the line that caused it. State that only one page
 * reads stays in that page.
 */
export const state = {
  settings: DEFAULT_SETTINGS as AppSettings,
  hotkeyStatus: null as HotkeyStatus | null,
  /** The last thing the host said about the AI side, so a change in one half of
      it -- a key saved, a model downloaded -- can be redrawn with the other. */
  aiStatus: null as AiStatus | null,
  /** The version the app is running, for the About page and the sidebar. */
  appVersion: "",
  lifetimeSessions: 0,
  /**
   * Whether the catalogue has been read once.
   *
   * Until it has, and until the permissions have come back, nothing is known
   * about whether setup is finished -- and guessing shows the wrong card. An
   * install in daily use would open on the onboarding panel for the length of
   * one round trip and then replace it, which reads as a glitch.
   */
  setupKnown: false,
  modelReady: false,
  modelLoading: false,
  /** Whether the chosen model's weights are here, which is a setup step. */
  modelInstalled: false,
  /** How big the chosen model's download is, for the step that offers it. */
  modelDownloadSize: "",
  /** The same three facts for the polish model, which is a step of its own. */
  polishInstalled: false,
  polishLabel: "",
  polishDownloadSize: "",
  /** The model whose weights are being fetched, so a second press does nothing. */
  downloading: null as SpeechModelId | null,
  /** The same, for the polish models, which are fetched from their own page. */
  polishDownloading: null as string | null,
  /** Latest percent for each download, so the wizard's last page can draw a bar. */
  speechPercent: 0,
  polishPercent: 0,
  /** The polish model's last known state, for the pages that report on it. */
  wizardPolishModel: null as PolishModelStatus | null,
  entries: [] as SavedDictation[],
  /** The dictation that just landed, which the list tints. */
  freshId: null as string | null,
};

/**
 * What runs once the host has confirmed a patch.
 *
 * The entry point registers the real one, which repaints every page from the
 * new settings; until then the value is simply recorded. Registered rather
 * than imported so the pages that call `patchSettings` do not have to import
 * the module that imports them.
 */
let applySettings: (next: AppSettings) => void = (next) => {
  state.settings = next;
};

export function onSettingsApplied(apply: (next: AppSettings) => void): void {
  applySettings = apply;
}

export async function patchSettings(patch: Partial<AppSettings>): Promise<void> {
  applySettings(await host().updateSettings(patch));
}
