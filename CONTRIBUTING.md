# Contributing

Issues and pull requests are welcome.

## Two things that catch people out

**You need your own Apple developer team to build.** macOS ties Accessibility
and Input Monitoring to the code signature, so `pnpm app` signs with a real
certificate. The default team is this project's, which you will not have, and
the build stops with an error rather than signing ad-hoc. Set
`WAVEFORM_SIGN_TEAM` to your own team id:

```bash
security find-identity -v -p codesigning
WAVEFORM_SIGN_TEAM=YOURTEAMID pnpm app
```

**`pnpm test` spans two languages.** TypeScript and Rust both run, and both
have to pass. `pnpm test:ui` and `pnpm test:rust` narrow it while you work.

[docs/building.md](docs/building.md) has the rest of the toolchain.

## What is in scope

Waveform's premise is that audio stays on this Mac. A change that sends audio
anywhere is not a feature this app can take, however good it is.

Text is different. AI Polish already leaves the machine, and does so only when
pressed — that is the line: a request the user made, not one the app decided to
make. The update check is the single exception, which is why it can be switched
off.

For anything large, open an issue before writing it. A dictation path touches a
webview, a Rust host, a Swift helper and whatever app has focus, so the shape of
a change matters more than its size.

## Reporting a bug

The issue template asks for the version, your macOS and Mac, the engine, and
which of the three permissions are granted. Those four answers resolve most
reports on their own, so it is worth filling them in rather than describing the
symptom alone.

Logs are in **Settings → Logs**. Transcribed text can appear in them, so read
before pasting.

## Testing a change

Dictation resists automated testing — it crosses a webview, a Rust host, a Swift
helper and another app's text field. Unit tests cover what they can; the rest
needs you to dictate into a real app and say so in the pull request.

Worth exercising by hand when you touch the dictation path:

- Hold, speak, release
- Double-tap to lock, speak, press to stop
- `esc` mid-phrase
- A dictation while another app has focus

## Style

Match what is there. The code explains why rather than what, and comments
record the constraint that forced a decision — not a summary of the line below.
Commit messages are written the same way.
