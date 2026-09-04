import {
  app,
  BrowserWindow,
  ipcMain,
  nativeImage,
  nativeTheme,
  session,
  systemPreferences,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type WebContents,
} from "electron";
import { join } from "node:path";
import { DictationController } from "./dictation-controller";
import { requestMicrophonePermission } from "./microphone-permission";
import { ModelServer } from "./model-server";
import { ResourceMonitor } from "./resource-monitor";
import { SettingsStore } from "./settings-store";
import { StatsStore } from "./stats-store";
import type { DictationPhrase, DictationStatus, PrivacyPane } from "../shared/contracts";
import { IPC_CHANNELS } from "../shared/ipc";
import { isSpeechModelId } from "../shared/models";

const APP_ICON_PATH = join(__dirname, "../renderer/waveform-icon.png");

let window: BrowserWindow | null = null;
let settings: SettingsStore;
let dictation: DictationController;
let resources: ResourceMonitor;
let stats: StatsStore;

const modelServer = new ModelServer((event) => {
  window?.webContents.send(IPC_CHANNELS.modelEvent, event);
});

function mainWindowContents(): WebContents | null {
  return window && !window.isDestroyed() ? window.webContents : null;
}

function createWindow(): void {
  window = new BrowserWindow({
    width: 940,
    height: 720,
    minWidth: 720,
    minHeight: 560,
    title: "Waveform",
    icon: APP_ICON_PATH,
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0d1017" : "#f4f6fa",
    vibrancy: "under-window",
    visualEffectState: "active",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 20 },
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  void window.loadFile(join(__dirname, "../renderer/index.html"));
  window.on("closed", () => {
    window = null;
  });
}

/** Only our own windows may drive the model or the microphone. */
function isTrustedSender(sender: WebContents): boolean {
  return sender === mainWindowContents() || sender === dictation?.overlayContents;
}

function assertTrustedSender(event: IpcMainInvokeEvent | IpcMainEvent): void {
  if (!isTrustedSender(event.sender)) throw new Error("Untrusted IPC sender.");
}

app.setName("Waveform");

app.whenReady().then(async () => {
  settings = new SettingsStore(app.getPath("userData"));
  stats = new StatsStore(app.getPath("userData"));
  nativeTheme.themeSource = settings.value.theme;

  const appIcon = nativeImage.createFromPath(APP_ICON_PATH);
  if (process.platform === "darwin" && !appIcon.isEmpty()) {
    app.dock?.setIcon(appIcon);
  }

  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    return webContents !== null && isTrustedSender(webContents) && permission === "media";
  });
  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      const mediaTypes = "mediaTypes" in details ? details.mediaTypes : [];
      callback(
        isTrustedSender(webContents) &&
          permission === "media" &&
          mediaTypes?.includes("audio") === true &&
          mediaTypes.includes("video") === false,
      );
    },
  );

  registerIpcHandlers();
  dictation = new DictationController(
    settings,
    mainWindowContents,
    () => {
      // Kick the engine as the session opens so it is warm by the first pause.
      void modelServer.start().catch(() => undefined);
      mainWindowContents()?.send(IPC_CHANNELS.statsChanged, stats.recordSession());
    },
    (text) => {
      mainWindowContents()?.send(IPC_CHANNELS.statsChanged, stats.recordPhrase(text));
    },
  );

  createWindow();
  await dictation.initialize();

  void modelServer.selectModel(settings.value.modelId).catch(() => undefined);

  resources = new ResourceMonitor(
    () => app.getAppMetrics(),
    () => modelServer.pid,
    (usage) => mainWindowContents()?.send(IPC_CHANNELS.resourceUsage, usage),
  );
  resources.start();

  // The always-present overlay means BrowserWindow.getAllWindows() is never
  // empty, so re-opening keys off the main window specifically.
  app.on("activate", () => {
    if (!window || window.isDestroyed()) createWindow();
    else window.show();
  });
});

