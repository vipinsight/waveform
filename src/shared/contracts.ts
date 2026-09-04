export const MODEL_ID = "nvidia/parakeet-tdt-0.6b-v3";

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
  requestMicrophoneAccess(): Promise<MicrophonePermissionResult>;
  transcribe(wavBytes: Uint8Array): Promise<TranscriptionResult>;
  onModelEvent(listener: (event: ModelEvent) => void): () => void;
}

