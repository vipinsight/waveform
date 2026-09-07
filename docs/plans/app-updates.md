# Shipping updates

Status: proposed, not started. Written 2026-09-07.

## Why

There is no way to update Waveform. Someone who installed 0.1.0 from the disk
image has 0.1.0 forever, unless they notice a new release, download it, and drag
it over the old copy — losing nothing but having no reason to do it, because the
app never says a new version exists.

There is also no release process at all: no CI (`.github/` does not exist),
notarisation runs from `.env.notarization` on one Mac, and the version number is
written out three times (`package.json`, `src-tauri/tauri.conf.json`,
`src-tauri/Cargo.toml`), all of them still `0.1.0`.

## How this works, in general

A self-updating Mac app that is not on the App Store has four moving parts:

1. **A manifest**, somewhere on the web, saying what the newest version is and
   where to get it.
2. **A check**, made by the running app, comparing that against its own version.
3. **A signed download**, so a compromised host or a hostile network cannot
   substitute a different app. This is separate from Apple's code signature: the
   updater verifies the payload *before* it is unpacked, with its own key.
4. **A swap**, replacing the `.app` bundle on disk and relaunching.

None of this involves Apple, and Gatekeeper does not care where an update came
from — only that what lands is signed with a Developer ID and notarised.

## What solo developers actually do

**Sparkle** is the long-standing answer for independent Mac apps. It is what
most of the well-known indie apps use. The app ships an "appcast" XML feed,
Sparkle handles the UI, the EdDSA signature check, delta updates so a small
change is a small download, "skip this version", and phased rollouts that stop a
bad build reaching everyone at once. It is mature and unsurprising. Its cost here
is that it is an Objective-C/Swift framework: reaching it from Tauri means a
bridge, and this project has exactly one piece of Swift already
(`HotkeyHelper.swift`) and good reasons for it.

**Tauri's own updater plugin** does the same job with less of it. Static JSON
manifest, minisign signature, no delta updates, no phased rollout, and a
serviceable built-in dialog. For a Tauri app it is roughly an afternoon.

**GitHub Releases as the host** is near-universal at this scale — free, on a
CDN, and `releases/latest/download/<asset>` is a stable URL that always resolves
to the newest release, which is exactly what a static manifest needs.

**Releasing from the developer's own Mac** is also common, and worth saying out
loud because the alternative sounds more professional than it is. Signing and
notarising in CI means putting a Developer ID certificate and an app-specific
password into repository secrets. For one person on one machine, a tagged local
release is fewer secrets in fewer places. CI earns its place when there is a
second person, or a second machine.

**Homebrew Cask** is the other channel solo developers get asked for
(`brew install --cask waveform`). Worth knowing before adding one: a cask and a
built-in updater both manage the same `.app`, and users hit the seam when `brew
upgrade` reinstalls over a self-updated copy. The usual answer is to let the cask
declare `auto_updates true` so Homebrew leaves it alone.

## Recommendation

Tauri's updater plugin, a static `latest.json` on GitHub Releases, releases cut
from a local tag. Revisit Sparkle only if delta updates or phased rollout start
to matter — which, at half a gigabyte of model weights that the app downloads
separately anyway, they probably will not.

## What to build

### 1. One version number

Make `src-tauri/tauri.conf.json` the source of truth — it is what the updater
compares — and have the release script read the others from it, or fail if they
disagree. Three hand-kept copies of a number that must match is the same failure
the model registry already documents.

Adopt semantic versioning and mean it: the updater's comparison is the only thing
deciding whether a user is offered a build.

### 2. The plugin

- `cargo add tauri-plugin-updater` and `@tauri-apps/plugin-updater`, registered
  in the builder in [lib.rs](../../src-tauri/src/lib.rs) beside the other
  plugins.
- `bundle.createUpdaterArtifacts: true` in
  [tauri.conf.json](../../src-tauri/tauri.conf.json). On macOS this produces
  `Waveform.app.tar.gz` and `Waveform.app.tar.gz.sig` alongside the `.app` — the
  updater takes the tarball, never the DMG.
- `plugins.updater` with the public key inline and one endpoint:
  `https://github.com/vipiny35/waveform/releases/latest/download/latest.json`.
  The `{{target}}`, `{{arch}}` and `{{current_version}}` placeholders are for
  dynamic servers; a static manifest needs none of them, because it lists every
  platform itself.
