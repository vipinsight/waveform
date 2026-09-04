import { app, BrowserWindow, ipcMain, session } from "electron";
import { join } from "node:path";
import { ModelServer } from "./model-server";

let window: BrowserWindow | null = null;
const modelServer = new ModelServer((event) => {
  window?.webContents.send("model:event", event);
});

function createWindow(): void {
  window = new BrowserWindow({
    width: 900,
    height: 680,
    minWidth: 680,
    minHeight: 520,
    title: "Parakeet Flow",
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
  window.webContents.once("did-finish-load", () => {
    void modelServer.start().catch(reportModelError);
  });
  window.on("closed", () => {
    window = null;
  });
}

function reportModelError(error: unknown): void {
  window?.webContents.send("model:event", {
    stage: "error",
    message: error instanceof Error ? error.message : String(error),
  });
}

app.whenReady().then(() => {
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    return permission === "media";
  });
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, permission, callback, details) => {
      const mediaTypes = "mediaTypes" in details ? details.mediaTypes : [];
      callback(
        permission === "media" &&
          mediaTypes?.includes("audio") === true &&
          mediaTypes.includes("video") === false,
      );
    },
  );

  ipcMain.handle("model:start", async () => {
    await modelServer.start();
  });
  ipcMain.handle("audio:transcribe", (_event, bytes: Uint8Array) => {
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

