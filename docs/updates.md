# Updates

Waveform is not in the App Store, so nothing tells anyone that a release
happened. It checks for itself, and can install what it finds.

## Two signatures, and why both

They are unrelated, and confusing them is the usual way this goes wrong.

- **Apple's.** A Developer ID signature, plus notarisation. macOS refuses to run
  the app without it. It says the app came from a known developer.
- **minisign's.** A keypair made by `tauri signer generate`. The public half is
  compiled into the app through `plugins.updater.pubkey`; the private half signs
  each release's tarball. The app refuses to unpack an update the key does not
  vouch for. It says the update came from us.

The private key lives at `~/.tauri/waveform.key`, outside this repository, and
must be backed up somewhere that is not this Mac. **Lose it and no existing
install can ever be updated again** — a build signed with a new key is rejected
by every copy already out there, and the only route left is asking people to
download the app by hand.

## What the app does

`plugins.updater.endpoints` names one URL:

```
https://github.com/vipinsight/waveform/releases/latest/download/latest.json
```

`releases/latest/download/…` always resolves to the newest release, so the
manifest has to be attached to each one. It looks like this:

```json
{
  "version": "0.2.0",
  "notes": "…",
  "pub_date": "2026-09-07T00:00:00Z",
  "platforms": {
    "darwin-aarch64": {
      "signature": "…",
      "url": "https://github.com/vipinsight/waveform/releases/download/v0.2.0/Waveform_0.2.0.app.tar.gz"
    }
  }
}
```

Only `darwin-aarch64`. Waveform needs an Apple Silicon Mac, and a platform key
here is a promise that an update exists for it.

[`updates.rs`](../src-tauri/src/updates.rs) wraps the plugin in two functions and
a background task:

- `check` reports through the `update-event` Tauri event and returns the release
  if there is one. A failed check is an error, not "up to date" — saying the
  latter to a request that never arrived is a lie.
- `install` checks again, downloads with progress, and returns. The
  `install_update` command then stops the speech engine and calls `app.restart()`
  — the engine is a separate process of several hundred megabytes that would not
  notice its parent being replaced, the same reason the signal handler stops it
  before exiting.
- `spawn_checks` waits 20 seconds after launch, then checks once a day for as
  long as the app runs. Waveform can start at login and sit there for weeks with
  nothing on screen, so a check at launch alone would fire once and never again.

The setting is read on each pass rather than captured, so switching it off stops
the next check rather than the one after a restart.

## The switch, and why it exists

Waveform's promise is that audio stays on this Mac. Today the only outbound
traffic is AI Polish and a model download, and both happen because something was
pressed. An update check is the first request the app makes that nobody asked
for, so **Settings → General → Check for updates automatically** turns it off.

**Check now** on **Settings → About** still checks with the switch off. The switch is about unprompted
requests; pressing the button is the prompt.

## Cutting a release

Follow [Releasing](releasing.md). Versions are bumped together using `pnpm bump`,
reviewed in a PR, and merged before building. `pnpm release` builds, signs,
notarises, validates, and uploads a draft pinned to the built commit. Publishing
is a separate action after reviewing notes and testing the downloaded app.

Release notes come from `--generate-notes`, grouped by
[.github/release.yml](../.github/release.yml). Keep signing credentials on the
maintainer's Mac, outside Git and untrusted PR jobs.

## Traps

**`--bundles dmg` produces no updater artifact.** The tarball comes from the
`app` target, and Tauri says so and carries on:

> The bundler was configured to create updater artifacts but no updater-enabled
> targets were built. Please enable one of these targets: app, appimage, msi,
> nsis

`pnpm dmg` is still dmg-only, which is right for a local build. `pnpm release`
builds `app,dmg`.

**Notarising the app is not notarising the disk image.** The bundler notarises
and staples the `.app`, which is what lets it launch. Gatekeeper treats the
image as a separate thing, and `finish-dmg.sh` repacks it to lay out its
window, which invalidates whatever signature it had. Two builds went out that
way and met "Apple cannot check it for malicious software" on download, before
anyone reached the app inside. `finish-dmg.sh` now notarises and staples the
image too, and prints the `spctl` verdict -- which reads `accepted` only when a
downloaded copy would open without a warning.

**The Tauri CLI does not read `.env` files.** `TAURI_SIGNING_PRIVATE_KEY` and
its password have to be in the environment. `release.sh` sources
`.env.notarization` itself for the same reason.

**`pnpm app` never touches the bundler.** `run-tauri.sh` assembles
`release/Waveform Dev.app` by hand, because WKWebView refuses microphone access to a
bare binary. Updater artifacts come only from a real `tauri build`, so the
release path and the everyday path diverge here.

## Update verification

Do not infer a working upgrade from a successful build. For each release, record
an update from an older installed version: check, download, restart, retained
history/settings, and all three macOS permissions. See the [release checklist](releasing.md).

Test rejection of a corrupted signature with an isolated test build and feed,
never by corrupting the production manifest. This document does not certify
that end-to-end update testing has passed for any particular release.
