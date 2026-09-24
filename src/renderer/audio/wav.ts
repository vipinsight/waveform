const WAV_HEADER_BYTES = 44;

export function encodeMonoPcm16Wav(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(WAV_HEADER_BYTES + samples.length * 2);
  const view = new DataView(bytes.buffer);

  writeAscii(view, 0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, samples.length * 2, true);

  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    view.setInt16(
      WAV_HEADER_BYTES + index * 2,
      sample < 0 ? sample * 0x8000 : sample * 0x7fff,
      true,
    );
  }

  return bytes;
}

/**
 * Joins mono PCM16 WAVs into one file for Play / disk persistence.
 *
 * Phrases from one failed session become a single clip so the Transcripts
 * list can play them without juggling sidecars.
 */
export function concatMonoPcm16Wavs(clips: Uint8Array[]): Uint8Array {
  if (clips.length === 0) {
    return encodeMonoPcm16Wav(new Float32Array(0), 16_000);
  }
  if (clips.length === 1) return clips[0]!;

  const sampleRate = readSampleRate(clips[0]!);
  let pcmBytes = 0;
  for (const clip of clips) {
    if (readSampleRate(clip) !== sampleRate) {
      throw new Error("Cannot join WAVs recorded at different sample rates.");
    }
    pcmBytes += Math.max(0, clip.length - WAV_HEADER_BYTES);
  }

  const bytes = new Uint8Array(WAV_HEADER_BYTES + pcmBytes);
  const view = new DataView(bytes.buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, bytes.length - 8, true);
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, "data");
  view.setUint32(40, pcmBytes, true);

  let offset = WAV_HEADER_BYTES;
  for (const clip of clips) {
    const pcm = clip.subarray(WAV_HEADER_BYTES);
    bytes.set(pcm, offset);
    offset += pcm.length;
  }
  return bytes;
}

function readSampleRate(wav: Uint8Array): number {
  if (wav.length < WAV_HEADER_BYTES) {
    throw new Error("WAV is too short to read.");
  }
  return new DataView(wav.buffer, wav.byteOffset, wav.byteLength).getUint32(24, true);
}

function writeAscii(view: DataView, offset: number, value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    view.setUint8(offset + index, value.charCodeAt(index));
  }
}

