// Compiles the macOS hotkey helper into dist/ so the packaged app can spawn it.
// Skipped off macOS and when the Swift toolchain is missing — the app degrades to
// "global shortcut unavailable" rather than failing the build.
import { spawnSync } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";

const SOURCE = "src/native/HotkeyHelper.swift";
const OUTPUT = "dist/src/main/waveform-hotkey";

async function newestMtime(...paths) {
  const stats = await Promise.all(paths.map((path) => stat(path).catch(() => null)));
  return stats.reduce((newest, entry) => Math.max(newest, entry?.mtimeMs ?? 0), 0);
}

if (process.platform !== "darwin") {
  console.log("build-helper: not macOS, skipping hotkey helper.");
  process.exit(0);
}

if (spawnSync("swiftc", ["--version"], { stdio: "ignore" }).status !== 0) {
  console.warn("build-helper: swiftc not found, skipping hotkey helper.");
  process.exit(0);
}

if ((await newestMtime(OUTPUT)) > (await newestMtime(SOURCE))) {
  process.exit(0);
}

await mkdir("dist/src/main", { recursive: true });
const result = spawnSync(
  "swiftc",
  [
    "-O",
    "-swift-version",
    "5",
    "-target",
    "arm64-apple-macos13.0",
    "-framework",
    "AppKit",
    "-framework",
    "CoreGraphics",
    "-framework",
    "IOKit",
    "-o",
    OUTPUT,
    SOURCE,
  ],
  { stdio: "inherit" },
);

if (result.status !== 0) {
  console.warn("build-helper: hotkey helper failed to compile; shortcuts disabled.");
}
