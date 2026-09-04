import type {
  MicrophonePermissionResult,
  MicrophonePermissionStatus,
} from "../shared/contracts";

type ReadStatus = () => MicrophonePermissionStatus;
type AskForAccess = () => Promise<boolean>;

export async function requestMicrophonePermission(
  platform: NodeJS.Platform,
  readStatus: ReadStatus,
  askForAccess: AskForAccess,
): Promise<MicrophonePermissionResult> {
  if (platform !== "darwin") return { granted: true, status: "granted" };

  const status = readStatus();
  if (status !== "not-determined") {
    return { granted: status === "granted", status };
  }

  const granted = await askForAccess();
  return { granted, status: granted ? "granted" : "denied" };
}