- `tauri signer generate` produces the keypair. The private key and its password
  are `TAURI_SIGNING_PRIVATE_KEY` and
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, and they must be in the shell
  environment — the Tauri CLI does not read `.env` files, unlike this project's
  notarisation setup. Back the private key up somewhere that is not this Mac:
  lose it and no existing install can ever be updated again, because they will
  reject anything signed by a new key.

### 3. The manifest

`latest.json`, attached to each GitHub release:

```json
{
  "version": "0.2.0",
  "notes": "…",
  "pub_date": "2026-09-07T00:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "url": "https://github.com/vipiny35/waveform/releases/download/v0.2.0/Waveform.app.tar.gz",
      "signature": "<contents of the .sig file>"
    }
  }
}
```

Only `darwin-aarch64`: the README already requires an Apple Silicon Mac, and
`nemo-speech` is launched with `--device metal` on aarch64 and `cpu` elsewhere.
Do not list `darwin-x86_64` unless an Intel build is actually tested — a
manifest entry is a promise.

Generate this from the build output rather than by hand. The signature is a long
base64 blob, and a mistyped one fails only on the user's machine.

### 4. Checking, and telling the user

- Check on launch after a short delay, and at most once a day. Never on every
  window open.
- A **Check for updates** item in the menu bar, which reports "up to date" when
  it is — a check with no visible outcome reads as broken.
- Offer, do not impose. A dictation in flight must not be interrupted by a
  restart; the natural gate is the dictation state machine, which already knows
  whether anything is happening.
- Show `notes`. It is the only thing that tells someone why to bother.

### 5. The release script

`pnpm dmg` already builds and lays out the disk image. A release adds: build the
updater artifacts, notarise, write `latest.json`, create the tagged GitHub
release, upload the DMG, the tarball and the manifest. `gh release create` does
the last part in one line.

## Hazards specific to this app

**`--bundles dmg` will not produce the updater artifact.** `pnpm dmg` runs
`tauri build --bundles dmg`, which overrides `bundle.targets`. The tarball comes
from the `app` target, so the release build needs `--bundles app,dmg`. This will
look like `createUpdaterArtifacts` silently not working.

**`pnpm app` does not use the bundler at all.** `run-tauri.sh` assembles
`release/Waveform.app` by hand, because WKWebView refuses microphone access to a
bare binary. Updater artifacts come only from a real `tauri build`, so the
release path and the development path diverge here — and the release path is the
one that has never been exercised.

**Permissions are tied to the code signature.** The README is explicit that
macOS re-asks for Input Monitoring and Accessibility whenever the signature
changes, which is why builds are signed with a real certificate rather than
ad-hoc. An update that keeps the same Developer ID and bundle identifier should
keep both grants. *Should* — verify it on a real machine with both granted before
shipping the first update, because a self-inflicted permission reset on every
release would be worse than not updating at all.

**Subprocesses must be down before the swap.** The app runs a hotkey helper and,
depending on the model, a Python worker or a `nemo-speech` server of several
hundred megabytes. There is already a SIGTERM/SIGINT handler that calls
`engine.stop()` before exiting, for exactly this reason; the updater's restart
has to go through it rather than around it.

**Closing the window does not quit.** Waveform can be running with nothing on
screen, and can start at login. An update prompt from an app with no visible
window is a bad experience: prefer the menu bar, and defer the offer until there
is somewhere sensible to put it.

**Weights are not part of the app.** They live in caches and in Application
Support, outside the bundle, so an update does not disturb them and must not try
to. If a future version changes what it expects on disk, that is a migration in
its own right — not something to discover during a swap.

**The privacy claim.** The pitch is that audio stays on this Mac, and today the
only outbound traffic is AI Polish, which the user opts into. An update check is
a network request the user did not ask for, carrying an IP address and a version
string. Say so plainly in the README, and put a switch in Settings that turns it
off. An app that makes this promise should not quietly start phoning home, even
for a good reason.

## Verification

1. Build 0.1.0, install it from the DMG, grant both permissions, and dictate.
2. Build 0.2.0 with a visible change, publish a release with a real `latest.json`.
3. From the installed 0.1.0: the check finds it, the notes show, the download
   completes, the app relaunches as 0.2.0 — and **both permissions are still
   granted**, and the shortcut still works without visiting System Settings.
4. Corrupt the signature in `latest.json` and confirm the update is refused. This
   is the whole point of the mechanism, and the only way to know it is wired up
   is to see it reject something.
5. Point the endpoint at a 404 and confirm the app says it could not check,
   rather than saying it is up to date.
6. Run the check with the switch off and confirm no request is made — with a
   proxy or Little Snitch, not by reading the code.
