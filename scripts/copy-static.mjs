import { cp, mkdir } from "node:fs/promises";
import { build } from "esbuild";

const bundle = (entry, outfile, platform) =>
  build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform,
    format: platform === "browser" ? "iife" : "cjs",
    ...(platform === "browser" ? {} : { external: ["electron"] }),
    sourcemap: true,
  });

await mkdir("dist/src/renderer", { recursive: true });
await Promise.all([
  cp("src/renderer/index.html", "dist/src/renderer/index.html"),
  cp("src/renderer/styles.css", "dist/src/renderer/styles.css"),
  cp("src/renderer/overlay.html", "dist/src/renderer/overlay.html"),
  cp("src/renderer/overlay.css", "dist/src/renderer/overlay.css"),
  cp("icons/slur-mono-ink.svg", "dist/src/renderer/slur-mono-ink.svg"),
  cp("icons/waveform-icon.png", "dist/src/renderer/waveform-icon.png"),
  bundle("src/renderer/renderer.ts", "dist/src/renderer/renderer.js", "browser"),
  bundle("src/renderer/overlay.ts", "dist/src/renderer/overlay.js", "browser"),
  bundle("src/main/preload.ts", "dist/src/main/preload.js", "node"),
]);
