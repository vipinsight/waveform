# Stopping macOS ducking other apps while the microphone is open

Status: open. One attempt made and reverted on 2026-09-07.

## The problem

Whatever you were listening to gets quieter for as long as Waveform holds the
microphone. It is not Waveform lowering anything: macOS does it, because the app
asks for the voice-processing audio unit, and that unit exists for calls -- where
ducking the far end is the point.

Dictation is not a call. There is no far-end echo to cancel, so the ducking buys
nothing.

## What was tried

`echoCancellation: false` in [capture.ts](../../src/renderer/audio/capture.ts),
keeping `noiseSuppression` and `autoGainControl` on. Dictation stopped producing
anything at all -- held the key, spoke, released, and nothing arrived.

Why: WebKit provides all three from the same voice-processing IO unit, and it
only reaches for that unit when `echoCancellation` is requested. Asking for the
other two without it is asking for nothing. The constraints are one decision.

So the choice inside `getUserMedia` is the voice-processing unit with its
ducking, or a plain input with no gain control and no suppression -- and the
segmenter's fixed `0.014` RMS threshold is calibrated against a suppressed,
gain-controlled stream, so it does not survive the second option unchanged.

## What would actually have to happen

Any real fix means not asking WebKit for the microphone at all, or not caring
what it does with it:

- **Capture outside the webview.** `HotkeyHelper.swift` is already a separate
  process doing what no web API can, and it already speaks newline-delimited
  JSON over stdio. A Swift capture path could open a plain `AVAudioEngine` input
  with no voice processing, which does not duck, and hand frames across. That
  moves the segmenter's calibration problem along with it: it would need a
  measured noise floor rather than the current fixed one, because there would be
  no suppression to calibrate against.
- **Measure the floor instead of assuming it.** Worth doing either way. A
  threshold derived from the quietest recent chunks, with a hard minimum, would
  make the segmenter survive an unsuppressed stream -- and would then let
  `echoCancellation: false` be tried again on its own merits.

The second is the smaller piece and unblocks the first. Neither is started.

## How to know it worked

Play music, hold the dictation key, and listen. The music must not change volume.
Then dictate a short phrase and a long one with a pause in the middle, and
confirm both come back -- the pause is what the threshold decides, and it is the
thing a change here breaks.
