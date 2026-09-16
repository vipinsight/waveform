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
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp) running any Whisper size — **the default** | Linked into the app. No interpreter, no separate process, and the weights stay loaded between phrases. |
| [`nvidia/parakeet-tdt-0.6b-v3`](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) | NVIDIA's NeMo Metal runtime. Optional. |
| [`Qwen/Qwen3-ASR-0.6B`](https://huggingface.co/Qwen/Qwen3-ASR-0.6B) | Its own Python runtime. Optional. |

**Settings → Models** says what is on this Mac and what is not. A filled row is
downloaded; an outlined one with a cloud beside it is not, and pressing it
fetches the weights. The two engines the app cannot fetch show a prompt instead,
with the command to run.
Only whisper.cpp can be set up without a terminal, which is why it is the
default — an install from the disk image cannot assume one. Because it is linked
in, every size and quantization of Whisper is one press away, and the models
page marks the one **recommended** for the Mac it is running on.

Qwen3-ASR takes roughly 20–40 seconds to load the first time. Parakeet is
quicker once its runtime is warm.

## Choosing a Whisper size

The models page lists every size at once. Each row carries the four things the
choice turns on: the share of words the model gets wrong, from the figure its
Hugging Face page publishes on LibriSpeech test-clean; the size of the download;
the memory it holds while loaded; and an arrow beside the name out to the page
those came from.

Two things separate them. Bigger weights hear accents, proper nouns and
technical words that smaller ones guess at. And a quantized model — the `Q5`
rows — stores each weight in five bits instead of sixteen, which cuts memory by
roughly half for a small loss of accuracy, so it is how a larger model fits in a
smaller Mac.

Speeds below are relative to Small, which transcribes eleven seconds of speech
in under half a second on an M1 Pro. Memory is what the model adds to the app
while it is loaded, and it is approximate.

| Model | Download | Memory | Speed | Good for |
| --- | --- | --- | --- | --- |
| Tiny | 78 MB | ~250 MB | ~4× faster | Short commands where a wrong word is obvious |
| Base | 148 MB | ~350 MB | ~2× faster | The smallest model worth dictating sentences to |
| **Small** | 488 MB | ~800 MB | baseline | The accuracy floor for text you do not reread. The default |
| Small · Q5 | 190 MB | ~440 MB | about the same | Small on a Mac that cannot spare 800 MB |
| Medium | 1.5 GB | ~2.1 GB | ~3× slower | Accents and jargon Small gets wrong |
| Medium · Q5 | 539 MB | ~1.1 GB | ~3× slower | Most of Medium's accuracy in half the memory |
| **Large v3 Turbo** | 1.6 GB | ~2.2 GB | ~2× slower | The best trade here: near Large v3's accuracy, nowhere near its cost |
| Large v3 Turbo · Q5 | 574 MB | ~1.2 GB | ~2× slower | Turbo on a 16 GB Mac |
| Large v3 · Q5 | 1.1 GB | ~1.8 GB | ~5× slower | The most accurate weights under 2 GB |
| Large v3 | 3.1 GB | ~3.8 GB | ~6× slower | When accuracy matters more than waiting |

The **English only** group is the same sizes trained on English alone. Each is
more accurate than its multilingual twin at the same memory — Base · English is
close to multilingual Small — and useless for anything else, so it is never the
recommended model. Pick one deliberately, and only if you never dictate in
another language.

### What to run on which Mac

Waveform reads how much memory the Mac has and marks the most capable
multilingual Whisper that fits in an eighth of it. That eighth is the point:
these weights stay resident between phrases, so a model that merely *fits* is
one that pushes everything else towards swap while you are not even dictating.
A row saying **tight on this Mac** will still run, and will still be the largest
thing on the machine.

| This Mac | Recommended | If you want more |
| --- | --- | --- |
| 8 GB | Small | Medium · Q5, or Small · English if you only dictate English |
| 16 GB | Large v3 Turbo · Q5 | Large v3 Turbo, at about 2.2 GB resident |
| 24 GB or more | Large v3 Turbo | Large v3, if you would rather wait than reread |

Large v3 is never the recommendation. Turbo comes within a hair of its accuracy
at a fraction of the time, and for dictation — where the wait is in front of you
— that is the better trade.

Any Apple Silicon Mac runs any of these; the chip decides how long you wait, not
whether it works. A model that has to be paged in from disk on every phrase is
the one bad case, and it is what the memory advice above avoids.

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
| **Clean up dictation** | Tidies every phrase before inserting it. Removes filler, pauses and corrections, formats spoken lists as bullets, and leaves the wording alone. Costs a round trip per phrase. |
| **Polish shortcut** (`⌥1`) | Tidies whatever text is selected in the focused app, in place, without rewriting it. |

Both run on system prompts you can edit, with **Reset** to restore the defaults.
Pick any OpenRouter model id; the field suggests a few fast ones.

Pressing polish on the indicator tidies that dictation even when **Clean up
dictation** is switched off. After you stop speaking, the pill gathers into a
circle with a spinner — blue while polish runs, grey while it only transcribes.

Polishing has to copy the selection to read it, since no API exposes another
app's selection, so it needs Accessibility. Your clipboard is restored
afterwards.

## Living in the menu bar

Closing the window does not quit Waveform — the shortcut keeps working with
nothing on screen, and the Dock or menu bar icon brings the window back.
**Settings → General** can drop the app out of the Dock entirely while the
window is closed, leaving only the menu bar icon.

The icon's menu carries **Model** and **Microphone** submenus, so switching
either takes one gesture and no window. **Model** lists the whole catalogue
under the same headings the models page uses; a model that still needs a
download or a terminal is listed greyed out, because the menu bar can switch
between models that are here and the window is where models arrive.

With **Start with login** enabled, Waveform starts in the background after you
log in, including after a restart, with its window hidden and dictation ready.
Launching it by hand always opens the window.

## Updates

Waveform checks twenty seconds after launch and once a day after that. An update
downloads with progress and restarts the app into itself.

That check is the only request Waveform makes that you did not ask for, so
**Settings → General** can switch it off. **Settings → About → Check for
Updates** still works with it off — the switch is about unprompted requests,
and pressing the button is the prompt.

[updates.md](updates.md) covers how a release reaches an installed copy.
