import * as THREE from 'three'
import type { SoundName } from '../types'

export interface PlayOpts {
  position?: THREE.Vector3
  volume?: number
  pitch?: number
}

// Everything routes through one slot so recipes stay declarative: they only
// describe partials relative to slot.t and never touch routing or distance.
interface Slot {
  readonly ctx: AudioContext
  readonly noise: AudioBuffer
  readonly t: number
  readonly pitch: number
  readonly out: GainNode
}

type Recipe = (s: Slot) => number

interface ToneSpec {
  freq: number
  type?: OscillatorType
  to?: number
  peak?: number
  at?: number
  attack?: number
  hold?: number
  decay?: number
  detune?: number
  dest?: AudioNode
}

interface NoiseSpec {
  peak?: number
  at?: number
  attack?: number
  hold?: number
  decay?: number
  filter?: BiquadFilterType
  freq?: number
  to?: number
  q?: number
  rate?: number
  dest?: AudioNode
}

const MAX_VOICES = 24
const DEFAULT_RANGE = 60
const RANGE: Partial<Record<SoundName, number>> = {
  smg: 120,
  lmg: 130,
  sniper: 160,
  rocket: 140,
  pistol: 100,
  rifle: 120,
  explosion: 260,
  collapse: 300,
  crash: 150,
  horn: 140,
  footstep: 40,
  jump: 40,
  land: 40,
  reload: 30,
  dryfire: 20,
  pin: 30,
  grenadeBounce: 50,
  ricochet: 90,
  impact: 70,
  enterVehicle: 50,
  death: 60,
}

const UP = new THREE.Vector3(0, 1, 0)
const tmpRight = new THREE.Vector3()
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))

function envelope(param: AudioParam, t0: number, peak: number, attack: number, hold: number, decay: number): number {
  // An exponential ramp cannot start from zero, so a short linear attack always precedes it.
  const a = Math.max(attack, 0.002)
  param.setValueAtTime(0, t0)
  param.linearRampToValueAtTime(peak, t0 + a)
  if (hold > 0) param.setValueAtTime(peak, t0 + a + hold)
  param.exponentialRampToValueAtTime(0.0005, t0 + a + hold + decay)
  return t0 + a + hold + decay
}

function tone(s: Slot, spec: ToneSpec): void {
  const { ctx } = s
  const t0 = s.t + (spec.at ?? 0)
  const osc = ctx.createOscillator()
  osc.type = spec.type ?? 'sine'
  osc.frequency.setValueAtTime(spec.freq * s.pitch, t0)
  if (spec.detune) osc.detune.value = spec.detune
  const g = ctx.createGain()
  const end = envelope(g.gain, t0, spec.peak ?? 0.5, spec.attack ?? 0, spec.hold ?? 0, spec.decay ?? 0.1)
  if (spec.to !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(1, spec.to * s.pitch), end)
  osc.connect(g).connect(spec.dest ?? s.out)
  osc.start(t0)
  osc.stop(end + 0.05)
}

function noise(s: Slot, spec: NoiseSpec): void {
  const { ctx } = s
  const t0 = s.t + (spec.at ?? 0)
  const src = ctx.createBufferSource()
  src.buffer = s.noise
  src.loop = true
  src.playbackRate.value = (spec.rate ?? 1) * s.pitch
  const g = ctx.createGain()
  const end = envelope(g.gain, t0, spec.peak ?? 0.5, spec.attack ?? 0, spec.hold ?? 0, spec.decay ?? 0.1)
  let head: AudioNode = src
  if (spec.filter) {
    const f = ctx.createBiquadFilter()
    f.type = spec.filter
    f.Q.value = spec.q ?? 1
    f.frequency.setValueAtTime((spec.freq ?? 1000) * s.pitch, t0)
    if (spec.to !== undefined) f.frequency.exponentialRampToValueAtTime(Math.max(10, spec.to * s.pitch), end)
    src.connect(f)
    head = f
  }
  head.connect(g).connect(spec.dest ?? s.out)
  // Random start offset stops simultaneous bursts phase-stacking into one louder click.
  src.start(t0, Math.random() * (s.noise.duration - 0.2))
  src.stop(end + 0.05)
}

