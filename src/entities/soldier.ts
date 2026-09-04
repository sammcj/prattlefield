import * as THREE from 'three'
import { AIM, CLASSES, GRENADES, MAP, SOLDIER, TEAMS } from '../config'
import type { GameContext } from '../context'
import { fireWeapon } from '../combat/weapons'
import { WeaponState } from '../combat/weapons'
import type { ClassDef, ClassId, Combatant, DamageSource, GrenadeDef, Loadout, Team } from '../types'
import { SoldierMesh } from './soldierMesh'
import type { Vehicle } from './vehicle'
import { clamp } from '../util/math'

export interface MoveInput {
  forward: number
  strafe: number
  jump: boolean
  sprint: boolean
  crouch: boolean
}

const tmpForward = new THREE.Vector3()
const tmpRight = new THREE.Vector3()
const tmpMuzzle = new THREE.Vector3()
const tmpOrigin = new THREE.Vector3()
const tmpAim = new THREE.Vector3()

/**
 * Shared body for the player and bots: terrain-walking physics, health,
 * weapons and death. Subclasses supply intent each frame.
 */
export abstract class Soldier implements Combatant {
  readonly position = new THREE.Vector3()
  readonly velocity = new THREE.Vector3()
  yaw = 0
  pitch = 0
  readonly team: Team
  readonly displayName: string
  classId: ClassId
  classDef: ClassDef
  loadout: Loadout
  grenadeDef: GrenadeDef
  readonly mesh: SoldierMesh
  weapons: readonly [WeaponState, WeaponState]
  activeWeapon = 0
  grenades: number
  /** Seconds left of an Awkward Silence. No firing, and subclasses degrade aim or vision. */
  stunTimer = 0
  /** Pitch the view still owes back after recoil, and how long since the last shot. */
  private recoilDebt = 0
  private recoilRest = 0
  health: number = SOLDIER.maxHealth
  alive = false
  kills = 0
  deaths = 0
  score = 0
  grounded = false
  crouching = false
  sprinting = false
  vehicle: Vehicle | null = null
  lastAttacker: Combatant | null = null
  respawnTimer = 0
  resupplying = false
  private grenadeAccum = 0
  protected regenTimer = 0
  protected stepAccum = 0
  protected readonly ctx: GameContext
  private horizontalSpeed = 0

  abstract readonly isPlayer: boolean

  constructor(ctx: GameContext, team: Team, classId: ClassId, displayName: string) {
    this.ctx = ctx
    this.team = team
    this.classId = classId
    this.displayName = displayName
    const def = CLASSES.find((c) => c.id === classId)
    if (!def) throw new Error(`unknown class ${classId}`)
    this.classDef = def
    this.loadout = def.loadout
    this.grenadeDef = GRENADES[def.loadout.grenade]
    this.weapons = [new WeaponState(def.loadout.primary), new WeaponState(def.loadout.secondary)]
    this.grenades = this.grenadeDef.count
    const teamDef = TEAMS.find((t) => t.id === team)
    this.mesh = new SoldierMesh(team, { name: displayName, colour: teamDef?.css ?? '#fff' })
    this.mesh.group.visible = false
    ctx.world.scene.add(this.mesh.group)
  }

  setClass(classId: ClassId): void {
    const def = CLASSES.find((c) => c.id === classId)
    if (!def) throw new Error(`unknown class ${classId}`)
    this.classId = classId
    this.classDef = def
    this.setLoadout(def.loadout)
  }

  /** Swaps guns and grenade type. Takes effect fully on the next spawn. */
  setLoadout(loadout: Loadout): void {
    this.loadout = loadout
    this.grenadeDef = GRENADES[loadout.grenade]
    this.weapons = [new WeaponState(loadout.primary), new WeaponState(loadout.secondary)]
    this.activeWeapon = 0
  }

  get stunned(): boolean {
    return this.stunTimer > 0
  }

  stun(seconds: number): void {
    if (!this.alive) return
    this.stunTimer = Math.max(this.stunTimer, seconds)
  }

  get weapon(): WeaponState {
    return this.weapons[this.activeWeapon === 0 ? 0 : 1]
  }

  get speed(): number {
    return this.horizontalSpeed
  }

  spawnAt(x: number, z: number, yaw: number): void {
    this.position.set(x, this.ctx.world.heightAt(x, z) + 0.05, z)
    this.velocity.set(0, 0, 0)
    this.yaw = yaw
    this.pitch = 0
    this.health = SOLDIER.maxHealth
    this.alive = true
    this.grounded = true
    this.crouching = false
    this.lastAttacker = null
    this.regenTimer = 0
    this.stunTimer = 0
    this.recoilDebt = 0
    this.grenades = this.grenadeDef.count
    for (const w of this.weapons) w.refill()
    this.activeWeapon = 0
    this.mesh.revive()
    this.mesh.group.visible = true
    this.ctx.world.registerHitbox(this.mesh.bodyHitbox, { damageable: this, headshot: false })
    this.ctx.world.registerHitbox(this.mesh.headHitbox, { damageable: this, headshot: true })
    this.syncMesh()
  }

