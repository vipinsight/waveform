import { describe, expect, it } from "vitest";
import { isBuiltInMicrophone, microphoneDevices } from "../src/shared/microphones";

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
      { id: "", label: "Auto-detect", displayLabel: "Auto (built-in mic)" },
      { id: "mac", label: "MacBook Pro Microphone", displayLabel: "Built-in mic (recommended)" },
      { id: "usb", label: "AT2020 USB", displayLabel: "AT2020 USB" },
      { id: "teams", label: "Microsoft Teams Audio Device (Virtual)", displayLabel: "Microsoft Teams Audio Device (Virtual)" },
      { id: "phone", label: "Vipin\u2019s iPhone Microphone", displayLabel: "Vipin\u2019s iPhone" },
    ]);
    // The original names are what settings and the tray store, so they survive.
    expect(inputs[1]?.deviceId).toBe("usb");
  });

  it("says auto-detect plainly when there is no built-in mic to prefer", () => {
    expect(microphoneDevices([device("usb", "AT2020 USB")])[0]).toEqual({
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

  it("recognises the built-in mic by name", () => {
    expect(isBuiltInMicrophone("MacBook Air Microphone")).toBe(true);
    expect(isBuiltInMicrophone("Vipin's AirPods Pro")).toBe(false);
  });
});
