import { contextBridge, ipcRenderer } from "electron";
import type {
  AppStats,
  DesktopApi,
  DictationCommand,
  DictationUpdate,
  HotkeyStatus,
  ModelEvent,
  ResourceUsage,
} from "../shared/contracts";
import type { AppSettings } from "../shared/settings";
import { IPC_CHANNELS } from "../shared/ipc";

/** Wraps ipcRenderer.on in a typed subscribe/unsubscribe pair. */
function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: Electron.IpcRendererEvent, payload: T): void => {
    listener(payload);
  };
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

const api: DesktopApi = {
  startModel: () => ipcRenderer.invoke(IPC_CHANNELS.startModel),
  selectModel: (modelId) => ipcRenderer.invoke(IPC_CHANNELS.selectModel, modelId),
  requestMicrophoneAccess: () => ipcRenderer.invoke(IPC_CHANNELS.requestMicrophone),
  transcribe: (wavBytes) => ipcRenderer.invoke(IPC_CHANNELS.transcribeAudio, wavBytes),
  onModelEvent: (listener) => subscribe<ModelEvent>(IPC_CHANNELS.modelEvent, listener),
  getModelState: () => ipcRenderer.invoke(IPC_CHANNELS.getModelState),

  getSettings: () => ipcRenderer.invoke(IPC_CHANNELS.getSettings),
  updateSettings: (patch) => ipcRenderer.invoke(IPC_CHANNELS.updateSettings, patch),
  onSettingsChanged: (listener) =>
    subscribe<AppSettings>(IPC_CHANNELS.settingsChanged, listener),

  getHotkeyStatus: () => ipcRenderer.invoke(IPC_CHANNELS.getHotkeyStatus),
  onHotkeyStatusChanged: (listener) =>
    subscribe<HotkeyStatus>(IPC_CHANNELS.hotkeyStatusChanged, listener),
  requestHotkeyPermission: (scope) =>
    ipcRenderer.invoke(IPC_CHANNELS.requestHotkeyPermission, scope),
  openPrivacySettings: (pane) => ipcRenderer.invoke(IPC_CHANNELS.openPrivacySettings, pane),

  toggleDictation: () => ipcRenderer.invoke(IPC_CHANNELS.toggleDictation),
  previewIndicator: () => ipcRenderer.invoke(IPC_CHANNELS.previewIndicator),
  beginOverlayDrag: () => ipcRenderer.send(IPC_CHANNELS.overlayDragBegin),
  moveOverlay: (deltaX, deltaY) =>
    ipcRenderer.send(IPC_CHANNELS.overlayDragMove, { deltaX, deltaY }),
  endOverlayDrag: () => ipcRenderer.send(IPC_CHANNELS.overlayDragEnd),
  onResourceUsage: (listener) =>
    subscribe<ResourceUsage>(IPC_CHANNELS.resourceUsage, listener),
  getAiStatus: () => ipcRenderer.invoke(IPC_CHANNELS.getAiStatus),
  setOpenRouterKey: (key) => ipcRenderer.invoke(IPC_CHANNELS.setOpenRouterKey, key),
  clearOpenRouterKey: () => ipcRenderer.invoke(IPC_CHANNELS.clearOpenRouterKey),
  polishSelection: () => ipcRenderer.invoke(IPC_CHANNELS.polishSelection),
  getStats: () => ipcRenderer.invoke(IPC_CHANNELS.getStats),
  onStatsChanged: (listener) => subscribe<AppStats>(IPC_CHANNELS.statsChanged, listener),
  onDictationCommand: (listener) =>
    subscribe<DictationCommand>(IPC_CHANNELS.dictationCommand, listener),
  onDictationUpdate: (listener) =>
    subscribe<DictationUpdate>(IPC_CHANNELS.dictationUpdate, listener),
  reportDictationState: (status) => ipcRenderer.send(IPC_CHANNELS.dictationState, status),
  reportDictationPhrase: (phrase) => ipcRenderer.send(IPC_CHANNELS.dictationPhrase, phrase),
};

contextBridge.exposeInMainWorld("waveform", api);
