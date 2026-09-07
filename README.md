# Waveform

Hold a key anywhere in macOS, speak, release. The text lands in whatever you
were typing into.

Transcription runs on this Mac. No audio leaves it.

Requires an Apple Silicon Mac on macOS 13 or newer.

## Install

1. Download the disk image from [the latest release](https://github.com/vipiny35/waveform/releases/latest).
2. Drag Waveform to Applications and open it. It is signed and notarised, so
   there is no "unidentified developer" detour.
3. Open **Settings → Models** and press Download. The default engine ships
   inside the app; only its weights are missing.
4. Open **Settings → Setup** and grant the three permissions listed there.

macOS will not grant those on Waveform's behalf, and the Setup page updates
while you are still in System Settings:

| Permission | Why |
| --- | --- |
| Microphone | Hear you |
| Input Monitoring | See the trigger key while another app is focused |
| Accessibility | Paste into the focused app |

If you keep the default **Fn** trigger, also set **System Settings → Keyboard →
Press 🌐 to** to **Do Nothing**. Otherwise tapping it switches input source too.

## Dictate anywhere

Put the cursor in any text field — Mail, a browser, a terminal — and:

| Gesture | What happens |
| --- | --- |
| Hold the key, speak, release | Transcribes and pastes it |
| Double-tap the key | Keeps listening until you press the key again |
| Press the key again while locked | Stops listening and inserts what was said |
| `esc` | Cancels; the unfinished phrase is dropped |

Text arrives when you stop speaking, not while you are still going, so a
sentence never lands half-written in whatever you happened to click on.

A small indicator appears while the microphone is open, carrying cancel on the
left and polish on the right. Drag it anywhere; the position is remembered.

The default trigger is **Fn**. **Settings → Dictation** offers Right or Left ⌘,
⌥, ⌃, and Right ⇧ instead.

## Models

| Engine | How it runs |
| --- | --- |
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp) running Whisper `small` — **the default** | Linked into the app. No interpreter, no separate process, and the weights stay loaded between phrases. |
| [`nvidia/parakeet-tdt-0.6b-v3`](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) | NVIDIA's NeMo Metal runtime. Optional. |
| [`Qwen/Qwen3-ASR-0.6B`](https://huggingface.co/Qwen/Qwen3-ASR-0.6B) | Its own Python runtime. Optional. |

whisper.cpp transcribes eleven seconds of speech in under half a second on an
M1 Pro. The optional engines need a terminal to install and **Settings → Models**
says what each is missing. See [docs/models.md](docs/models.md).

The engine is not loaded until your first dictation, so an idle Waveform costs
about 140 MB rather than several hundred.

## Privacy

Audio is never written to disk, and never leaves this Mac.

Two things do leave, both listed here so neither is a surprise:

- **AI Polish**, when you press it or switch it on. Text only.
- **The update check**, which you can turn off.

The only thing Waveform writes down is your dictation history, in
`~/Library/Application Support/Waveform/history.json`, readable only by you and
capped at the most recent 300 entries. The **Transcripts** view can copy,
delete, or clear it.

## AI Polish

Optional rewriting through [OpenRouter](https://openrouter.ai). Paste a key into
**Settings → AI Polish** and it goes to your login keychain, never to a file
Waveform owns, and is never handed back to the interface.

| Feature | What it does |
| --- | --- |
| **Clean up dictation** | Rewrites every phrase before inserting it. Removes filler, fixes grammar, costs a round trip. |
| **Polish shortcut** (`⌥1`) | Rewrites whatever is selected in the focused app, in place. |

Both run on system prompts you can edit. Polishing has to copy the selection to
read it, since no API exposes another app's selection, so it needs
Accessibility. Your clipboard is restored afterwards.

## Living in the menu bar

Closing the window does not quit Waveform — the shortcut keeps working with
nothing on screen. **Settings → General** can drop it out of the Dock entirely
while the window is closed, leaving only the menu bar icon.

With **Start with login** enabled it starts hidden in the background, dictation
ready, after you log in.

## Updates

Waveform checks twenty seconds after launch and once a day after that. An
update downloads with progress and restarts the app into itself.

That check is the only request Waveform makes that you did not ask for, so
**Settings → General** can turn it off. **Check now** still works with it off.

See [docs/updates.md](docs/updates.md).

## Build from source

```bash
pnpm install
WAVEFORM_SIGN_TEAM=YOURTEAMID pnpm app
```

You need your own Apple developer team, because macOS ties Accessibility and
Input Monitoring to the code signature. [docs/building.md](docs/building.md)
covers the toolchain, the optional engines, the commands, and why the bundle is
assembled by hand.

## How it is put together

The interface, audio capture and segmentation run in a WebKit webview and talk
to a Rust host through `window.waveform`. Audio never crosses into Rust; only
finished WAV segments do.

Rust owns what the page cannot do for itself: the speech engines, the dictation
state machine, the overlay window, the global shortcuts, the OpenRouter calls
and the keychain.

`src/native/HotkeyHelper.swift` is neither. No API lets an app see Fn pressed
while another app is frontmost, or type into one — that needs a `CGEventTap` and
synthetic `CGEvent`s, so it is a separate process speaking newline-delimited
JSON over stdio.

## Contributing

Issues and pull requests are welcome — [CONTRIBUTING.md](CONTRIBUTING.md) has
what you need.

One thing to know before a large pull request: Waveform's premise is that audio
stays on this Mac. A change that sends audio anywhere is not a feature this app
can take, however good it is. Text is different.

## Support

Waveform is free. If it saved you some typing, you can
[buy me a coffee](https://buymeacoffee.com/vip_iny).
