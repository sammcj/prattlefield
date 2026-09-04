// Deterministic 2D value noise with fractal Brownian motion.
// Used for terrain heights and vegetation placement so the map is identical every load.

const PERM_SIZE = 256
const perm = new Uint8Array(PERM_SIZE * 2)

function seedPerm(seed: number): void {
  const p = new Uint8Array(PERM_SIZE)
  for (let i = 0; i < PERM_SIZE; i++) p[i] = i
  let s = seed >>> 0
  const rand = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 0x100000000
  }
  for (let i = PERM_SIZE - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const a = p[i] ?? 0
    p[i] = p[j] ?? 0
    p[j] = a
  }
  for (let i = 0; i < PERM_SIZE * 2; i++) perm[i] = p[i % PERM_SIZE] ?? 0
}

seedPerm(1337)

function hash(x: number, y: number): number {
  const xi = x & 255
  const yi = y & 255
  return (perm[(perm[xi] ?? 0) + yi] ?? 0) / 255
}

function smooth(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10)
}

export function valueNoise(x: number, y: number): number {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = x - x0
  const fy = y - y0
  const sx = smooth(fx)
  const sy = smooth(fy)
  const n00 = hash(x0, y0)
  const n10 = hash(x0 + 1, y0)
  const n01 = hash(x0, y0 + 1)
  const n11 = hash(x0 + 1, y0 + 1)
  const nx0 = n00 + (n10 - n00) * sx
  const nx1 = n01 + (n11 - n01) * sx
  return (nx0 + (nx1 - nx0) * sy) * 2 - 1
}

export function fbm(x: number, y: number, octaves = 4, lacunarity = 2.05, gain = 0.5): number {
  let amp = 1
  let freq = 1
  let sum = 0
  let norm = 0
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise(x * freq, y * freq) * amp
    norm += amp
    amp *= gain
    freq *= lacunarity
  }
  return sum / norm
}

// Small seeded PRNG for prop placement and bot decisions that should be reproducible.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
