import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { fbm, mulberry32, valueNoise } from '../src/util/noise'
import { clamp, damp, wrapAngle } from '../src/util/math'
import { heightAt, raymarchTerrain } from '../src/world/terrain'
import { CLASSES, FLAGS, GRENADES, MATCH, PRIMARIES, TEAMS, WEAPONS } from '../src/config'
import { WeaponState, damageAtRange } from '../src/combat/weapons'
import { Flag, countOwned } from '../src/world/flags'
import type { Combatant } from '../src/types'
import { TEAMKILL_AWARDS, teamKillAward } from '../src/prattle/lines'
import { World } from '../src/world/world'

describe('noise', () => {
  it('is deterministic and bounded', () => {
    expect(valueNoise(1.3, 2.7)).toBe(valueNoise(1.3, 2.7))
    for (let i = 0; i < 200; i++) {
      const v = fbm(i * 0.37, i * 0.11)
      expect(v).toBeGreaterThanOrEqual(-1)
      expect(v).toBeLessThanOrEqual(1)
    }
  })
  it('seeded rng repeats', () => {
    const a = mulberry32(7)
    const b = mulberry32(7)
    expect([a(), a(), a()]).toEqual([b(), b(), b()])
  })
})

describe('math', () => {
  it('clamps, damps and wraps', () => {
    expect(clamp(5, 0, 1)).toBe(1)
    expect(damp(0, 10, 1000, 1)).toBeCloseTo(10)
    expect(wrapAngle(Math.PI * 3)).toBeCloseTo(Math.PI)
  })
})

describe('terrain', () => {
  it('flattens flag areas so the pole sits on level ground', () => {
    for (const f of FLAGS) {
      const c = heightAt(f.x, f.z)
      expect(Math.abs(heightAt(f.x + f.radius * 0.5, f.z) - c)).toBeLessThan(0.05)
    }
  })
  it('gives both HQs an equal creek crossing', () => {
    // The creek runs perpendicular to the HQ axis; each HQ should see similar minimum height on the way to the centre.
    const minAlong = (hq: { x: number; z: number }): number => {
      let m = Infinity
      for (let t = 0; t <= 1; t += 0.02) m = Math.min(m, heightAt(hq.x * (1 - t), hq.z * (1 - t)))
      return m
    }
    const blue = TEAMS[0]?.hq ?? { x: 0, z: 0 }
    const orange = TEAMS[1]?.hq ?? { x: 0, z: 0 }
    expect(Math.abs(minAlong(blue) - minAlong(orange))).toBeLessThan(4)
  })
  it('raymarches down into the ground', () => {
    const origin = new THREE.Vector3(0, heightAt(0, 0) + 20, 0)
    const t = raymarchTerrain(origin, new THREE.Vector3(0, -1, 0), 100)
    expect(t).not.toBeNull()
    expect(t ?? 0).toBeCloseTo(20, 0)
    expect(raymarchTerrain(origin, new THREE.Vector3(0, 1, 0), 100)).toBeNull()
  })
})