  eyePosition(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.position).setY(this.position.y + this.mesh.eyeHeight)
  }

  forward(out: THREE.Vector3): THREE.Vector3 {
    const cp = Math.cos(this.pitch)
    return out.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp)
  }

  flatForward(out: THREE.Vector3): THREE.Vector3 {
    return out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw))
  }

  /** Where tracers and flashes originate. Player overrides with the viewmodel. */
  muzzlePosition(out: THREE.Vector3): THREE.Vector3 {
    this.eyePosition(out)
    this.forward(tmpForward)
    tmpRight.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw))
    return out.addScaledVector(tmpForward, 0.9).addScaledVector(tmpRight, 0.25).setY(out.y - 0.25)
  }

  applyDamage(amount: number, attacker: Combatant | null, source: DamageSource): void {
    if (!this.alive) return
    this.health -= amount
    this.regenTimer = SOLDIER.regenDelay
    if (attacker && attacker !== this) this.lastAttacker = attacker
    this.onDamaged(amount, attacker)
    if (this.health <= 0) {
      this.health = 0
      this.die(attacker, source)
    }
  }

  protected onDamaged(_amount: number, _attacker: Combatant | null): void {}

  protected die(attacker: Combatant | null, source: DamageSource): void {
    this.alive = false
    this.deaths += 1
    this.respawnTimer = 0
    this.mesh.die()
    this.ctx.world.unregisterHitbox(this.mesh.bodyHitbox)
    this.ctx.world.unregisterHitbox(this.mesh.headHitbox)
    this.ctx.effects.blood(this.position)
    this.ctx.audio.play('death', { position: this.position })
    this.ctx.events.onKill({ attacker: attacker === this ? null : attacker, victim: this, source })
    this.onDied()
  }

  protected onDied(): void {}

  /** Cleans up the corpse. Called once the body has lain around long enough. */
  hideBody(): void {
    this.mesh.group.visible = false
  }

  say(text: string): void {
    this.mesh.say(text)
    this.ctx.events.onPrattle({ speaker: this.displayName, team: this.team, text, position: this.position })
  }

  switchWeapon(index: number): void {
    if (index === this.activeWeapon) return
    this.weapon.cancelReload()
    this.activeWeapon = index
  }

  /** Fires the active weapon if the trigger allows it. Returns hit info for HUD feedback. */
  fire(triggerDown: boolean, ads: boolean): ReturnType<typeof fireWeapon> | null {
    const w = this.weapon
    if (!this.alive) return null
    if (triggerDown && w.empty && !w.reloading) {
      if (w.reserve > 0) w.startReload()
      return null
    }
    if (this.stunned) return null
    if (!w.tryFire(triggerDown)) return null
    const origin = this.eyePosition(tmpOrigin)
    const aim = this.forward(tmpAim)
    const spread = w.spreadFor(ads, this.horizontalSpeed > 1, this.crouching, !this.grounded)
    const muzzle = this.muzzlePosition(tmpMuzzle)
    // Kick climbs the view; most of it is paid back once the trigger rests so bursts stay controllable.
    const kick = w.def.recoil * (0.8 + Math.random() * 0.4)
    const before = this.pitch
    this.pitch = clamp(this.pitch + kick, -1.45, 1.45)
    this.yaw += (Math.random() - 0.5) * 2 * w.def.recoil * w.def.recoilSide
    // Only credit what the clamp let through, or the view over-corrects at the pitch limit.
    this.recoilDebt += (this.pitch - before) * AIM.recoilRecovery
    this.recoilRest = 0.12
    return fireWeapon(this.ctx, this, w.def, origin, aim, spread, muzzle)
  }

  throwGrenade(): boolean {
    if (!this.alive || this.grenades <= 0 || this.stunned) return false
    this.grenades -= 1
    const origin = this.eyePosition(new THREE.Vector3())
    const dir = this.forward(new THREE.Vector3())
    origin.addScaledVector(dir, 0.6)
    this.ctx.projectiles.throwGrenade(this, origin, dir, this.grenadeDef, this.horizontalSpeed * 0.5)
    return true
  }

  /** Integrates one physics step from movement intent. */
  move(dt: number, input: MoveInput): void {
    if (!this.alive || this.inVehicle) return
    const world = this.ctx.world
    this.crouching = input.crouch && this.grounded
    const wantSprint = input.sprint && input.forward > 0.5 && !this.crouching
    this.sprinting = wantSprint
    const inWater = this.position.y < MAP.waterLevel - 0.2
    let maxSpeed = this.weapons[0].def.moveSpeed
    if (this.sprinting) maxSpeed *= SOLDIER.sprintMultiplier
    if (this.crouching) maxSpeed *= SOLDIER.crouchMultiplier
    if (inWater) maxSpeed *= 0.45

    this.flatForward(tmpForward)
    tmpRight.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw))
    const wishX = tmpForward.x * input.forward + tmpRight.x * input.strafe
    const wishZ = tmpForward.z * input.forward + tmpRight.z * input.strafe
    const wishLen = Math.sqrt(wishX * wishX + wishZ * wishZ)
    const nx = wishLen > 1e-4 ? wishX / wishLen : 0
    const nz = wishLen > 1e-4 ? wishZ / wishLen : 0
    const targetVx = nx * maxSpeed * Math.min(1, wishLen)
    const targetVz = nz * maxSpeed * Math.min(1, wishLen)
    const accel = this.grounded ? 42 : 9
    const k = Math.min(1, accel * dt / Math.max(maxSpeed, 1))
    this.velocity.x += (targetVx - this.velocity.x) * k
    this.velocity.z += (targetVz - this.velocity.z) * k

    if (input.jump && this.grounded) {
      this.velocity.y = SOLDIER.jumpSpeed
      this.grounded = false
      this.ctx.audio.play('jump', { position: this.position, volume: 0.5 })
    }
    this.velocity.y -= SOLDIER.gravity * dt

    this.position.x += this.velocity.x * dt
    this.position.z += this.velocity.z * dt
    world.resolveCircle(this.position, SOLDIER.radius, SOLDIER.height)
    this.position.y += this.velocity.y * dt
    const ground = world.groundAt(this.position.x, this.position.z, this.position.y)
    if (this.position.y <= ground) {
      if (!this.grounded && this.velocity.y < -SOLDIER.fallDamageSpeed) {
        const dmg = (-this.velocity.y - SOLDIER.fallDamageSpeed) * 9
        this.applyDamage(dmg, null, { kind: 'fall' })
      }
      if (!this.grounded) this.ctx.audio.play('land', { position: this.position, volume: 0.5 })
      this.position.y = ground
      this.velocity.y = 0
      this.grounded = true
    } else if (this.position.y > ground + 0.3) {
      this.grounded = false
    } else {
      // Small step down: snap to keep walking down slopes smooth.
      this.position.y = ground
      this.velocity.y = 0
      this.grounded = true
    }
    this.horizontalSpeed = Math.sqrt(this.velocity.x * this.velocity.x + this.velocity.z * this.velocity.z)
    if (this.position.y < MAP.waterLevel - 3.5) {
      this.applyDamage(999, null, { kind: 'fall' })
      return
    }

    if (this.grounded && this.horizontalSpeed > 1) {
      this.stepAccum += this.horizontalSpeed * dt
      const strideLen = this.sprinting ? 2.4 : 1.8
      if (this.stepAccum > strideLen) {
        this.stepAccum = 0
        this.ctx.audio.play('footstep', { position: this.position, volume: this.crouching ? 0.15 : 0.4 })
        if (this.sprinting) this.ctx.effects.dust(this.position, 1)
      }
    }
  }

  get inVehicle(): boolean {
    return this.vehicle !== null
  }

  get outOfAmmo(): boolean {
    return this.weapons.every((w) => w.mag + w.reserve <= 0)
  }

  /** Tops up reserves while standing on a friendly flag. Called by the match each frame it applies. */
  resupply(dt: number): void {
    this.resupplying = true
    for (const w of this.weapons) {
      const max = w.def.magSize * w.def.reserveMags
      if (w.reserve < max) w.reserve = Math.min(max, w.reserve + (w.def.magSize / 4) * dt)
      else if (w.mag < w.def.magSize && !w.reloading) w.mag = Math.min(w.def.magSize, w.mag + (w.def.magSize / 4) * dt)
    }
    this.grenadeAccum += dt
    if (this.grenadeAccum > 20 && this.grenades < this.grenadeDef.count) {
      this.grenadeAccum = 0
      this.grenades += 1
    }
  }

  /** Per-frame housekeeping: regen, weapons, mesh. */
  tick(dt: number): void {
    for (const w of this.weapons) w.update(dt)
    this.resupplying = false
    if (this.stunTimer > 0) this.stunTimer -= dt
    if (this.recoilRest > 0) this.recoilRest -= dt
    else if (this.recoilDebt > 0.0005) {
      const settle = this.recoilDebt * (1 - Math.exp(-AIM.recoilRecoverRate * dt))
      this.pitch -= settle
      this.recoilDebt -= settle
    }
    if (this.alive) {
      if (this.regenTimer > 0) this.regenTimer -= dt
      else if (this.health < SOLDIER.maxHealth) this.health = Math.min(SOLDIER.maxHealth, this.health + SOLDIER.regenRate * dt)
    } else {
      this.respawnTimer += dt
    }
    this.syncMesh()
    this.mesh.update(dt, this.horizontalSpeed, this.pitch, this.crouching, this.grounded)
  }

  protected syncMesh(): void {
    this.mesh.group.position.copy(this.position)
    this.mesh.group.rotation.y = this.yaw + Math.PI
    // Raycasts read matrixWorld directly, so refresh it here rather than waiting for the next render.
    this.mesh.group.updateMatrixWorld(true)
  }

  dispose(): void {
    this.ctx.world.unregisterHitbox(this.mesh.bodyHitbox)
    this.ctx.world.unregisterHitbox(this.mesh.headHitbox)
    this.ctx.world.scene.remove(this.mesh.group)
  }
}