function thump(s: Slot, freq: number, decay: number, peak: number, at = 0): void {
  tone(s, { freq, to: freq * 0.4, peak, decay, at })
}

function click(s: Slot, at: number, peak: number): void {
  noise(s, { at, filter: 'bandpass', freq: 3200, q: 3, peak, decay: 0.03 })
  tone(s, { at, type: 'square', freq: 900, peak: peak * 0.4, decay: 0.02 })
}

function lowpass(s: Slot, from: number, to: number, dur: number, q = 1): BiquadFilterNode {
  const f = s.ctx.createBiquadFilter()
  f.type = 'lowpass'
  f.Q.value = q
  f.frequency.setValueAtTime(from, s.t)
  f.frequency.exponentialRampToValueAtTime(to, s.t + dur)
  f.connect(s.out)
  return f
}

let distortionCurve: Float32Array<ArrayBuffer> | null = null
function distortion(s: Slot, amount: number): WaveShaperNode {
  if (!distortionCurve) {
    const n = 2048
    distortionCurve = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      const x = (i * 2) / n - 1
      distortionCurve[i] = ((3 + amount) * x * 20 * (Math.PI / 180)) / (Math.PI + amount * Math.abs(x))
    }
  }
  const ws = s.ctx.createWaveShaper()
  ws.curve = distortionCurve
  ws.oversample = '2x'
  ws.connect(s.out)
  return ws
}

// Two sawtooths a few cents apart give the beating that reads as "orchestral brass" in a parody.
function detunedSaw(s: Slot, freq: number, at: number, hold: number, decay: number, peak: number, dest: AudioNode): void {
  tone(s, { type: 'sawtooth', freq, at, hold, decay, peak, detune: -9, attack: 0.03, dest })
  tone(s, { type: 'sawtooth', freq, at, hold, decay, peak, detune: 9, attack: 0.03, dest })
}

function chime(s: Slot, freq: number, at: number, decay: number, peak: number): void {
  tone(s, { type: 'triangle', freq, at, decay, peak })
  tone(s, { freq: freq * 2, at, decay: decay * 0.6, peak: peak * 0.25 })
}

const NOTE = {
  A3: 220,
  C4: 261.63,
  D3: 146.83,
  D4: 293.66,
  E4: 329.63,
  G3: 196,
  G4: 392,
  A4: 440,
  C5: 523.25,
  E5: 659.25,
  G5: 783.99,
  D7: 2349.32,
} as const

