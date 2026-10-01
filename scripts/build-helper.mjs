// Compiles the macOS helpers into dist/ so the packaged app can spawn them.
// Skipped off macOS and when the Swift toolchain is missing — the app degrades
// ("global shortcut unavailable", "meetings record the microphone only")
// rather than failing the build.
//
// The helpers are signed here rather than left to whatever signs the bundle.
// Notarisation refuses a bundle containing any executable without the hardened
// runtime, and a nested binary keeps its own signature: signing the app around
// it does not give it one. Code has to be signed inside out.
import { spawnSync } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";

const HELPERS = [
  {
    name: "hotkey helper",
    source: "src/native/HotkeyHelper.swift",
    output: "dist/native/waveform-hotkey",
    frameworks: ["AppKit", "CoreGraphics", "IOKit"],
    without: "shortcuts disabled",
  },
  {
    // Records what the Mac plays for the Notetaker. macOS 14.2 API behind an
    // availability check, so the binary still builds and runs on 13.
    name: "audio tap helper",
    source: "src/native/AudioTapHelper.swift",
    output: "dist/native/waveform-audiotap",
    frameworks: ["CoreAudio", "AVFoundation"],
    without: "meetings will record the microphone only",
  },
];

async function newestMtime(...paths) {
  const stats = await Promise.all(paths.map((path) => stat(path).catch(() => null)));
  return stats.reduce((newest, entry) => Math.max(newest, entry?.mtimeMs ?? 0), 0);
}

if (process.platform !== "darwin") {
  console.log("build-helper: not macOS, skipping the native helpers.");
  process.exit(0);
}

if (spawnSync("swiftc", ["--version"], { stdio: "ignore" }).status !== 0) {
  console.warn("build-helper: swiftc not found, skipping the native helpers.");
  process.exit(0);
}

// Only a Developer ID build needs signing. The dev loop re-signs the whole
// bundle afterwards with its own certificate, and an unsigned helper is fine
// there.
const identity = process.env.APPLE_SIGNING_IDENTITY;

await mkdir("dist/native", { recursive: true });
for (const helper of HELPERS) {
  if ((await newestMtime(helper.output)) > (await newestMtime(helper.source))) {
    continue;
  }
  const result = spawnSync(
    "swiftc",
    [
      "-O",
      "-swift-version",
      "5",
      "-target",
      "arm64-apple-macos13.0",
      ...helper.frameworks.flatMap((framework) => ["-framework", framework]),
      "-o",
      helper.output,
      helper.source,
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0) {
    console.warn(`build-helper: the ${helper.name} failed to compile; ${helper.without}.`);
    continue;
  }
  if (!identity) continue;

  const signed = spawnSync(
    "codesign",
    ["--force", "--timestamp", "--options", "runtime", "--sign", identity, helper.output],
    { stdio: "inherit" },
  );
  if (signed.status !== 0) {
    console.error(`build-helper: could not sign the ${helper.name}; notarisation will refuse it.`);
    process.exit(1);
  }
}
