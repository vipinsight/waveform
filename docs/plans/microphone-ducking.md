# Stopping macOS ducking other apps while the microphone is open

Status: open. Two attempts, both reverted. Last measured 2026-09-07.

## The problem

Whatever you are listening to gets quieter for as long as Waveform holds the
microphone. It is not Waveform lowering anything: macOS does it, because asking
for `echoCancellation` reaches for the voice-processing audio unit, and that
unit exists for calls -- where ducking the far end is the point.

Dictation is not a call. There is no far-end echo to cancel.

## Why the getUserMedia flags cannot fix it

WebKit serves `echoCancellation`, `noiseSuppression` and `autoGainControl` from
that one unit, and only reaches for it when echo cancellation is requested. So
there are two options and no third: the unit with its ducking, or a plain input
with none of the three.

**First attempt.** `echoCancellation: false` with the other two left on. Nothing
was transcribed at all. Asking for the other two alone asks for nothing, and
`SpeechSegmenter` was judging speech against a fixed `0.014` RMS threshold
calibrated for a suppressed, gain-controlled stream.

**The threshold was then fixed properly** -- measured from the room rather than
fixed, which is worth having whatever happens here.

**Second attempt.** All three off, with the measured threshold in place. Still
nothing, and this time the log said why:

```
capture session closed: 74 blocks, peak 0.0036, threshold 0.0040, 0 phrase(s)
```

Peak `0.0036` is the loudest block of the whole session. The same voice through
the voice-processing unit measures `0.088` -- about twenty-five times louder.
That is not a threshold that can be tuned around: raw speech from this built-in
microphone sits level with a muted microphone's own noise, so any threshold low
enough to hear it would also hear silence.

The conclusion is that `autoGainControl` is doing real work on this hardware,
not merely accompanying the ducking. Both attempts are reverted.

## What is left

Capture outside the webview, where the gain is ours to set.
`HotkeyHelper.swift` is already a separate process doing what no web API can,
speaking newline-delimited JSON over stdio. A Swift capture path could open a
plain `AVAudioEngine` input -- which does not duck -- and apply its own gain
before handing frames across. The measured floor already in the segmenter is
what makes an unsuppressed stream survivable once it is loud enough to hear.

That is a real piece of work, and it is the only route left. Nothing in
`getUserMedia` will do it.

## How to know it worked

Play music, hold the dictation key, and listen. The music must not change
volume. Then check the log: a session's peak wants to be somewhere near `0.05`,
and phrases have to come back from a short utterance and from a long one with a
pause in the middle.