const RECIPES: Record<SoundName, Recipe> = {
  pistol: (s) => {
    thump(s, 200, 0.05, 0.6)
    noise(s, { filter: 'bandpass', freq: 1600, q: 1, peak: 0.7, decay: 0.07 })
    return 0.15
  },
  smg: (s) => {
    thump(s, 170, 0.045, 0.6)
    noise(s, { filter: 'bandpass', freq: 2400, q: 0.7, peak: 0.7, decay: 0.06 })
    noise(s, { filter: 'highpass', freq: 5000, peak: 0.25, decay: 0.025 })
    return 0.12
  },
  rifle: (s) => {
    thump(s, 120, 0.09, 0.8)
    noise(s, { filter: 'bandpass', freq: 1800, q: 0.8, peak: 0.8, decay: 0.12 })
    noise(s, { filter: 'lowpass', freq: 500, peak: 0.4, decay: 0.15 })
    return 0.25
  },
  shotgun: (s) => {
    thump(s, 55, 0.2, 1.0)
    noise(s, { filter: 'lowpass', freq: 900, to: 200, peak: 1.0, decay: 0.22 })
    noise(s, { filter: 'bandpass', freq: 2200, q: 0.6, peak: 0.6, decay: 0.05 })
    return 0.45
  },
  stun: (s) => {
    // A ringing tinnitus tone over a dull pop: the sound of a room going quiet.
    thump(s, 120, 0.12, 0.7)
    tone(s, { type: 'sine', freq: 3200, at: 0.02, hold: 1.2, decay: 1.6, peak: 0.35, attack: 0.02 })
    tone(s, { type: 'sine', freq: 3210, at: 0.02, hold: 1.2, decay: 1.6, peak: 0.25, attack: 0.02 })
    return 3
  },
  lmg: (s) => {
    thump(s, 80, 0.14, 1.0)
    noise(s, { filter: 'bandpass', freq: 1200, q: 0.8, peak: 0.8, decay: 0.14 })
    noise(s, { filter: 'lowpass', freq: 300, peak: 0.6, decay: 0.2 })
    return 0.3
  },
  sniper: (s) => {
    thump(s, 60, 0.3, 1.0)
    noise(s, { filter: 'bandpass', freq: 2800, q: 0.5, peak: 1.0, decay: 0.05 })
    noise(s, { filter: 'bandpass', freq: 900, q: 0.6, peak: 0.6, decay: 0.5 })
    noise(s, { filter: 'lowpass', freq: 250, peak: 0.5, decay: 0.9 })
    return 1.0
  },
  rocket: (s) => {
    noise(s, { filter: 'bandpass', freq: 400, to: 3000, q: 0.8, peak: 0.6, attack: 0.05, decay: 0.3 })
    thump(s, 70, 0.25, 0.8)
    return 0.5
  },
  explosion: (s) => {
    const dist = distortion(s, 12)
    noise(s, { filter: 'lowpass', freq: 400, to: 80, peak: 1.0, decay: 1.2, dest: dist })
    tone(s, { freq: 90, to: 30, peak: 1.0, decay: 0.8, dest: dist })
    noise(s, { filter: 'bandpass', freq: 1500, q: 0.5, peak: 0.5, decay: 0.12 })
    return 1.4
  },
  collapse: (s) => {
    noise(s, { filter: 'lowpass', freq: 200, to: 60, peak: 0.9, attack: 0.3, hold: 0.4, decay: 2.3 })
    noise(s, { filter: 'lowpass', freq: 120, peak: 0.6, attack: 0.6, decay: 2.4 })
    tone(s, { freq: 50, to: 28, peak: 0.5, attack: 0.2, decay: 2.5 })
    return 3.2
  },
  crash: (s) => {
    noise(s, { filter: 'bandpass', freq: 3000, q: 2, peak: 0.8, decay: 0.3 })
    noise(s, { filter: 'lowpass', freq: 600, peak: 0.7, decay: 0.4 })
    tone(s, { type: 'square', freq: 1900, peak: 0.2, decay: 0.25 })
    tone(s, { type: 'square', freq: 2700, peak: 0.15, decay: 0.2, at: 0.02 })
    return 0.5
  },
  horn: (s) => {
    const lp = lowpass(s, 2000, 2000, 0.4)
    tone(s, { type: 'sawtooth', freq: NOTE.A4, peak: 0.3, attack: 0.02, hold: 0.33, decay: 0.05, dest: lp })
    tone(s, { type: 'square', freq: 554.37, peak: 0.2, attack: 0.02, hold: 0.33, decay: 0.05, dest: lp })
    return 0.45
  },
  enterVehicle: (s) => {
    noise(s, { filter: 'lowpass', freq: 800, peak: 0.5, decay: 0.08 })
    tone(s, { freq: 120, to: 60, peak: 0.5, decay: 0.1 })
    noise(s, { at: 0.08, filter: 'bandpass', freq: 2500, q: 2, peak: 0.3, decay: 0.03 })
    return 0.2
  },
  reload: (s) => {
    click(s, 0, 0.5)
    click(s, 0.25, 0.5)
    return 0.35
  },
  dryfire: (s) => {
    click(s, 0, 0.4)
    return 0.06
  },
  pin: (s) => {
    tone(s, { freq: 3200, peak: 0.4, decay: 0.15 })
    tone(s, { freq: 4800, peak: 0.2, decay: 0.1 })
    noise(s, { filter: 'highpass', freq: 6000, peak: 0.2, decay: 0.01 })
    return 0.2
  },
  grenadeBounce: (s) => {
    tone(s, { freq: 150, to: 60, peak: 0.5, decay: 0.08 })
    noise(s, { filter: 'lowpass', freq: 500, peak: 0.3, decay: 0.05 })
    return 0.12
  },
  footstep: (s) => {
    const r = 0.85 + Math.random() * 0.3
    noise(s, { filter: 'bandpass', freq: 500 * r, q: 1, peak: 0.5, decay: 0.07, rate: r })
    tone(s, { freq: 90 * r, peak: 0.2, decay: 0.05 })
    return 0.1
  },
  jump: (s) => {
    noise(s, { filter: 'lowpass', freq: 600, peak: 0.3, decay: 0.1 })
    tone(s, { freq: 120, to: 80, peak: 0.3, decay: 0.08 })
    return 0.15
  },
  land: (s) => {
    tone(s, { freq: 100, to: 50, peak: 0.5, decay: 0.12 })
    noise(s, { filter: 'lowpass', freq: 400, peak: 0.4, decay: 0.1 })
    return 0.15
  },
  inhaler: (s) => {
    // Actuator click, a crisp pressurised "chh" that thins as the dose empties, then a long breath drawn in.
    tone(s, { type: 'square', freq: 2400, peak: 0.1, decay: 0.012 })
    noise(s, { filter: 'highpass', freq: 4500, q: 0.7, peak: 0.7, at: 0.01, attack: 0.004, hold: 0.09, decay: 0.12 })
    noise(s, { filter: 'bandpass', freq: 7500, to: 3500, q: 1.5, peak: 0.5, at: 0.01, attack: 0.004, hold: 0.06, decay: 0.14 })
    // Breath: soft, resonance climbs as the lungs fill, then tails off.
    noise(s, { filter: 'bandpass', freq: 350, to: 1300, q: 1.8, peak: 0.55, at: 0.2, attack: 0.3, hold: 0.35, decay: 0.35 })
    noise(s, { filter: 'lowpass', freq: 700, to: 1800, q: 0.7, peak: 0.35, at: 0.2, attack: 0.3, hold: 0.35, decay: 0.35 })
    return 1.5
  },
  ricochet: (s) => {
    tone(s, { freq: 3000, to: 600, peak: 0.35, decay: 0.25 })
    noise(s, { filter: 'bandpass', freq: 4000, q: 2, peak: 0.3, decay: 0.03 })
    return 0.3
  },
  impact: (s) => {
    noise(s, { filter: 'bandpass', freq: 1200, q: 0.7, peak: 0.5, decay: 0.05 })
    return 0.08
  },
  hit: (s) => {
    tone(s, { type: 'square', freq: 1200, peak: 0.25, decay: 0.015 })
    noise(s, { filter: 'highpass', freq: 3000, peak: 0.2, decay: 0.01 })
    return 0.03
  },
  killConfirm: (s) => {
    tone(s, { freq: 1320, peak: 0.35, decay: 0.18 })
    tone(s, { freq: 2640, peak: 0.1, decay: 0.1 })
    return 0.25
  },
  headshot: (s) => {
    tone(s, { freq: 1760, peak: 0.3, decay: 0.12 })
    tone(s, { freq: NOTE.D7, peak: 0.35, decay: 0.2, at: 0.09 })
    return 0.35
  },
  death: (s) => {
    const lp = lowpass(s, 1200, 150, 0.9)
    tone(s, { type: 'sawtooth', freq: 220, to: 55, peak: 0.4, attack: 0.02, decay: 0.9, dest: lp })
    return 1.0
  },
  deploy: (s) => {
    noise(s, { filter: 'bandpass', freq: 300, to: 2500, q: 1.2, peak: 0.5, attack: 0.3, decay: 0.2 })
    tone(s, { freq: 200, to: 600, peak: 0.12, attack: 0.3, decay: 0.2 })
    return 0.6
  },
  uiClick: (s) => {
    tone(s, { type: 'square', freq: 2000, peak: 0.15, decay: 0.02 })
    noise(s, { filter: 'highpass', freq: 4000, peak: 0.1, decay: 0.01 })
    return 0.04
  },
  uiHover: (s) => {
    tone(s, { freq: 3000, peak: 0.06, decay: 0.015 })
    return 0.03
  },
  flagTick: (s) => {
    tone(s, { freq: 1000, peak: 0.12, decay: 0.04 })
    return 0.06
  },
  capture: (s) => {
    chime(s, NOTE.C5, 0, 0.4, 0.35)
    chime(s, NOTE.E5, 0.14, 0.6, 0.35)
    return 0.9
  },
  lost: (s) => {
    chime(s, NOTE.E5, 0, 0.4, 0.35)
    chime(s, NOTE.C5, 0.14, 0.6, 0.35)
    return 0.9
  },
  victory: (s) => {
    const notes = [NOTE.C4, NOTE.E4, NOTE.G4, NOTE.C5, NOTE.E5]
    notes.forEach((f, i) => chime(s, f, i * 0.12, i === notes.length - 1 ? 1.0 : 0.35, 0.3))
    chime(s, NOTE.G5, 0.6, 1.0, 0.2)
    return 1.7
  },
  defeat: (s) => {
    const lp = lowpass(s, 2200, 400, 2.0)
    const notes = [NOTE.E5, NOTE.C5, NOTE.A4, NOTE.E4, NOTE.A3]
    notes.forEach((f, i) => detunedSaw(s, f, i * 0.22, 0, i === notes.length - 1 ? 1.1 : 0.25, 0.18, lp))
    return 2.1
  },
  stinger: (s) => {
    // Four rising notes then a held D with a snare hit: the motif everyone hums, slightly wrong.
    const lp = lowpass(s, 400, 3200, 2.2, 2)
    detunedSaw(s, NOTE.D3, 0, 0.25, 0.1, 0.22, lp)
    detunedSaw(s, NOTE.G3, 0.42, 0.25, 0.1, 0.22, lp)
    detunedSaw(s, NOTE.A3, 0.84, 0.25, 0.1, 0.22, lp)
    detunedSaw(s, NOTE.D4, 1.26, 0.7, 0.5, 0.26, lp)
    tone(s, { freq: NOTE.D3 / 2, peak: 0.3, attack: 0.02, hold: 0.7, decay: 0.5, at: 1.26 })
    noise(s, { at: 1.26, filter: 'bandpass', freq: 1800, q: 0.7, peak: 0.6, decay: 0.18 })
    tone(s, { at: 1.26, freq: 180, to: 80, peak: 0.5, decay: 0.12 })
    return 2.5
  },
}

