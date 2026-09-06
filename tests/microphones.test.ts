import { describe, expect, it } from "vitest";
import { microphoneDevices } from "../src/shared/microphones";

function device(deviceId: string, label: string, kind: MediaDeviceKind = "audioinput"): MediaDeviceInfo {
  return { deviceId, label, kind, groupId: "", toJSON: () => ({}) };
}

describe("microphone list shared with the menu bar", () => {
  it("recommends only MacBook inputs while preserving selection IDs and original names", () => {
    const inputs = [
      device("usb", "AT2020 USB"),
      device("mac", "MacBook Pro Microphone"),
      device("phone", "Vipin’s iPhone Microphone"),
      device("airpods", "AirPods"),
    ];
    expect(microphoneDevices(inputs)).toEqual([
      { id: "mac", label: "MacBook Pro Microphone", displayLabel: "MacBook Pro Microphone (Recommended)" },
      { id: "airpods", label: "AirPods", displayLabel: "AirPods" },
      { id: "usb", label: "AT2020 USB", displayLabel: "AT2020 USB" },
      { id: "phone", label: "Vipin’s iPhone Microphone", displayLabel: "Vipin’s iPhone Microphone" },
    ]);
    expect(inputs[0]?.deviceId).toBe("usb");
  });

  it("excludes the duplicate system default, outputs, cameras, and unusable device IDs", () => {
    expect(microphoneDevices([
      device("default", "Default - MacBook Pro Microphone"),
      device("speaker", "Speaker", "audiooutput"),
      device("camera", "Camera", "videoinput"),
      device("", ""),
      device("unnamed", ""),
    ])).toEqual([{ id: "unnamed", label: "Microphone 1", displayLabel: "Microphone 1" }]);
  });
});
