import { cp, mkdir } from "node:fs/promises";
import { build } from "esbuild";

await mkdir("dist/src/renderer", { recursive: true });
await Promise.all([
  cp("src/renderer/index.html", "dist/src/renderer/index.html"),
  cp("src/renderer/styles.css", "dist/src/renderer/styles.css"),
  cp("icons/slur-mono-ink.svg", "dist/src/renderer/slur-mono-ink.svg"),
  cp("icons/waveform-icon.png", "dist/src/renderer/waveform-icon.png"),
  build({
    entryPoints: ["src/renderer/renderer.ts"],
    outfile: "dist/src/renderer/renderer.js",
    bundle: true,
    platform: "browser",
    format: "iife",
    sourcemap: true,
  }),
  build({
    entryPoints: ["src/main/preload.ts"],
    outfile: "dist/src/main/preload.js",
    bundle: true,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    sourcemap: true,
  }),
]);

