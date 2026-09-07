# Using Waveform

`README.md` covers what Waveform is and how to install it. This is everything
it does once installed.

## Dictating

Put the cursor in any text field and:

| Gesture | What happens |
| --- | --- |
| Hold the key, speak, release | Transcribes and types it in |
| Double-tap the key | Keeps listening until you press the key again |
| Press the key again while locked | Stops listening and inserts what was said |
| `esc` | Cancels; the unfinished phrase is dropped |

Text arrives when you stop speaking, not while you are still going, so a
sentence never lands half-written in whatever you happened to click on. Long
pauses still split the audio internally — that is what keeps transcription
accurate — but the pieces are joined and delivered together.

A small indicator appears while the microphone is open, so an open microphone is
never a surprise. It carries cancel on the left and polish on the right, never
takes focus from the app you are typing into, and can be dragged anywhere; the
position is remembered. **Settings → General** has **Show** to summon it and
**Reset** to put it back.

## The trigger key

The default is **Fn**. **Settings → Dictation** offers Right or Left ⌘, ⌥ and
⌃, or Right ⇧ instead.

If you keep **Fn**, set **System Settings → Keyboard → Press 🌐 to** to **Do
Nothing**. Otherwise tapping it switches input source at the same time.

## Permissions

**Settings → Setup** lists everything dictation depends on with its live state
and a button that opens the right pane. It updates while you are still in System
Settings, so a grant takes effect without restarting the app.

| Permission | Why it is needed |
| --- | --- |
| Microphone | To hear you |
| Input Monitoring | To see the trigger key while another app is focused |
| Accessibility | To type the text into the focused app |

Neither of the last two can be granted programmatically, and macOS ties both to
the app's code signature. A grant can therefore look ticked in System Settings
while the app is still refused — if the permissions were first given to a
differently signed build, remove Waveform from both lists and add it again once.

## Choosing an engine

| Engine | How it runs |
| --- | --- |
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp) running Whisper `small` — **the default** | Linked into the app. No interpreter, no separate process, and the weights stay loaded between phrases. |
| [`nvidia/parakeet-tdt-0.6b-v3`](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) | NVIDIA's NeMo Metal runtime. Optional. |
| [`Qwen/Qwen3-ASR-0.6B`](https://huggingface.co/Qwen/Qwen3-ASR-0.6B) | Its own Python runtime. Optional. |

**Settings → Models** shows what each engine is missing: a Download button where
the app can fetch the weights itself, and the command to run where it cannot.
Only whisper.cpp can be set up without a terminal, which is why it is the
default — an install from the disk image cannot assume one.

Qwen3-ASR takes roughly 20–40 seconds to load the first time. Parakeet is
quicker once its runtime is warm. whisper.cpp transcribes eleven seconds of
speech in under half a second on an M1 Pro.

The engine is not loaded until your first dictation, so an idle Waveform costs
about 140 MB rather than several hundred. The status bar shows live CPU and
memory for the app and the engine together, since the engine is the larger
consumer of both.

## Transcripts

The **Transcripts** view keeps every dictation, newest first, with when it was
said and how long it was. Each one can be copied or deleted, and the whole list
cleared. It holds the most recent 300 and is readable only by you.

## AI Polish

Optional rewriting through [OpenRouter](https://openrouter.ai). This is the one
feature that sends anything off the Mac, it sends text rather than audio, and it
runs only when you ask.

Paste a key into **Settings → AI Polish**. It goes to your login keychain as a
generic password under `com.webtiara.waveform`, never to a file Waveform owns,
and is never handed back to the interface — the screen can report that a key
exists and replace it, but cannot read it.

| Feature | What it does |
| --- | --- |
| **Clean up dictation** | Rewrites every phrase before inserting it. Removes filler, fixes grammar, costs a round trip per phrase. |
| **Polish shortcut** (`⌥1`) | Rewrites whatever text is selected in the focused app, in place. |

Both run on system prompts you can edit, with **Reset** to restore the defaults.
Pick any OpenRouter model id; the field suggests a few fast ones.

Pressing polish on the indicator rewrites that dictation even when **Clean up
dictation** is switched off. While it runs, the meter becomes a progress row and
the button becomes a loader ring.

Polishing has to copy the selection to read it, since no API exposes another
app's selection, so it needs Accessibility. Your clipboard is restored
afterwards.

## Living in the menu bar

Closing the window does not quit Waveform — the shortcut keeps working with
nothing on screen, and the Dock or menu bar icon brings the window back.
**Settings → General** can drop the app out of the Dock entirely while the
window is closed, leaving only the menu bar icon.

With **Start with login** enabled, Waveform starts in the background after you
log in, including after a restart, with its window hidden and dictation ready.
Launching it by hand always opens the window.

## Updates

Waveform checks twenty seconds after launch and once a day after that. An update
downloads with progress and restarts the app into itself.

That check is the only request Waveform makes that you did not ask for, so
**Settings → General** can switch it off. **Check now** still works with it off
— the switch is about unprompted requests, and pressing the button is the
prompt.

[updates.md](updates.md) covers how a release reaches an installed copy.