interface ActiveVoice {
  readonly out: GainNode
  readonly panner: StereoPannerNode
  readonly level: number
  readonly start: number
  readonly end: number
}

interface EngineNodes {
  readonly a: OscillatorNode
  readonly b: OscillatorNode
  readonly lp: BiquadFilterNode
  readonly gain: GainNode
}

export class AudioEngine {
  private ctx: AudioContext | null = null
  private master: GainNode | null = null
  private noiseBuffer: AudioBuffer | null = null
  private masterVolume = 0.8
  private readonly active: ActiveVoice[] = []
  private readonly listenerPos = new THREE.Vector3()
  private readonly listenerRight = new THREE.Vector3(1, 0, 0)
  private ambientTimer: number | null = null
  private ambientBed: GainNode | null = null
  private eng: EngineNodes | null = null
  private engineWanted = false
  private engineThrottle = 0
  private engineSpeed = 0

  readonly engine = {
    start: (): void => {
      this.engineWanted = true
      if (this.ctx && !this.eng) this.startEngine(this.ctx)
    },
    setThrottle: (t: number): void => {
      this.engineThrottle = clamp01(t)
      if (this.eng && this.ctx) {
        this.eng.gain.gain.setTargetAtTime(0.08 + this.engineThrottle * 0.22, this.ctx.currentTime, 0.1)
      }
    },
    setSpeed: (sp: number): void => {
      this.engineSpeed = clamp01(sp)
      if (this.eng && this.ctx) {
        const now = this.ctx.currentTime
        const f = 40 + this.engineSpeed * 110
        this.eng.a.frequency.setTargetAtTime(f, now, 0.08)
        this.eng.b.frequency.setTargetAtTime(f / 2, now, 0.08)
        this.eng.lp.frequency.setTargetAtTime(500 + this.engineSpeed * 1500, now, 0.1)
      }
    },
    stop: (): void => {
      this.engineWanted = false
      const e = this.eng
      if (!e || !this.ctx) return
      this.eng = null
      const now = this.ctx.currentTime
      e.gain.gain.setTargetAtTime(0, now, 0.12)
      e.a.stop(now + 0.6)
      e.b.stop(now + 0.6)
      window.setTimeout(() => e.gain.disconnect(), 700)
    },
  }

