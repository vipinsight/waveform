/**
 * Reads the microphone on the audio thread.
 *
 * This exists because its predecessor, a ScriptProcessorNode, runs its
 * callback on the main thread -- the same thread drawing the meter every
 * frame. Under that load the callbacks are late or missed, and a missed
 * callback is not a glitch you hear: it is a block spliced out of the middle
 * of a sentence. The WAV that reaches the engine still looks well formed, so
 * the engine transcribes it confidently and returns the wrong words. Enough of
 * them in a row and nothing comes back at all.
 *
 * An AudioWorkletProcessor runs on the audio rendering thread, which cannot be
 * starved by anything the window is doing.
 *
 * Plain JavaScript, and copied into dist/renderer as it is: `addModule` fetches
 * this file at run time, so it is never part of either bundle.
 */

/**
 * Frames per message. The processor is called with 128 at a time, and one
 * message per quantum would be several hundred postMessage calls a second for
 * no benefit -- the segmenter measures loudness over a window, and 2048 is the
 * window the thresholds were tuned against.
 */
const BLOCK = 2048;

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(BLOCK);
    this.filled = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    // No input yet, or the track ended. Staying alive is what lets the node be
    // reused when the microphone comes back.
    if (!input) return true;

    let offset = 0;
    while (offset < input.length) {
      const take = Math.min(BLOCK - this.filled, input.length - offset);
      this.block.set(input.subarray(offset, offset + take), this.filled);
      this.filled += take;
      offset += take;

      if (this.filled === BLOCK) {
        // A copy: this buffer is written again on the next quantum, and the
        // message is read on another thread.
        this.port.postMessage(this.block.slice());
        this.filled = 0;
      }
    }

    return true;
  }
}

registerProcessor("capture", CaptureProcessor);