describe('weapons', () => {
  it('blooms under sustained fire and settles when rested', () => {
    const w = new WeaponState('chattergun')
    const rested = w.spreadFor(false, false, false, false)
    expect(rested).toBe(w.def.spread)
    for (let i = 0; i < 12; i++) {
      w.tryFire(true)
      w.update(60 / w.def.rpm + 0.001)
    }
    const hot = w.spreadFor(false, false, false, false)
    expect(hot).toBeGreaterThan(rested)
    expect(hot).toBeLessThanOrEqual(w.def.spread + w.def.bloomMax + 1e-9)
    w.update(3)
    expect(w.spreadFor(false, false, false, false)).toBeCloseTo(rested, 4)
    // Stance ordering: ADS crouched still beats hip moving, and jumping is the worst.
    expect(w.spreadFor(true, false, true, false)).toBeLessThan(w.spreadFor(false, true, false, false))
    expect(w.spreadFor(false, false, false, true)).toBeGreaterThan(w.spreadFor(false, true, false, false))
  })

  it('applies damage falloff between the start and end ranges', () => {
    const smg = WEAPONS['chattergun']
    const sniper = WEAPONS['pointmaker']
    if (!smg || !sniper) throw new Error('missing weapon')
    expect(damageAtRange(smg, smg.falloffStart - 1)).toBe(smg.damage)
    expect(damageAtRange(smg, smg.falloffEnd + 50)).toBeCloseTo(smg.damage * smg.minDamageMul, 6)
    const mid = damageAtRange(smg, (smg.falloffStart + smg.falloffEnd) / 2)
    expect(mid).toBeLessThan(smg.damage)
    expect(mid).toBeGreaterThan(smg.damage * smg.minDamageMul)
    expect(damageAtRange(sniper, 500)).toBe(sniper.damage)
  })

  it('offers distinct primaries and grenades for the loadout screen', () => {
    expect(PRIMARIES.length).toBeGreaterThanOrEqual(3)
    for (const id of PRIMARIES) expect(WEAPONS[id]?.id).toBe(id)
    const kinds = new Set(Object.values(GRENADES).map((g) => g.kind))
    expect(kinds.size).toBe(3)
    for (const c of CLASSES) expect(WEAPONS[c.loadout.primary]).toBeDefined()
  })

  it('respects fire rate, semi-auto trigger and reload', () => {
    const w = new WeaponState('sidebar')
    const def = WEAPONS['sidebar']
    if (!def) throw new Error('missing weapon')
    expect(w.tryFire(true)).toBe(true)
    expect(w.mag).toBe(def.magSize - 1)
    expect(w.tryFire(true)).toBe(false)
    w.update(1)
    expect(w.tryFire(true)).toBe(false)
    w.update(0.01)
    expect(w.tryFire(false)).toBe(false)
    expect(w.tryFire(true)).toBe(true)
    w.mag = 0
    expect(w.tryFire(true)).toBe(false)
    expect(w.startReload()).toBe(true)
    w.update(def.reloadTime + 0.01)
    expect(w.mag).toBe(def.magSize)
    expect(w.reserve).toBe(def.magSize * def.reserveMags - def.magSize)
  })
})

function fakeCombatant(team: 'blue' | 'orange', x: number, z: number): Combatant {
  return {
    team,
    displayName: team,
    alive: true,
    position: new THREE.Vector3(x, 0, z),
    isPlayer: false,
    classId: 'yapper',
    kills: 0,
    deaths: 0,
    score: 0,
    applyDamage: () => undefined,
    stun: () => undefined,
  }
}

describe('flags', () => {
  const world = new World(new THREE.Scene())
  const def = FLAGS[2]
  if (!def) throw new Error('missing flag')

  it('captures after the configured time and reports the change', () => {
    const flag = new Flag(def, world)
    const blue = fakeCombatant('blue', def.x, def.z)
    let change = null
    for (let t = 0; t < MATCH.captureSeconds + 0.5 && !change; t += 0.1) change = flag.update(0.1, [blue])
    expect(change?.owner).toBe('blue')
    expect(change?.capturers).toEqual([blue])
    expect(countOwned([flag], 'blue')).toBe(1)
  })

  it('stalls while contested and neutralises before flipping', () => {
    const flag = new Flag(def, world)
    const blue = fakeCombatant('blue', def.x, def.z)
    const orange = fakeCombatant('orange', def.x + 2, def.z)
    flag.progress = 1
    flag.owner = 'blue'
    flag.update(1, [blue, orange])
    expect(flag.contested).toBe(true)
    expect(flag.progress).toBe(1)
    let change = null
    for (let t = 0; t < MATCH.captureSeconds + 0.5 && !change; t += 0.1) change = flag.update(0.1, [orange])
    expect(change?.owner).toBeNull()
    expect(change?.previous).toBe('blue')
  })
})

describe('team kill awards', () => {
  it('escalates with the count and never runs off the end', () => {
    const first = teamKillAward(1)
    const second = teamKillAward(2)
    expect(first[0]).not.toBe(second[0])
    expect(teamKillAward(99)).toEqual(TEAMKILL_AWARDS[TEAMKILL_AWARDS.length - 1])
    expect(teamKillAward(0)).toEqual(TEAMKILL_AWARDS[0])
  })
})
