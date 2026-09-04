const MAX_CHARS = 140
const MAX_DISTANCE = 80
// Half-volume point tuned so 60 m lands near 0.15.
const HALF_VOLUME_DISTANCE = 25
// Chrome occasionally leaves `speaking` stuck true after an interrupted utterance.
const STUCK_MS = 15000

interface SpeakOpts {
  distance?: number
  priority?: boolean
}

interface Profile {
  readonly voice: SpeechSynthesisVoice | null
  readonly pitch: number
  readonly rate: number
}

function fnv1a(text: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h
}

function volumeFor(distance: number): number {
  const r = distance / HALF_VOLUME_DISTANCE
  // Boosted so nearby speech competes with gunfire; the API clamps at 1.0.
  return Math.min(1, 1.15 / (1 + r * r))
}

// Tiers are merged until the pool has some variety, so a system with a single
// en-AU voice still gets a spread of accents across speakers.
function buildPool(all: readonly SpeechSynthesisVoice[]): SpeechSynthesisVoice[] {
  const lang = (v: SpeechSynthesisVoice): string => v.lang.toLowerCase().replace('_', '-')
  const tiers: ((v: SpeechSynthesisVoice) => boolean)[] = [
    (v) => lang(v).startsWith('en-au'),
    (v) => lang(v).startsWith('en-gb') || lang(v).startsWith('en-us'),
    (v) => lang(v).startsWith('en'),
    () => true,
  ]
  const pool: SpeechSynthesisVoice[] = []
  for (const match of tiers) {
    for (const v of all) {
      if (match(v) && !pool.includes(v)) pool.push(v)
    }
    if (pool.length >= 3) break
  }
  return pool
}

export class Voice {
  enabled: boolean
  private readonly synth: SpeechSynthesis | null
  private pool: SpeechSynthesisVoice[] = []
  private readonly profiles = new Map<string, Profile>()
  private current: SpeechSynthesisUtterance | null = null
  private startedAt = 0

  constructor() {
    this.synth = typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null
    this.enabled = this.synth !== null
    if (!this.synth) return
    this.loadVoices()
    this.synth.addEventListener('voiceschanged', () => this.loadVoices())
  }

  speak(speaker: string, text: string, opts: SpeakOpts = {}): boolean {
    const synth = this.synth
    if (!this.enabled || !synth) return false
    const distance = Math.max(0, opts.distance ?? 0)
    if (distance > MAX_DISTANCE) return false

    const line = text.trim().slice(0, MAX_CHARS).trimEnd()
    if (line.length === 0) return false

    if (this.busy()) {
      if (!opts.priority) return false
      this.cancel()
    }

    const profile = this.profileFor(speaker)
    const u = new SpeechSynthesisUtterance(line)
    if (profile.voice) {
      u.voice = profile.voice
      u.lang = profile.voice.lang
    }
    u.pitch = profile.pitch
    u.rate = profile.rate
    u.volume = volumeFor(distance)
    const done = (): void => {
      if (this.current === u) this.current = null
    }
    u.onend = done
    u.onerror = done

    this.current = u
    this.startedAt = performance.now()
    synth.speak(u)
    return true
  }

  cancel(): void {
    if (!this.synth) return
    this.current = null
    this.synth.cancel()
  }

  private busy(): boolean {
    if (!this.synth) return false
    if (this.current === null && !this.synth.speaking && !this.synth.pending) return false
    if (performance.now() - this.startedAt > STUCK_MS) {
      this.cancel()
      return false
    }
    return true
  }

  private loadVoices(): void {
    if (!this.synth) return
    const all = this.synth.getVoices()
    if (all.length === 0) return
    this.pool = buildPool(all)
    // Voice objects from before the reload may be stale, so speakers get re-cast on next line.
    this.profiles.clear()
  }

  private profileFor(speaker: string): Profile {
    const cached = this.profiles.get(speaker)
    if (cached) return cached
    const h = fnv1a(speaker)
    const h2 = fnv1a(speaker, 0x9747b28c)
    const voice = this.pool.length > 0 ? (this.pool[h % this.pool.length] ?? null) : null
    const profile: Profile = {
      voice,
      pitch: 0.7 + ((h >>> 8) % 1000) / 1000 * 0.6,
      rate: 0.95 + ((h2 >>> 8) % 1000) / 1000 * 0.3,
    }
    // Only cache once voices have loaded, otherwise the null voice would stick after voiceschanged.
    if (this.pool.length > 0) this.profiles.set(speaker, profile)
    return profile
  }
}
