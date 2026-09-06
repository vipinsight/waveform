import { describe, expect, it } from "vitest";
import { microphoneDevices } from "../src/shared/microphones";

function device(deviceId: string, label: string, kind: MediaDeviceKind = "audioinput"): MediaDeviceInfo {
  return { deviceId, label, kind, groupId: "", toJSON: () => ({}) };
}

describe("microphone list shared with the menu bar", () => {
  it("leads with auto-detect, names what it resolves to, and shortens the rest", () => {
    const inputs = [
      device("default", "Default - MacBook Pro Microphone"),
      device("usb", "AT2020 USB"),
      device("mac", "MacBook Pro Microphone"),
      device("phone", "Vipin\u2019s iPhone Microphone"),
      device("teams", "Microsoft Teams Audio Device (Virtual)"),
    ];
    expect(microphoneDevices(inputs)).toEqual([
      { id: "", label: "Auto-detect", displayLabel: "Auto-detect (MacBook Pro)" },
      { id: "mac", label: "MacBook Pro Microphone", displayLabel: "Built-in mic (recommended)" },
      { id: "usb", label: "AT2020 USB", displayLabel: "AT2020 USB" },
      { id: "teams", label: "Microsoft Teams Audio Device (Virtual)", displayLabel: "Microsoft Teams Audio Device (Virtual)" },
      { id: "phone", label: "Vipin\u2019s iPhone Microphone", displayLabel: "Vipin\u2019s iPhone" },
    ]);
    // The original names are what settings and the tray store, so they survive.
    expect(inputs[1]?.deviceId).toBe("usb");
  });

  it("says auto-detect plainly when macOS has not said what it resolves to", () => {
    expect(microphoneDevices([device("mac", "MacBook Pro Microphone")])[0]).toEqual({
      id: "",
      label: "Auto-detect",
      displayLabel: "Auto-detect",
    });
  });

  it("excludes outputs, cameras, and unusable device IDs", () => {
    expect(microphoneDevices([
      device("speaker", "Speaker", "audiooutput"),
      device("camera", "Camera", "videoinput"),
      device("", ""),
      device("unnamed", ""),
    ])).toEqual([
      { id: "", label: "Auto-detect", displayLabel: "Auto-detect" },
      { id: "unnamed", label: "Microphone 1", displayLabel: "Microphone 1" },
    ]);
  });
});
