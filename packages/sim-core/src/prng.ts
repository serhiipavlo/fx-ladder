// Seeded PRNG for the market model: xoshiro128** (Blackman–Vigna) — fast,
// statistically solid, 128 bits of state that serializes to four uint32s, so a
// stream can be reproduced from any point, not only from the start
// (architecture §5.1). Not cryptographic, deliberately: reproducibility is the
// requirement, secrecy is not.

/** Four uint32 words; the full generator state (architecture §5.1). */
export type PrngState = readonly [number, number, number, number];

export interface Prng {
  /** Next value as uint32. */
  nextUint32(): number;
  /** Next value in [0, 1). */
  nextFloat(): number;
  /** Snapshot of the current state — feed to prngFromState to continue the stream. */
  state(): PrngState;
}

const UINT32_RANGE = 2 ** 32;

function isUint32(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n <= 0xffff_ffff;
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

// splitmix32 — the standard seed expander: stirs one uint32 into a stream of
// well-mixed words so nearby seeds do not produce correlated xoshiro states.
function splitmix32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x9e37_79b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x21f0_aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a_2d97) >>> 0;
    return (z ^ (z >>> 15)) >>> 0;
  };
}

function fromWords(w0: number, w1: number, w2: number, w3: number): Prng {
  let s0 = w0 >>> 0;
  let s1 = w1 >>> 0;
  let s2 = w2 >>> 0;
  let s3 = w3 >>> 0;

  function nextUint32(): number {
    const result = (Math.imul(rotl(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0);
    const t = (s1 << 9) >>> 0;
    s2 = (s2 ^ s0) >>> 0;
    s3 = (s3 ^ s1) >>> 0;
    s1 = (s1 ^ s2) >>> 0;
    s0 = (s0 ^ s3) >>> 0;
    s2 = (s2 ^ t) >>> 0;
    s3 = rotl(s3, 11);
    return result;
  }

  return {
    nextUint32,
    nextFloat: () => nextUint32() / UINT32_RANGE,
    state: () => [s0, s1, s2, s3],
  };
}

/** Deterministic generator from a uint32 seed. */
export function xoshiro128(seed: number): Prng {
  if (!isUint32(seed)) throw new Error(`seed must be a uint32, got ${seed}`);
  const mix = splitmix32(seed);
  let w0 = mix();
  const w1 = mix();
  const w2 = mix();
  const w3 = mix();
  // xoshiro is undefined on the all-zero state; unreachable via splitmix in
  // practice, but the guard keeps the constructor total.
  if ((w0 | w1 | w2 | w3) === 0) w0 = 0x9e37_79b9;
  return fromWords(w0, w1, w2, w3);
}

/** Resume a generator from a serialized state snapshot. */
export function prngFromState(state: PrngState): Prng {
  if (state.length !== 4 || !state.every(isUint32)) {
    throw new Error(`state must be four uint32 words, got ${JSON.stringify(state)}`);
  }
  const [w0, w1, w2, w3] = state;
  if ((w0 | w1 | w2 | w3) === 0) throw new Error('all-zero state is not a valid xoshiro state');
  return fromWords(w0, w1, w2, w3);
}
