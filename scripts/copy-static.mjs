import { cp, mkdir } from "node:fs/promises";
import { build } from "esbuild";

await mkdir("dist/src/renderer", { recursive: true });
await Promise.all([
  cp("src/renderer/index.html", "dist/src/renderer/index.html"),
  cp("src/renderer/styles.css", "dist/src/renderer/styles.css"),
  build({
    entryPoints: ["src/renderer/renderer.ts"],
    outfile: "dist/src/renderer/renderer.js",
    bundle: true,
    platform: "browser",
    format: "iife",
    sourcemap: true,
  }),
]);