  constructor() {
    // Nothing is created here: browsers refuse to run a context before a user gesture.
  }

  resume(): void {
    if (!this.ctx) {
      if (typeof AudioContext === 'undefined') return
      try {
        this.setup(new AudioContext())
      } catch {
        return
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      void this.ctx.resume()
    }
  }

  private setup(ctx: AudioContext): void {
    this.ctx = ctx
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -18
    comp.knee.value = 12
    comp.ratio.value = 6
    comp.attack.value = 0.003
    comp.release.value = 0.2
    comp.connect(ctx.destination)
    this.master = ctx.createGain()
    this.master.gain.value = this.masterVolume
    this.master.connect(comp)

    const len = Math.floor(ctx.sampleRate * 1.5)
    this.noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate)
    const data = this.noiseBuffer.getChannelData(0)
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1

    this.startAmbient(ctx)
    if (this.engineWanted) this.startEngine(ctx)
  }

  setListener(position: THREE.Vector3, forward: THREE.Vector3): void {
    this.listenerPos.copy(position)
    const right = tmpRight.crossVectors(forward, UP)
    if (right.lengthSq() < 1e-6) return
    this.listenerRight.copy(right.normalize())
  }

  setMasterVolume(v: number): void {
    this.masterVolume = clamp01(v)
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.masterVolume, this.ctx.currentTime, 0.02)
  }

  play(name: SoundName, opts: PlayOpts = {}): void {
    const ctx = this.ctx
    const master = this.master
    const buf = this.noiseBuffer
    if (!ctx || !master || !buf || ctx.state !== 'running') return

    let level = opts.volume ?? 1
    let pan = 0
    if (opts.position) {
      const sp = this.spatialise(opts.position, RANGE[name] ?? DEFAULT_RANGE)
      if (sp.gain < 0.003) return
      level *= sp.gain
      pan = sp.pan
    }
    if (level <= 0) return

    this.prune(ctx.currentTime)
    if (this.active.length >= MAX_VOICES) this.evict()

    const out = ctx.createGain()
    out.gain.value = level
    const panner = ctx.createStereoPanner()
    panner.pan.value = pan
    out.connect(panner).connect(master)

    const slot: Slot = { ctx, noise: buf, t: ctx.currentTime, pitch: Math.max(0.25, opts.pitch ?? 1), out }
    const dur = RECIPES[name](slot)
    const voice: ActiveVoice = { out, panner, level, start: slot.t, end: slot.t + dur }
    this.active.push(voice)
    window.setTimeout(() => this.release(voice), (dur + 0.15) * 1000)
  }

  dispose(): void {
    if (this.ambientTimer !== null) window.clearInterval(this.ambientTimer)
    this.ambientTimer = null
    this.engine.stop()
    for (const v of this.active) this.release(v)
    if (this.ctx) void this.ctx.close()
    this.ctx = null
    this.master = null
    this.noiseBuffer = null
    this.ambientBed = null
  }

  private spatialise(position: THREE.Vector3, range: number): { gain: number; pan: number } {
    const dx = position.x - this.listenerPos.x
    const dy = position.y - this.listenerPos.y
    const dz = position.z - this.listenerPos.z
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (d >= range) return { gain: 0, pan: 0 }
    // Linear cutoff at range times an inverse term so close sounds fall away quickly
    // and far ones sit in a long quiet tail instead of vanishing abruptly.
    const gain = (1 - d / range) / (1 + d / (range / 4))
    // Panning collapses to centre for sounds at the listener's own position.
    const pan = d < 1 ? 0 : ((dx * this.listenerRight.x + dz * this.listenerRight.z) / d) * 0.8
    return { gain, pan: Math.max(-1, Math.min(1, pan)) }
  }

  private prune(now: number): void {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const v = this.active[i]
      if (v && v.end < now) this.release(v)
    }
  }

  private evict(): void {
    let victim: ActiveVoice | null = null
    for (const v of this.active) {
      if (!victim || v.level < victim.level || (v.level === victim.level && v.start < victim.start)) victim = v
    }
    if (victim) this.release(victim)
  }

  private release(v: ActiveVoice): void {
    const i = this.active.indexOf(v)
    if (i >= 0) this.active.splice(i, 1)
    v.out.disconnect()
    v.panner.disconnect()
  }

  private makeSlot(ctx: AudioContext, dest: AudioNode, level: number, pan: number): Slot | null {
    if (!this.noiseBuffer) return null
    const out = ctx.createGain()
    out.gain.value = level
    const panner = ctx.createStereoPanner()
    panner.pan.value = pan
    out.connect(panner).connect(dest)
    window.setTimeout(() => {
      out.disconnect()
      panner.disconnect()
    }, 4000)
    return { ctx, noise: this.noiseBuffer, t: ctx.currentTime, pitch: 1, out }
  }

  private startAmbient(ctx: AudioContext): void {
    const bed = ctx.createGain()
    bed.gain.value = 0.35
    bed.connect(this.master as GainNode)
    this.ambientBed = bed

    const wind = ctx.createBufferSource()
    wind.buffer = this.noiseBuffer
    wind.loop = true
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 260
    lp.Q.value = 0.7
    const windGain = ctx.createGain()
    windGain.gain.value = 0.12
    wind.connect(lp).connect(windGain).connect(bed)
    wind.start()

    // Slow LFOs on the filter and gain make the wind gust rather than hiss at a fixed level.
    const gust = ctx.createOscillator()
    gust.frequency.value = 0.13
    const gustDepth = ctx.createGain()
    gustDepth.gain.value = 140
    gust.connect(gustDepth).connect(lp.frequency)
    gust.start()
    const swell = ctx.createOscillator()
    swell.frequency.value = 0.07
    const swellDepth = ctx.createGain()
    swellDepth.gain.value = 0.05
    swell.connect(swellDepth).connect(windGain.gain)
    swell.start()

    this.ambientTimer = window.setInterval(() => {
      if (!this.ctx || this.ctx.state !== 'running' || !this.ambientBed) return
      if (Math.random() < 0.3) this.birdChirp(this.ctx, this.ambientBed)
      if (Math.random() < 0.25) this.farGunfire(this.ctx, this.ambientBed)
    }, 700)
  }

  private birdChirp(ctx: AudioContext, dest: AudioNode): void {
    const s = this.makeSlot(ctx, dest, 0.05, Math.random() * 1.6 - 0.8)
    if (!s) return
    const base = 2400 + Math.random() * 1400
    const n = 2 + Math.floor(Math.random() * 3)
    for (let i = 0; i < n; i++) {
      const up = Math.random() < 0.5
      tone(s, { freq: base, to: up ? base * 1.4 : base * 0.7, peak: 0.8, attack: 0.01, decay: 0.09, at: i * 0.13 })
    }
  }

  private farGunfire(ctx: AudioContext, dest: AudioNode): void {
    const s = this.makeSlot(ctx, dest, 0.07, Math.random() * 1.6 - 0.8)
    if (!s) return
    const shots = 1 + Math.floor(Math.random() * 4)
    for (let i = 0; i < shots; i++) {
      const at = i * (0.08 + Math.random() * 0.06)
      tone(s, { freq: 55, to: 35, peak: 0.9, decay: 0.45, at })
      noise(s, { filter: 'lowpass', freq: 150, peak: 0.6, decay: 0.35, at })
    }
  }

  private startEngine(ctx: AudioContext): void {
    const a = ctx.createOscillator()
    a.type = 'sawtooth'
    const b = ctx.createOscillator()
    b.type = 'square'
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.Q.value = 1.2
    const gain = ctx.createGain()
    gain.gain.value = 0
    const subGain = ctx.createGain()
    subGain.gain.value = 0.5
    a.connect(lp)
    b.connect(subGain).connect(lp)
    lp.connect(gain).connect(this.master as GainNode)
    a.start()
    b.start()
    this.eng = { a, b, lp, gain }
    this.engine.setSpeed(this.engineSpeed)
    this.engine.setThrottle(this.engineThrottle)
  }
}
