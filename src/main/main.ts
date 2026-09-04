import {
  app,
  BrowserWindow,
  ipcMain,
  session,
  systemPreferences,
  type IpcMainInvokeEvent,
} from "electron";
import { join } from "node:path";
import { requestMicrophonePermission } from "./microphone-permission";
import { ModelServer } from "./model-server";
import { IPC_CHANNELS } from "../shared/ipc";
import { isSpeechModelId } from "../shared/models";

let window: BrowserWindow | null = null;
const modelServer = new ModelServer((event) => {
  window?.webContents.send(IPC_CHANNELS.modelEvent, event);
});

function createWindow(): void {
  window = new BrowserWindow({
    width: 900,
    height: 680,
    minWidth: 680,
    minHeight: 520,
    title: "Local Speech",
    backgroundColor: "#f2f4f8",
    vibrancy: "under-window",
    visualEffectState: "active",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.loadFile(join(__dirname, "../renderer/index.html"));
  window.on("closed", () => {
    window = null;
  });
}

function assertTrustedSender(event: IpcMainInvokeEvent): void {
  if (event.sender !== window?.webContents) throw new Error("Untrusted IPC sender.");
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    return webContents === window?.webContents && permission === "media";
  });
  session.defaultSession.setPermissionRequestHandler(
    (webContents, permission, callback, details) => {
      const mediaTypes = "mediaTypes" in details ? details.mediaTypes : [];
      callback(
        webContents === window?.webContents &&
          permission === "media" &&
          mediaTypes?.includes("audio") === true &&
          mediaTypes.includes("video") === false,
      );
    },
  );

  ipcMain.handle(IPC_CHANNELS.selectModel, async (event, modelId: unknown) => {
    assertTrustedSender(event);
    if (!isSpeechModelId(modelId)) throw new Error("Unknown speech model.");
    await modelServer.selectModel(modelId);
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
  ipcMain.handle(IPC_CHANNELS.transcribeAudio, (event, bytes: Uint8Array) => {
    assertTrustedSender(event);
    return modelServer.transcribe(new Uint8Array(bytes));
  });

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  void modelServer.stop();
});
