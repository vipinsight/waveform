## What this changes

<!-- What it does, and why. If it fixes an issue, "Fixes #123". -->

## How you tested it

<!--
Dictation is hard to test automatically: it crosses a webview, a Rust host, a
Swift helper and whatever app has focus. Say what you actually exercised —
which engine, which trigger key, which app you dictated into.
-->

## Checklist

- [ ] `pnpm test` passes (TypeScript and Rust)
- [ ] `pnpm typecheck` passes
- [ ] Dictated into a real app at least once, if this touches capture,
      transcription, or insertion
- [ ] Docs updated, if this changes behaviour the README or `docs/` describes
- [ ] No audio leaves the Mac
