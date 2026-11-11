/**
 * The loudest sample in each of `buckets` equal slices of a WAV, 0 to 1, for
 * drawing a recording's whole length as a waveform. Reads the RIFF chunks
 * rather than assuming a 44-byte header, and takes 16-bit PCM or 32-bit float
 * with any number of channels (the loudest channel wins). Anything else gives
 * an empty array, and the caller draws a flat line.
 */
export function wavPeaks(wav: Uint8Array, buckets: number): Float32Array {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  if (wav.length < 12 || ascii(view, 0) !== "RIFF" || ascii(view, 8) !== "WAVE") return new Float32Array();

  let format = 0;
  let channels = 0;
  let bits = 0;
  let dataStart = -1;
  let dataBytes = 0;
  for (let at = 12; at + 8 <= wav.length; ) {
    const id = ascii(view, at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === "fmt " && body + 16 <= wav.length) {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      bits = view.getUint16(body + 14, true);
      // WAVE_FORMAT_EXTENSIBLE keeps the real format in its sub-format GUID.
      if (format === 0xfffe && body + 26 <= wav.length) format = view.getUint16(body + 24, true);
    } else if (id === "data") {
      dataStart = body;
      // A recording still being written can carry a size that runs past the file.
      dataBytes = Math.min(size, wav.length - body);
      break;
    }
    at = body + size + (size % 2);
  }

  const pcm16 = format === 1 && bits === 16;
  const float32 = format === 3 && bits === 32;
  if (dataStart < 0 || channels === 0 || buckets <= 0 || !(pcm16 || float32)) return new Float32Array();

  const width = bits / 8;
  const frameBytes = width * channels;
  const frames = Math.floor(dataBytes / frameBytes);
  if (frames === 0) return new Float32Array();
  const count = Math.min(buckets, frames);
  const peaks = new Float32Array(count);
  for (let bucket = 0; bucket < count; bucket += 1) {
    const from = Math.floor((bucket * frames) / count);
    const to = Math.floor(((bucket + 1) * frames) / count);
    let peak = 0;
    for (let frame = from; frame < to; frame += 1) {
      for (let channel = 0; channel < channels; channel += 1) {
        const at = dataStart + frame * frameBytes + channel * width;
        const sample = pcm16 ? view.getInt16(at, true) / 0x8000 : view.getFloat32(at, true);
        const level = Math.abs(sample);
        if (level > peak) peak = level;
      }
    }
    peaks[bucket] = Math.min(1, peak);
  }
  return peaks;
}

function ascii(view: DataView, at: number): string {
  return String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
}
