import type { AppSettings } from "../shared/settings";
import { bindDropTranscribe } from "./drop-transcribe";
import { host } from "./host";
import { openView, showView } from "./navigation";
import { bindDictation, renderDictationDeck, renderDictationSettings, renderHotkeyLabels } from "./pages/dictation";
import { bindDictionary, renderDictionarySettings } from "./pages/dictionary";
import { bindHistory, renderHistory } from "./pages/history";
import { bindLogs } from "./pages/logs";
import { bindMeetings } from "./pages/meetings";
import {
  bindModels,
  handleModelEvent,
  renderLanguageSelect,
  renderModels,
  showModelsTab,
} from "./pages/models";
import { renderOverviewModel, renderResourceUsage, renderStats } from "./pages/overview";
import {
  bindPolish,
  isPromptEditorOpen,
  populatePolishControls,
  renderAiStatus,
  renderPolishSettings,
  togglePromptEditor,
} from "./pages/polish";
import {
  bindSettingsPanel,
  isSettingsOpen,
  refreshMicrophones,
  renderAboutVersion,
  renderSettingsPanel,
  renderThemeToggle,
  toggleSettings,
} from "./pages/settings-panel";
import { bindSetup, refreshModelInstalled, renderHotkeyStatus } from "./pages/setup";
import { announceUpdateIfNew, bindUpdates, renderUpdateToggle } from "./pages/updates";
import { bindWizard, maybeOpenWizard, renderWizard, renderWizardBrand } from "./pages/wizard";
import { bindRecordingStrip } from "./recording-strip";
import { onSettingsApplied, patchSettings, state } from "./state";
import { installTauriBridge } from "./tauri-bridge";
import { bindGroup, requireElement } from "./ui/dom";
import { showToast } from "./ui/toast";

/**
 * The main window's entry point.
 *
 * Each page lives in `pages/` and owns its own elements, state and events;
 * this file installs the host bridge, loads what every page needs at start,
 * subscribes to the host's events, and fans a settings change out to the
 * pages that draw from it. The shell -- sidebar, brand, version line -- is
 * the one piece of the window with no page of its own, so it is here.
 */

const element = {
  app: requireElement<HTMLElement>("app-shell"),
  sidebarToggle: requireElement<HTMLButtonElement>("sidebar-toggle"),
  appBrand: requireElement<HTMLElement>("app-brand"),
  versionLine: requireElement<HTMLElement>("version-line"),
};

// Supplies window.waveform under Tauri; a no-op under Electron.
installTauriBridge();

void bootstrap();

async function bootstrap(): Promise<void> {
  onSettingsApplied(applySettings);
  populatePolishControls();
  wireEvents();

  applySettings(await host().getSettings());
  void refreshMicrophones();
  renderStats(await host().getStats());
  state.entries = await host().getHistory();
  renderHistory();
  // Falls back to the bare name: a version that failed to load should not be
  // rendered as "Waveform null".
  state.appVersion = await host().getAppVersion().catch(() => "");
  const appName = await host().getAppName().catch(() => "Waveform");
  const versionLine = state.appVersion ? `${appName} ${state.appVersion}` : appName;
  document.title = appName;
  element.appBrand.textContent = appName;
  renderWizardBrand(appName);
  element.versionLine.textContent = versionLine;
  renderAboutVersion(versionLine);
  announceUpdateIfNew();
  // Pull the engine's current stage: any event it pushed while this window was
  // still loading is already gone.
  handleModelEvent(await host().getModelState());

  state.hotkeyStatus = await host().getHotkeyStatus();
  renderHotkeyStatus();
  renderAiStatus(await host().getAiStatus());
  await refreshModelInstalled();
  // Last, because it reads the settings, the lifetime count, the permissions
  // and the catalogue -- and opening on a guess at any of them would show the
  // wrong page and then correct itself, which reads as a glitch.
  maybeOpenWizard();
}

