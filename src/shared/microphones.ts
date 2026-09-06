import type { MicrophoneDevice } from "./contracts";

/** One ordered, labeled device list for Settings and the native menu bar. */
export function microphoneDevices(devices: readonly MediaDeviceInfo[]): MicrophoneDevice[] {
  const recommended = (label: string): boolean => /macbook|iphone/i.test(label);
  return devices
    .filter((device) => device.kind === "audioinput" && device.deviceId !== "default" && device.deviceId)
    .map((device, index) => {
      const label = device.label || `Microphone ${index + 1}`;
      return {
        id: device.deviceId,
        label,
        displayLabel: recommended(label) ? `${label} (Recommended)` : label,
      };
    })
    .sort((first, second) =>
      Number(recommended(second.label)) - Number(recommended(first.label)) ||
      first.label.localeCompare(second.label),
    );
}
