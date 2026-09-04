import { contextBridge, ipcRenderer } from "electron";
import { DesktopApi, ModelEvent } from "../shared/contracts";
import { IPC_CHANNELS } from "../shared/ipc";

const api: DesktopApi = {
  startModel: () => ipcRenderer.invoke(IPC_CHANNELS.startModel),
  selectModel: (modelId) => ipcRenderer.invoke(IPC_CHANNELS.selectModel, modelId),
  requestMicrophoneAccess: () => ipcRenderer.invoke(IPC_CHANNELS.requestMicrophone),
  transcribe: (wavBytes) => ipcRenderer.invoke(IPC_CHANNELS.transcribeAudio, wavBytes),
  onModelEvent: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, modelEvent: ModelEvent): void => {
      listener(modelEvent);
    };
    ipcRenderer.on(IPC_CHANNELS.modelEvent, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.modelEvent, handler);
  },
};

contextBridge.exposeInMainWorld("parakeetFlow", api);
