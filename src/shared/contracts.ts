import type { SpeechModelId } from "./models";

export type ModelStage =
  | "idle"
  | "starting"
  | "downloading"
  | "loading"
  | "ready"
  | "error";

export type UiStage = ModelStage | "transcribing";

export interface ModelEvent {
  stage: ModelStage;
  message: string;
  modelId: SpeechModelId;
}

export interface TranscriptionResult {
  text: string;
}

export type MicrophonePermissionStatus =
  | "not-determined"
  | "granted"
  | "denied"
  | "restricted"
  | "unknown";

export interface MicrophonePermissionResult {
  granted: boolean;
  status: MicrophonePermissionStatus;
}

export interface DesktopApi {
  startModel(): Promise<void>;
  selectModel(modelId: SpeechModelId): Promise<void>;
  requestMicrophoneAccess(): Promise<MicrophonePermissionResult>;
  transcribe(wavBytes: Uint8Array): Promise<TranscriptionResult>;
  onModelEvent(listener: (event: ModelEvent) => void): () => void;
}
