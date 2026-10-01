# macOS 14 build

Released builds crash at launch on macOS 14 (seen with 0.6.0 and 0.8.1).
This page says why, and how to build a disk image that runs there to send to
somebody directly. It is not a release: follow [Releasing](releasing.md) for that.

## The crash

```
Termination Reason: Namespace DYLD, Code 4 Symbol missing
Symbol not found: _OBJC_CLASS_$_MTLResidencySetDescriptor
Expected in: /System/Library/Frameworks/Metal.framework/Versions/A/Metal
```

`MTLResidencySetDescriptor` exists from macOS 15. ggml's Metal code, linked in
through llama.cpp, only uses it inside `@available(macOS 15.0, *)`, so when it
is compiled for macOS 13 the class is a weak import and the check skips it at
run time. The shipped objects were compiled for macOS 27, the build Mac's own
version, which makes the import strong: dyld refuses to start the app on any
macOS that lacks the class, before any of Waveform's code runs.

How they came to be built for 27: `tauri build` sets `MACOSX_DEPLOYMENT_TARGET`
from `minimumSystemVersion` (13.0), but `tauri dev` does not, so dev builds
compile whisper.cpp and llama.cpp for the host. Their build scripts do not
rerun when `MACOSX_DEPLOYMENT_TARGET` changes, so the release reused the dev
build's CMake output. `scripts/release.sh` now cleans both crates first.

To check a built app:

```sh
nm -um Waveform.app/Contents/MacOS/waveform | grep MTLResidencySetDescriptor
```

`weak external` is safe on macOS 14. `external` alone crashes.

## Why the build targets macOS 11

On macOS 27 with Homebrew rustc 1.92, any deployment target of 12.0 or later
links proc-macro dylibs that dyld refuses to load (`mis-aligned LINKEDIT string
pool`), so the build fails in `enumflags2` or `encoding_rs`. That includes the
13.0 that `tauri build` sets, so `release.sh` cannot build on that toolchain
either. 11.0 links cleanly, and still weak-links the macOS 15 classes.

The one-off build therefore overrides `minimumSystemVersion` to 11.0 for that
build only. The disk image says it supports macOS 11, which is harmless for
somebody on 14; Waveform's supported minimum is still macOS 13.

A newer Rust (`brew upgrade rust`) is expected to fix the linking, after which
`release.sh` builds at 13.0 again. Check that before relying on it.

## Build it

Needs the release setup from [Releasing](releasing.md): `.env.notarization`
filled in and the Developer ID certificate in the keychain. Also needs CMake:

```sh
brew install cmake
```

Then:

```sh
scripts/build-macos14-dmg.sh
```

It builds into `src-tauri/target/macos11`, away from objects built for any
other target. The script:

1. rebuilds the hotkey helper, so it is signed again;
2. builds, signs and notarises the app;
3. fails if `MTLResidencySetDescriptor` is not a weak import;
4. lays out, signs and notarises the disk image.

The image is `src-tauri/target/macos11/release/bundle/dmg/Waveform-<version>-arm64.dmg`.

Before sending it, mount it and confirm:

```sh
spctl -a -vv /Volumes/Waveform/Waveform.app
```

It should say `accepted` and `source=Notarized Developer ID`. If notarisation
reports the `waveform-hotkey` helper as unsigned, the helper was cached:
delete `dist/native/waveform-hotkey` and run the script again.

## Updates

The image keeps the normal updater feed. If a later release is built with the
old problem, the app updates itself into the same crash. Before publishing a
release, run the `nm` check above on the built app.