function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.selectModel, async (event, modelId: unknown) => {
    assertTrustedSender(event);
    if (!isSpeechModelId(modelId)) throw new Error("Unknown speech model.");
    settings.update({ modelId });
    broadcastSettings();
    await modelServer.selectModel(modelId);
  });

  ipcMain.handle(IPC_CHANNELS.getModelState, (event) => {
    assertTrustedSender(event);
    return modelServer.state;
  });

  ipcMain.handle(IPC_CHANNELS.startModel, async (event) => {
    assertTrustedSender(event);
    await modelServer.start();
  });

  ipcMain.handle(IPC_CHANNELS.requestMicrophone, (event) => {
    assertTrustedSender(event);
    return requestMicrophonePermission(
      process.platform,
      () => systemPreferences.getMediaAccessStatus("microphone"),
      () => systemPreferences.askForMediaAccess("microphone"),
    );
  });

  ipcMain.handle(IPC_CHANNELS.transcribeAudio, async (event, bytes: Uint8Array) => {
    assertTrustedSender(event);
    // Waiting here lets a phrase spoken during model load still transcribe,
    // instead of failing with "not ready".
    await modelServer.start();
    return modelServer.transcribe(new Uint8Array(bytes));
  });

  ipcMain.handle(IPC_CHANNELS.getSettings, (event) => {
    assertTrustedSender(event);
    return settings.value;
  });

  ipcMain.handle(IPC_CHANNELS.updateSettings, async (event, patch: unknown) => {
    assertTrustedSender(event);
    const previous = settings.value;
    const next = settings.update({ ...previous, ...(patch as object) });

    if (next.theme !== previous.theme) nativeTheme.themeSource = next.theme;
    if (
      next.hotkeyId !== previous.hotkeyId ||
      next.holdMs !== previous.holdMs ||
      next.doubleTapMs !== previous.doubleTapMs
    ) {
      dictation.applySettings(next);
    }
    if (next.modelId !== previous.modelId) {
      void modelServer.selectModel(next.modelId).catch(() => undefined);
    }

    broadcastSettings();
    return next;
  });

  ipcMain.handle(IPC_CHANNELS.getStats, (event) => {
    assertTrustedSender(event);
    return stats.value;
  });

  ipcMain.handle(IPC_CHANNELS.getHotkeyStatus, (event) => {
    assertTrustedSender(event);
    dictation.refreshPermissions();
    return dictation.hotkeyStatus;
  });

  ipcMain.handle(IPC_CHANNELS.requestHotkeyPermission, (event, scope: unknown) => {
    assertTrustedSender(event);
    if (scope !== "accessibility" && scope !== "input-monitoring") return;
    dictation.requestPermission(scope);
  });

  ipcMain.handle(IPC_CHANNELS.openPrivacySettings, async (event, pane: unknown) => {
    assertTrustedSender(event);
    if (pane !== "accessibility" && pane !== "input-monitoring" && pane !== "microphone") {
      return;
    }
    await dictation.openPrivacyPane(pane as PrivacyPane);
  });

  ipcMain.handle(IPC_CHANNELS.toggleDictation, (event) => {
    assertTrustedSender(event);
    dictation.toggleFromApp();
  });

  ipcMain.handle(IPC_CHANNELS.previewIndicator, (event) => {
    assertTrustedSender(event);
    dictation.previewIndicator();
  });

  ipcMain.on(IPC_CHANNELS.overlayDragBegin, (event) => {
    assertTrustedSender(event);
    dictation.beginOverlayDrag();
  });

  ipcMain.on(IPC_CHANNELS.overlayDragMove, (event, delta: unknown) => {
    assertTrustedSender(event);
    const { deltaX, deltaY } = (delta ?? {}) as { deltaX?: number; deltaY?: number };
    if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return;
    dictation.dragOverlay(deltaX as number, deltaY as number);
  });

  ipcMain.on(IPC_CHANNELS.overlayDragEnd, (event) => {
    assertTrustedSender(event);
    const position = dictation.endOverlayDrag();
    if (!position) return;
    settings.update({ ...settings.value, overlayX: position.x, overlayY: position.y });
    broadcastSettings();
  });

  ipcMain.on(IPC_CHANNELS.dictationState, (event, status: DictationStatus) => {
    assertTrustedSender(event);
    dictation.handleOverlayState(status);
  });

  ipcMain.on(IPC_CHANNELS.dictationPhrase, (event, phrase: DictationPhrase) => {
    assertTrustedSender(event);
    dictation.handleOverlayPhrase(phrase);
  });
}

function broadcastSettings(): void {
  mainWindowContents()?.send(IPC_CHANNELS.settingsChanged, settings.value);
  dictation?.overlayContents?.send(IPC_CHANNELS.settingsChanged, settings.value);
}

app.on("window-all-closed", () => {
  // The hotkey keeps working with every window closed, so on macOS we stay alive.
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  resources?.stop();
  settings?.flush();
  stats?.flush();
  dictation?.dispose();
  void modelServer.stop();
});
