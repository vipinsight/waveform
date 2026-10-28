import { cp, mkdir } from "node:fs/promises";
import { build } from "esbuild";

const bundle = (entry, outfile) =>
  build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "browser",
    format: "iife",
    sourcemap: true,
  });

await mkdir("dist/renderer", { recursive: true });
await Promise.all([
  cp("src/renderer/index.html", "dist/renderer/index.html"),
  cp("src/renderer/styles.css", "dist/renderer/styles.css"),
  cp("src/renderer/overlay.html", "dist/renderer/overlay.html"),
  cp("src/renderer/overlay.css", "dist/renderer/overlay.css"),
  cp("src/renderer/meeting-panel.html", "dist/renderer/meeting-panel.html"),
  cp("src/renderer/meeting-panel.css", "dist/renderer/meeting-panel.css"),
  cp("src/renderer/meeting-pill.html", "dist/renderer/meeting-pill.html"),
  cp("src/renderer/meeting-pill.css", "dist/renderer/meeting-pill.css"),
  // Fetched by addModule at run time rather than bundled: an AudioWorklet
  // module is loaded by URL, and neither bundle can contain it.
  cp("src/renderer/audio/capture-worklet.js", "dist/renderer/capture-worklet.js"),
  cp("icons/waveform-mark.svg", "dist/renderer/waveform-mark.svg"),
  cp("icons/waveform-icon.png", "dist/renderer/waveform-icon.png"),
  bundle("src/renderer/renderer.ts", "dist/renderer/renderer.js"),
  bundle("src/renderer/overlay.ts", "dist/renderer/overlay.js"),
  bundle("src/renderer/meeting-panel.ts", "dist/renderer/meeting-panel.js"),
  bundle("src/renderer/meeting-pill.ts", "dist/renderer/meeting-pill.js"),
]);
