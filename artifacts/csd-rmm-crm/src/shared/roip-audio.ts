/** G.711 µ-law helpers used by both the browser bridge and focused tests. */
export function pcm16ToMulaw(sample: number): number {
  const BIAS = 0x84;
  const CLIP = 32635;
  let pcm = Math.max(-32768, Math.min(32767, Math.round(sample)));
  const sign = pcm < 0 ? 0x80 : 0;
  if (pcm < 0) pcm = -pcm;
  pcm = Math.min(pcm, CLIP) + BIAS;
  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && (pcm & mask) === 0; mask >>= 1) exponent--;
  const mantissa = (pcm >> (exponent + 3)) & 0x0f;
  return (~(sign | (exponent << 4) | mantissa)) & 0xff;
}

export function mulawToPcm16(value: number): number {
  const ulaw = (~value) & 0xff;
  const sign = ulaw & 0x80;
  const exponent = (ulaw >> 4) & 0x07;
  const mantissa = ulaw & 0x0f;
  const magnitude = ((mantissa << 3) + 0x84) << exponent;
  return sign ? 0x84 - magnitude : magnitude - 0x84;
}

export function encodeMulaw(samples: Int16Array): Uint8Array {
  const output = new Uint8Array(samples.length);
  for (let i = 0; i < samples.length; i++) output[i] = pcm16ToMulaw(samples[i]);
  return output;
}

export function decodeMulaw(samples: Uint8Array): Int16Array {
  const output = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) output[i] = mulawToPcm16(samples[i]);
  return output;
}

/** Linear resampling is intentionally state-free; callers provide complete audio blocks. */
export function resamplePcm(input: Float32Array, inputRate: number, outputRate = 8000): Int16Array {
  if (!input.length || inputRate <= 0 || outputRate <= 0) return new Int16Array();
  const outputLength = Math.max(1, Math.round(input.length * outputRate / inputRate));
  const output = new Int16Array(outputLength);
  const ratio = inputRate / outputRate;
  for (let i = 0; i < outputLength; i++) {
    const position = i * ratio;
    const left = Math.min(input.length - 1, Math.floor(position));
    const right = Math.min(input.length - 1, left + 1);
    const fraction = position - left;
    const value = input[left] + (input[right] - input[left]) * fraction;
    output[i] = Math.max(-32768, Math.min(32767, Math.round(value * 32767)));
  }
  return output;
}