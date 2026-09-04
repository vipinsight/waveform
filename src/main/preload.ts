import { contextBridge, ipcRenderer } from "electron";
import { DesktopApi, ModelEvent } from "../shared/contracts";

const api: DesktopApi = {
  startModel: () => ipcRenderer.invoke("model:start"),
  requestMicrophoneAccess: () => ipcRenderer.invoke("microphone:request"),
  transcribe: (wavBytes) => ipcRenderer.invoke("audio:transcribe", wavBytes),
  onModelEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, modelEvent: ModelEvent): void => {
      listener(modelEvent);
    };
    ipcRenderer.on("model:event", handler);
    return () => ipcRenderer.removeListener("model:event", handler);
  },
};

contextBridge.exposeInMainWorld("parakeetFlow", api);

