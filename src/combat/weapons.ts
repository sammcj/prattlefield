import * as THREE from 'three'
import { AIM, WEAPONS } from '../config'
import type { GameContext } from '../context'
import type { Combatant, DamageSource, WeaponDef } from '../types'

/** Per-soldier ammunition and timing state for one weapon. */
export class WeaponState {
  readonly def: WeaponDef
  mag: number
  reserve: number
  reloading = false
  /** Extra cone radius from sustained fire. Decays when the gun rests. */
  bloom = 0
  private reloadTimer = 0
  private cooldown = 0
  private triggerHeld = false

  constructor(id: string) {
    const def = WEAPONS[id]
    if (!def) throw new Error(`unknown weapon ${id}`)
    this.def = def
    this.mag = def.magSize
    this.reserve = def.magSize * def.reserveMags
  }

  refill(): void {
    this.mag = this.def.magSize
    this.reserve = this.def.magSize * this.def.reserveMags
    this.reloading = false
    this.cooldown = 0
  }

  update(dt: number): void {
    if (this.cooldown > 0) this.cooldown -= dt
    if (this.bloom > 0) this.bloom *= Math.exp(-AIM.bloomDecay * dt)
    if (this.reloading) {
      this.reloadTimer -= dt
      if (this.reloadTimer <= 0) {
        const need = this.def.magSize - this.mag
        const take = Math.min(need, this.reserve)
        this.mag += take
        this.reserve -= take
        this.reloading = false
      }
    }
  }

  get canReload(): boolean {
    return !this.reloading && this.mag < this.def.magSize && this.reserve > 0
  }

  startReload(): boolean {
    if (!this.canReload) return false
    this.reloading = true
    this.reloadTimer = this.def.reloadTime
    return true
  }

  cancelReload(): void {
    this.reloading = false
  }

  /**
   * Returns true when a shot should fire this frame. Semi-auto weapons require
   * the trigger to be released between shots.
   */
  tryFire(triggerDown: boolean): boolean {
    const wasHeld = this.triggerHeld
    this.triggerHeld = triggerDown
    if (!triggerDown || this.reloading || this.cooldown > 0) return false
    if (!this.def.auto && wasHeld) return false
    if (this.mag <= 0) return false
    this.mag -= 1
    this.cooldown = 60 / this.def.rpm
    this.bloom = Math.min(this.def.bloomMax, this.bloom + this.def.bloomPerShot)
    return true
  }

  /** Cone radius for the next shot. Bloom is added after the stance multiplier so a rested gun always starts tight. */
  spreadFor(ads: boolean, moving: boolean, crouching: boolean, airborne: boolean): number {
    let s = ads ? this.def.adsSpread : this.def.spread
    if (moving) s *= ads ? AIM.movingAds : AIM.movingHip
    if (crouching) s *= AIM.crouch
    if (airborne) s *= AIM.airborne
    return s + this.bloom
  }

  get empty(): boolean {
    return this.mag <= 0
  }
}

const tmpDir = new THREE.Vector3()
const tmpRight = new THREE.Vector3()
const tmpUp = new THREE.Vector3()
const worldUp = new THREE.Vector3(0, 1, 0)

/** Full damage inside falloffStart, sliding linearly to the floor at falloffEnd. */
export function damageAtRange(weapon: WeaponDef, distance: number): number {
  if (distance <= weapon.falloffStart || weapon.falloffEnd <= weapon.falloffStart) return weapon.damage
  const t = Math.min(1, (distance - weapon.falloffStart) / (weapon.falloffEnd - weapon.falloffStart))
  return weapon.damage * (1 - t * (1 - weapon.minDamageMul))
}

export interface ShotResult {
  readonly hitTarget: boolean
  readonly headshot: boolean
  readonly killed: boolean
}

/**
 * Resolves a single shot from `shooter`: applies spread, raycasts the world,
 * spawns tracers/impacts and deals damage. Rockets are handed to Projectiles.
 */
export function fireWeapon(
  ctx: GameContext,
  shooter: Combatant,
  weapon: WeaponDef,
  origin: THREE.Vector3,
  aim: THREE.Vector3,
  spread: number,
  muzzle: THREE.Vector3 | null,
): ShotResult {
  // Slightly under full level so the speech synthesis (capped at 1.0) stays audible over gunfire.
  ctx.audio.play(weapon.sound, { position: origin, volume: 0.85 })
  if (weapon.kind === 'rocket') {
    ctx.projectiles.spawnRocket(shooter, origin, aim, weapon)
    if (muzzle) ctx.effects.muzzleFlash(muzzle, aim, 2)
    return { hitTarget: false, headshot: false, killed: false }
  }
  let hitTarget = false
  let headshot = false
  let killed = false
  tmpRight.crossVectors(aim, worldUp).normalize()
  tmpUp.crossVectors(tmpRight, aim).normalize()
  for (let p = 0; p < weapon.pellets; p++) {
    // Uniform disc spread rather than gaussian keeps the cone predictable.
    const r = Math.sqrt(Math.random()) * spread
    const a = Math.random() * Math.PI * 2
    tmpDir.copy(aim).addScaledVector(tmpRight, Math.cos(a) * r).addScaledVector(tmpUp, Math.sin(a) * r).normalize()
    const hit = ctx.world.raycast(origin, tmpDir, weapon.range, shooter)
    const end = hit ? hit.point : origin.clone().addScaledVector(tmpDir, weapon.range)
    if (muzzle) ctx.effects.tracer(muzzle, end, weapon.tracerColour)
    if (!hit) continue
    if (hit.target) {
      const target = hit.target
      const wasAlive = target.alive
      const dmg = damageAtRange(weapon, hit.distance) * (hit.headshot ? weapon.headshotMultiplier : 1)
      const source: DamageSource = { kind: 'weapon', weaponName: weapon.name, headshot: hit.headshot }
      target.applyDamage(dmg, shooter, source)
      hitTarget = true
      headshot = headshot || hit.headshot
      killed = killed || (wasAlive && !target.alive)
      // The local player cannot see their own body, so their hit particles would just float in front of the camera.
      const isLocalPlayer = 'isPlayer' in target && target.isPlayer === true
      if (!isLocalPlayer) ctx.effects.impact(hit.point, hit.normal, 'flesh')
    } else {
      ctx.effects.impact(hit.point, hit.normal, 'dirt')
      if (Math.random() < 0.25) ctx.audio.play('ricochet', { position: hit.point, volume: 0.4 })
      else ctx.audio.play('impact', { position: hit.point, volume: 0.5 })
    }
  }
  if (muzzle) ctx.effects.muzzleFlash(muzzle, aim, 1)
  return { hitTarget, headshot, killed }
}
