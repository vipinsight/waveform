# Stopping macOS ducking other apps while the microphone is open

Status: done, pending confirmation on a real machine. 2026-09-07.

## The problem

Whatever you were listening to got quieter for as long as Waveform held the
microphone. It was not Waveform lowering anything: macOS does it, because
asking for `echoCancellation` reaches for the voice-processing audio unit, and
that unit exists for calls -- where ducking the far end is the point.

Dictation is not a call. There is no far-end echo to cancel, so the ducking
bought nothing.

## Why the obvious fix failed the first time

`echoCancellation: false` while keeping `noiseSuppression` and
`autoGainControl` was tried, and dictation stopped producing anything at all.

WebKit serves all three from that one unit and only reaches for it when echo
cancellation is requested, so asking for the other two alone asks for nothing.
The stream became raw -- and `SpeechSegmenter` judged speech against a fixed
`0.014` RMS threshold calibrated against a suppressed, gain-controlled stream.
An unsuppressed room floor sits above that, so every block read as speech, no
phrase ever ended at a pause, and the segmenter behaved as though someone were
talking continuously.

The constraints and the threshold were one decision spread across two files,
and only one of them moved.

## What was done

1. The threshold is measured rather than fixed: three times the room's own
   floor, with an absolute minimum so a muted microphone cannot make phrases
   out of its own noise. The floor is learned from silence between phrases, and
   a 250ms window listens before anything counts as speech -- otherwise a noisy
   room's first blocks read as speech and the floor never rises. Those samples
   go to the pre-roll, which is longer than the window, so a phrase that
   started immediately keeps its first word.
2. All three constraints are now off. The stream is a plain input: no ducking,
   and no gain control or suppression between the microphone and the engines.

## What is still open

Whether raw audio actually transcribes better. It should -- suppression smears
consonants, and both engines normalise level themselves, which was measured:
lifting a phrase's peak from 0.088 to 0.9 changed neither engine's output at
all. But it is a claim about audio quality, not about code, and the only test
is dictating into it.

If accuracy is no better, the remaining lever is the model rather than the
signal: Whisper Small and Parakeet 0.6B produced identical transcripts on the
same phrase, which is the signature of the audio being read faithfully and the
model simply being small. `ggml-medium.bin` is the next size up and the
download machinery already exists.

## How to know it worked

Play music, hold the dictation key, and listen. The music must not change
volume. Then dictate a short phrase and a long one with a pause in the middle,
and confirm both come back -- the pause is what the threshold decides, and it
is the thing a change here breaks.