function wireEvents(): void {
  bindWizard();
  bindModels();
  bindUpdates();
  bindLogs();
  host().onSettingsChanged(applySettings);
  host().onHotkeyStatusChanged((next) => {
    state.hotkeyStatus = next;
    renderHotkeyStatus();
  });
  bindHistory();
  host().onResourceUsage(renderResourceUsage);
  host().onOpenSettings(() => toggleSettings(true));
  host().onOpenMicrophoneSettings(() => toggleSettings(true, "audio"));
  host().onOpenModelSettings(() => {
    toggleSettings(false);
    showModelsTab("speech");
  });
  host().onOpenShortcutSettings(() => openView("dictation"));
  host().onStatsChanged(renderStats);
  bindDictionary();

  bindGroup(".nav[aria-label='Sections'] [data-view]", (button) =>
    showView(button.dataset.view ?? "dictate"),
  );
  bindSettingsPanel();
  element.sidebarToggle.addEventListener("click", () => {
    // Written straight to the grid as well as saved, so the rail folds now
    // rather than after the host has been round-tripped.
    const collapsed = !state.settings.sidebarCollapsed;
    state.settings = { ...state.settings, sidebarCollapsed: collapsed };
    renderSidebarCollapsed();
    void patchSettings({ sidebarCollapsed: collapsed });
  });
  bindDictation();
  bindDropTranscribe();

  // Tabs on the Models page, and the links elsewhere that open one of them.
  // Delegated: the AI Polish hint rebuilds its link whenever the status does.
  document.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const tab = target.closest<HTMLElement>("[data-model-tab], [data-open-models]");
    const kind = tab?.dataset.modelTab ?? tab?.dataset.openModels;
    if (kind === "speech" || kind === "polish") {
      showModelsTab(kind);
      return;
    }
    const view = target.closest<HTMLElement>("[data-open-view]")?.dataset.openView;
    if (view) {
      if (isSettingsOpen()) toggleSettings(false);
      showView(view);
    }
  });

  bindSetup();
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (isPromptEditorOpen()) togglePromptEditor(false);
    else if (isSettingsOpen()) toggleSettings(false);
  });

  bindPolish();
  bindMeetings({
    openView,
    toast: showToast,
    introSeen: () => state.settings.meetingsIntroSeen,
    markIntroSeen: () => void patchSettings({ meetingsIntroSeen: true }),
  });
  bindRecordingStrip();
}

/**
 * Every page that draws from the settings, repainted from the new value.
 *
 * Called with what the host returned from a patch and with what it pushes
 * on `settings-changed`, so a change made in the menu bar lands here too.
 */
function applySettings(next: AppSettings): void {
  state.settings = next;
  if (next.theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = next.theme;

  void renderModels();
  renderLanguageSelect();
  renderSettingsPanel(next);
  renderDictationSettings(next);
  renderDictionarySettings(next);
  renderUpdateToggle(next.automaticUpdateCheck);
  renderSidebarCollapsed();
  renderPolishSettings(next);
  renderThemeToggle(next.theme);
  renderOverviewModel();

  renderHotkeyLabels();
  renderHotkeyStatus();
  renderDictationDeck();
  // Every control in the wizard writes through the host and reads back from
  // here, so this is what actually ticks the card that was clicked.
  renderWizard();
  // Choosing a different model can un-finish setup: the new one's weights are
  // very likely not here.
  void refreshModelInstalled();
}

/**
 * Folds the sidebar away, and tells the button what it will do next.
 *
 * The label is the state it moves to rather than the state it is in: a control
 * that reads "sidebar hidden" while the sidebar is showing is a description,
 * and this is a button.
 */
function renderSidebarCollapsed(): void {
  const collapsed = state.settings.sidebarCollapsed;
  element.app.dataset.sidebar = collapsed ? "collapsed" : "expanded";
  element.sidebarToggle.setAttribute("aria-expanded", String(!collapsed));
  element.sidebarToggle.setAttribute(
    "aria-label",
    collapsed ? "Show sidebar" : "Hide sidebar",
  );

  // Collapsed, the icon is all there is to go on, so each one names itself on
  // hover. Expanded, the label is already beside it and a tooltip repeating it
  // is just something else to wait for.
  for (const item of Array.from(
    document.querySelectorAll<HTMLElement>(".sidebar .nav-item"),
  )) {
    const label = item.querySelector("span")?.textContent?.trim();
    if (collapsed && label) item.title = label;
    else item.removeAttribute("title");
  }
}
