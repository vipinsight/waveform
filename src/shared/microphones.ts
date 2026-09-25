import type { MicrophoneDevice } from "./contracts";

/** The one input every Mac has, and the one worth recommending. */
const BUILT_IN = /macbook|built-in|internal microphone|mac mini|imac/i;

export function isBuiltInMicrophone(label: string): boolean {
  return BUILT_IN.test(label);
}

/**
 * Drops the word every device appends to its own name.
 *
 * "Vipin's iPhone Microphone" is a microphone; saying so in a list of
 * microphones spends width on the one thing every entry has in common.
 */
function shorten(label: string): string {
  return label.replace(/\s*microphone$/i, "").trim() || label;
}

/**
 * One ordered, labelled device list for Settings and the menu bar.
 *
 * The first entry is Waveform's automatic choice: the built-in mic when one
 * is present, otherwise whatever macOS currently resolves as default. An empty
 * id is already what settings mean by "do not pin a device", so both the
 * dropdown and the menu can render the list without a case for it.
 */
export function microphoneDevices(devices: readonly MediaDeviceInfo[]): MicrophoneDevice[] {
  const inputs = devices.filter((device) => device.kind === "audioinput");

  // The "default" entry is a duplicate of another device, which is why it is
  // kept out of the list below -- but its label is the only place macOS says
  // which device that is.
  const resolved = inputs.find((device) => device.deviceId === "default")?.label ?? "";
  const resolvedName = shorten(resolved.replace(/^default\s*[-–]\s*/i, ""));
  const builtIn = inputs.find(
    (device) => device.deviceId !== "default" && isBuiltInMicrophone(device.label),
  );

  const auto: MicrophoneDevice = {
    id: "",
    label: "Auto-detect",
    displayLabel: builtIn
      ? "Auto (built-in mic)"
      : resolvedName
        ? `Auto-detect (${resolvedName})`
        : "Auto-detect",
  };

  const rest = inputs
    .filter((device) => device.deviceId !== "default" && device.deviceId)
    .map((device, index) => {
      const label = device.label || `Microphone ${index + 1}`;
      return {
        id: device.deviceId,
        label,
        displayLabel: isBuiltInMicrophone(label)
          ? "Built-in mic (recommended)"
          : shorten(label),
      };
    })
    .sort(
      (first, second) =>
        Number(isBuiltInMicrophone(second.label)) - Number(isBuiltInMicrophone(first.label)) ||
        first.label.localeCompare(second.label),
    );

  return [auto, ...rest];
}
