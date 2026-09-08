# Releasing Waveform

Releases are built on an Apple Silicon Mac. CI checks pull requests without
signing credentials. `pnpm release` builds and uploads a **draft**; publishing
that draft is a separate maintainer action.

## One-time setup

Follow [Building](building.md). Install GitHub CLI (`brew install gh`) and confirm
it can access `vipiny35/waveform`. You need a Developer ID Application certificate
with its private key, notarisation credentials, and the **existing** updater
private key matching `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`.
An Apple Development certificate used for local builds is not a distribution certificate.

Copy `.env.notarization.example` to `.env.notarization`, fill it locally, and
restrict its permissions with `chmod 600 .env.notarization`. Never commit it.
`APPLE_PASSWORD` is an Apple app-specific password, not your account password.
The release script loads this file; the Tauri CLI alone does not.

The updater key defaults to `~/.tauri/waveform.key`. Override its location with
`TAURI_SIGNING_PRIVATE_KEY_PATH`; supply `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if
it is encrypted. Keep a secure backup. Do not generate a replacement key for an
existing release line: installed copies only trust the embedded public key.

## Prepare the version

1. Merge intended changes into `main` and wait for CI to pass.
2. Start a version branch from current `main`:

   ```sh
   git switch main
   git pull --ff-only
   git switch -c release/0.2.0
   pnpm bump 0.2.0
   ```

   Replace `0.2.0` with the next version. Patch versions fix bugs; minor versions
   add features. While below 1.0, document breaking changes prominently and use
   a minor bump for them. The script updates all four version files.
3. Commit the version files, push the branch, and open a pull request. Merge after
   CI passes. Do not create the release tag yourself.
4. Return to `main`, pull with `--ff-only`, and install with
   `pnpm install --frozen-lockfile`. The checkout must be clean and pushed.

The optional **Bump version** Action pushes a commit directly to its selected
branch. With protected `main`, prefer the PR procedure above; do not weaken
branch protection to accommodate that shortcut.

## Validate and create a draft

```sh
pnpm typecheck
pnpm test
pnpm build
python3 scripts/check-version.py
pnpm release
```

The release script checks versions, pushed commit, architecture, credentials,
and duplicate releases; builds and signs the app; notarises the app and DMG;
checks signatures; and uploads a draft targeting the exact built commit.
It includes the DMG, updater archive, detached updater signature, `latest.json`,
and `SHA256SUMS`. The manifest supports only `darwin-aarch64`.
Drafts do not replace the public updater feed. Do not run the release script on
unreviewed code: build scripts execute on the Mac that holds signing credentials.

## Review and publish

1. Open the draft in GitHub Releases. Edit generated notes to cover user-visible
   changes, fixes, known issues, and any migration steps. Label PRs so the release
   categories remain useful.
2. Download the draft assets as an authenticated maintainer. In their directory,
   run `shasum -a 256 -c SHA256SUMS`. Checksums detect corruption; the Apple and
   updater signatures provide separate authenticity checks.
3. Mount the downloaded DMG, install the app, and test hold/release, locked
   dictation, Escape, microphone selection, insertion into another app, and the
   optional engines affected by this release. Check permission prompts and
   preserve existing history/settings. Record the tested macOS version and chip.
4. Confirm the app version, DMG name, manifest version, archive URL, signature,
   and `darwin-aarch64` platform agree. Test on the minimum supported macOS where
   possible; a successful build on newer macOS does not verify macOS 13 support.
5. Publish the draft as a stable release and mark it latest in GitHub. This is
   the point at which users and the automatic updater can receive it.
6. Confirm the public latest-release download links work. From an older installed
   release, test **Check now**, install the update, and verify restart, history,
   and microphone/Input Monitoring/Accessibility grants. Record the outcome.

Test invalid updater signatures only with an isolated test build/feed. Never
replace the production manifest with a deliberately invalid signature.

## Failures and recovery

If a build or notarisation step fails, fix it before retrying. Nothing is
published by the script. An upload failure may leave a partial draft: inspect
it and remove the incomplete draft before rerunning for the same version.
Check whether a tag exists too; do not delete or move a published tag.

For a published regression, release a fix with a **higher** version. The updater
will not normally downgrade users. Pointing `latest` back to a known-good
release can stop further distribution, but does not repair already updated
installations. Never overwrite assets of a published version.

[Updates](updates.md) explains the trust model and update implementation.
