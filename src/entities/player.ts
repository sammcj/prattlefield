import * as THREE from 'three'
import { SOLDIER, WEAPONS } from '../config'
import type { GameContext } from '../context'
import type { Input } from '../input'
import type { ClassId, Combatant, Loadout, Team } from '../types'
import { clamp, damp, lerp, wrapAngle } from '../util/math'
import { Soldier } from './soldier'

const BASE_FOV = 75
const SPRINT_FOV_BOOST = 6
const PUFF_SECONDS = 1.1
const PUFF_COOLDOWN = 8

interface Inhaler {
  readonly group: THREE.Group
  /** Pressed down at the top of the swing. */
  readonly canister: THREE.Mesh
}

/**
 * A Ventolin-style puffer: blue L-shaped actuator, silver canister poking out
 * the top, mouthpiece along +z (toward the camera), held in a fist.
 */
function buildInhaler(): Inhaler {
  const group = new THREE.Group()
  const blue = new THREE.MeshStandardMaterial({ color: 0x4a94f0, roughness: 0.45 })
  const blueDark = new THREE.MeshStandardMaterial({ color: 0x24589f, roughness: 0.5 })
  // Low metalness: with no environment map a metallic surface just renders dark.
  const metal = new THREE.MeshStandardMaterial({ color: 0xe4e8ec, roughness: 0.35, metalness: 0.15 })
  const skin = new THREE.MeshStandardMaterial({ color: 0xd9a679, roughness: 0.8 })

  // Vertical sleeve the canister sits in.
  const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.024, 0.026, 0.09, 14), blue)
  sleeve.position.y = 0.01
  // Mouthpiece: a flattened tube running toward the mouth, open at the end.
  const mouthpiece = new THREE.Mesh(new THREE.BoxGeometry(0.048, 0.03, 0.065), blue)
  mouthpiece.position.set(0, -0.025, 0.045)
  const opening = new THREE.Mesh(new THREE.BoxGeometry(0.036, 0.02, 0.004), blueDark)
  opening.position.set(0, -0.025, 0.078)
  // Canister protrudes above the sleeve with a wider crimp cap.
  const canister = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.017, 0.07, 14), metal)
  canister.position.y = 0.075
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.008, 14), metal)
  cap.position.y = 0.038
  canister.add(cap)
  // Fist wrapped around the lower sleeve.
  const fist = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.06, 0.07), skin)
  fist.position.set(0.012, -0.005, -0.022)
  const thumb = new THREE.Mesh(new THREE.BoxGeometry(0.022, 0.05, 0.022), skin)
  thumb.position.set(-0.035, 0.03, -0.01)
  thumb.rotation.z = 0.35

  group.add(sleeve, mouthpiece, opening, canister, fist, thumb)
  group.visible = false
  return { group, canister }
}
/** Weapons zooming this far or further get a scope overlay instead of the viewmodel. */
const SCOPE_FOV = 25
const SENS = 0.0022

export interface HitFeedback {
  time: number
  headshot: boolean
  killed: boolean
}

export interface DamageIndicator {
  angle: number
  time: number
}

const tmpV = new THREE.Vector3()
const tmpV2 = new THREE.Vector3()
const tmpQ = new THREE.Quaternion()
const gunMat = new THREE.MeshStandardMaterial({ color: 0x4a4e55, roughness: 0.5, metalness: 0.45 })
const gunAccent = new THREE.MeshStandardMaterial({ color: 0x6b6f76, roughness: 0.4, metalness: 0.6 })
const handMat = new THREE.MeshStandardMaterial({ color: 0x4e6b3a, roughness: 0.9 })
const tubeMat = new THREE.MeshStandardMaterial({ color: 0x4f5d2f, roughness: 0.8 })

/**
 * First-person controller. Owns the camera, the viewmodel and all the feel:
 * sway, bob, recoil kick, ADS zoom, hit markers and damage direction.
 */
export class Player extends Soldier {
  readonly isPlayer = true
  readonly camera: THREE.PerspectiveCamera
  readonly viewmodel = new THREE.Group()
  ads = false
  wantsVehicleToggle = false
  wantsPrattle = false
  readonly hits: HitFeedback[] = []
  readonly damageIndicators: DamageIndicator[] = []
  lowHealthPulse = 0
  /** Whiteout from an Awkward Silence, 1 at the moment of the blast. */
  flash = 0
  private fov = BASE_FOV
  private kick = 0
  private swayX = 0
  private swayY = 0
  private bobT = 0
  private adsAmount = 0
  private muzzleWorld = new THREE.Vector3()
  private muzzleLocal = new THREE.Vector3(0.18, -0.2, -0.9)
  private gunModels: THREE.Group[] = []
  private readonly muzzleLocals: THREE.Vector3[] = []
  private reloadTilt = 0
  /** Seconds left on the inhaler animation. Sprinting starts with a puff, because cardio. */
  private puff = 0
  private puffCooldown = 0
  private wasSprinting = false
  private readonly inhaler = buildInhaler()
  private cameraShakeT = 0
  private wheelCooldown = 0

  constructor(ctx: GameContext, team: Team, classId: ClassId, name: string, camera: THREE.PerspectiveCamera) {
    super(ctx, team, classId, name)
    this.camera = camera
    this.camera.add(this.viewmodel)
    this.mesh.setTagVisible(false)
    this.buildGuns()
  }

  override setLoadout(loadout: Loadout): void {
    super.setLoadout(loadout)
    this.buildGuns()
  }

  override stun(seconds: number): void {
    super.stun(seconds)
    this.flash = Math.max(this.flash, 1)
    this.ctx.audio.play('stun', { volume: 0.9 })
  }

  override switchWeapon(index: number): void {
    super.switchWeapon(index)
    this.showGun()
  }

  private showGun(): void {
    this.gunModels.forEach((g, i) => {
      g.visible = i === this.activeWeapon
    })
    const m = this.muzzleLocals[this.activeWeapon]
    if (m) this.muzzleLocal.copy(m)
  }

  /** One model per carried weapon, built once per class so swapping is a visibility toggle. */
  private buildGuns(): void {
    for (const g of this.gunModels) {
      this.viewmodel.remove(g)
      g.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose()
      })
    }
    this.muzzleLocals.length = 0
    this.gunModels = this.weapons.map((w) => this.buildGun(w.def.id))
    for (const g of this.gunModels) this.viewmodel.add(g)
    if (!this.inhaler.group.parent) this.viewmodel.add(this.inhaler.group)
    this.showGun()
  }

  private buildGun(id: string): THREE.Group {
    const g = new THREE.Group()
    const def = WEAPONS[id]
    if (!def) throw new Error(`unknown weapon ${id}`)
    const muzzle = new THREE.Vector3()
    const long = def.id === 'pointmaker' ? 1.5 : def.id === 'monologue' ? 1.15 : def.id === 'interruption' ? 1.2 : def.id === 'talkingpoint' ? 1.08 : def.id === 'sidebar' ? 0.55 : 1
    if (def.id === 'interruption') {
      // Side by side barrels and a wooden stock: reads as a shotgun at a glance.
      const stock = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.11, 0.45), tubeMat)
      stock.position.set(0, -0.04, 0.05)
      const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.12, 0.3), gunMat)
      receiver.position.set(0, 0, -0.25)
      const left = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.024, 0.75, 8), gunAccent)
      left.rotation.x = Math.PI / 2
      left.position.set(-0.025, 0.03, -0.72)
      const right = left.clone()
      right.position.x = 0.025
      const bead = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.03, 0.02), gunAccent)
      bead.position.set(0, 0.07, -1.05)
      g.add(stock, receiver, left, right, bead)
      muzzle.set(0, 0.03, -1.1)
    } else if (def.kind === 'rocket') {
      const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 1.3, 12), tubeMat)
      tube.rotation.x = Math.PI / 2
      tube.position.set(0.1, -0.02, -0.4)
      const sight = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.12, 0.2), gunAccent)
      sight.position.set(0.1, 0.12, -0.1)
      g.add(tube, sight)
      muzzle.set(0.1, -0.02, -1.05)
    } else {
      const body = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.14, 0.55 * long), gunMat)
      body.position.set(0, 0, -0.25 * long)
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.025, 0.5 * long, 8), gunAccent)
      barrel.rotation.x = Math.PI / 2
      barrel.position.set(0, 0.03, -0.7 * long)
      const mag = new THREE.Mesh(new THREE.BoxGeometry(0.06, def.id === 'monologue' ? 0.25 : 0.16, 0.12), gunMat)
      mag.position.set(0, -0.14, -0.2 * long)
      const stock = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.1, 0.25), gunMat)
      stock.position.set(0, -0.02, 0.15)
      const sight = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.05, 0.06), gunAccent)
      sight.position.set(0, 0.1, -0.2)
      g.add(body, barrel, mag, stock, sight)
      if (def.id === 'pointmaker') {
        const scope = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.3, 10), gunMat)
        scope.rotation.x = Math.PI / 2
        scope.position.set(0, 0.11, -0.3)
        g.add(scope)
      }
      muzzle.set(0, 0.03, -0.95 * long)
    }
    const hand = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 0.14), handMat)
    hand.position.set(0.02, -0.1, -0.05)
    const hand2 = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 0.14), handMat)
    hand2.position.set(-0.03, -0.05, -0.45 * long)
    g.add(hand, hand2)
    g.traverse((o) => {
      if (o instanceof THREE.Mesh) o.castShadow = false
    })
    this.muzzleLocals.push(muzzle)
    return g
  }

  override muzzlePosition(out: THREE.Vector3): THREE.Vector3 {
    return out.copy(this.muzzleWorld)
  }

  protected override onDamaged(amount: number, attacker: Combatant | null): void {
    if (attacker) {
      const dx = attacker.position.x - this.position.x
      const dz = attacker.position.z - this.position.z
      const worldAngle = Math.atan2(-dx, -dz)
      this.damageIndicators.push({ angle: wrapAngle(worldAngle - this.yaw), time: 1.2 })
    }
    this.ctx.effects.shake = Math.max(this.ctx.effects.shake, Math.min(0.5, amount / 60))
    this.ctx.audio.play('hit', { volume: 0.5, pitch: 0.7 })
  }

  protected override onDied(): void {
    this.ads = false
    this.mesh.group.visible = true
    this.mesh.setTagVisible(false)
    this.viewmodel.visible = false
    if (this.vehicle) {
      this.vehicle.exit()
      this.vehicle = null
    }
  }

  override spawnAt(x: number, z: number, yaw: number): void {
    super.spawnAt(x, z, yaw)
    this.viewmodel.visible = true
    this.mesh.setTagVisible(false)
    this.fov = BASE_FOV
    this.kick = 0
    this.hits.length = 0
    this.damageIndicators.length = 0
  }

  get scoped(): boolean {
    return this.weapon.def.adsFov <= SCOPE_FOV && this.adsAmount > 0.6
  }

  /** Reads input and drives movement, aiming and firing for one frame. */
  control(dt: number, input: Input): void {
    if (!this.alive) return
    const adsHeld = input.buttonDown(2) && !this.inVehicle
    this.ads = adsHeld
    const sens = SENS * (this.ads ? this.fov / BASE_FOV : 1)
    this.yaw -= input.mouseDX * sens
    this.pitch -= input.mouseDY * sens
    this.pitch = clamp(this.pitch, -1.45, 1.45)
    this.swayX = damp(this.swayX, clamp(-input.mouseDX * 0.0015, -0.05, 0.05), 10, dt)
    this.swayY = damp(this.swayY, clamp(input.mouseDY * 0.0015, -0.05, 0.05), 10, dt)

    if (input.wasPressed('KeyE')) this.wantsVehicleToggle = true
    if (input.wasPressed('KeyQ')) this.wantsPrattle = true
    if (this.inVehicle) return

    const forward = (input.isDown('KeyW') ? 1 : 0) - (input.isDown('KeyS') ? 1 : 0)
    const strafe = (input.isDown('KeyD') ? 1 : 0) - (input.isDown('KeyA') ? 1 : 0)
    const trigger = input.buttonDown(0)
    // Firing or aiming breaks sprint, the way a Battlefield player expects.
    this.move(dt, {
      forward,
      strafe,
      jump: input.wasPressed('Space'),
      sprint: (input.isDown('ShiftLeft') || input.isDown('ShiftRight')) && !trigger && !this.ads,
      crouch: input.isDown('KeyC') || input.isDown('ControlLeft'),
    })

    this.puffCooldown -= dt
    this.puff = Math.max(0, this.puff - dt)
    if (this.sprinting && !this.wasSprinting && this.puffCooldown <= 0) {
      this.puff = PUFF_SECONDS
      this.puffCooldown = PUFF_COOLDOWN
      this.ctx.audio.play('inhaler', { volume: 0.8 })
    }
    this.wasSprinting = this.sprinting

    if (input.wasPressed('Digit1')) this.switchWeapon(0)
    if (input.wasPressed('Digit2')) this.switchWeapon(1)
    this.wheelCooldown -= dt
    if (input.wheel !== 0 && this.wheelCooldown <= 0) {
      this.wheelCooldown = 0.25
      this.switchWeapon(this.activeWeapon === 0 ? 1 : 0)
    }
    if (input.wasPressed('KeyR') && this.weapon.startReload()) this.ctx.audio.play('reload')
    if (input.wasPressed('KeyG')) this.throwGrenade()

    const wasReloading = this.weapon.reloading
    const result = this.fire(trigger, this.ads)
    if (!wasReloading && this.weapon.reloading) this.ctx.audio.play('reload')
    if (trigger && this.weapon.empty && this.weapon.reserve <= 0 && input.buttonClicked(0)) this.ctx.audio.play('dryfire')
    if (result) {
      this.kick = Math.min(1, this.kick + 0.6)
      this.ctx.effects.shake = Math.max(this.ctx.effects.shake, this.weapon.def.recoil * 3)
      if (result.hitTarget) {
        this.hits.push({ time: 0.35, headshot: result.headshot, killed: result.killed })
        this.ctx.audio.play(result.headshot ? 'headshot' : 'hit', { volume: 0.7 })
      }
    }
  }

  /** Positions the camera and viewmodel after physics. */
  updateCamera(dt: number): void {
    const cam = this.camera
    // A little extra width while sprinting so the speed change reads on screen.
    const targetFov = this.ads ? this.weapon.def.adsFov : BASE_FOV + (this.sprinting ? SPRINT_FOV_BOOST : 0)
    this.fov = damp(this.fov, targetFov, 14, dt)
    if (Math.abs(cam.fov - this.fov) > 0.01) {
      cam.fov = this.fov
      cam.updateProjectionMatrix()
    }
    this.adsAmount = damp(this.adsAmount, this.ads ? 1 : 0, 14, dt)
    this.kick = damp(this.kick, 0, 12, dt)
    this.reloadTilt = damp(this.reloadTilt, this.weapon.reloading ? 1 : 0, 10, dt)
    for (let i = this.hits.length - 1; i >= 0; i--) {
      const h = this.hits[i]
      if (!h) continue
      h.time -= dt
      if (h.time <= 0) this.hits.splice(i, 1)
    }
    for (let i = this.damageIndicators.length - 1; i >= 0; i--) {
      const d = this.damageIndicators[i]
      if (!d) continue
      d.time -= dt
      if (d.time <= 0) this.damageIndicators.splice(i, 1)
    }
    this.lowHealthPulse = this.health < 35 ? (this.lowHealthPulse + dt * 4) % (Math.PI * 2) : 0
    // Hold near full white while stunned, then clear quickly once hearing returns.
    this.flash = this.stunned ? Math.max(this.flash - dt * 0.12, 0.6) : damp(this.flash, 0, 5, dt)
    this.cameraShakeT += dt * 40

    const shake = this.ctx.effects.shake
    const sx = Math.sin(this.cameraShakeT * 1.3) * shake * 0.04
    const sy = Math.cos(this.cameraShakeT * 1.7) * shake * 0.03

    if (this.inVehicle && this.vehicle) {
      const v = this.vehicle
      const dist = 9
      const cx = v.position.x + Math.sin(this.yaw) * dist * Math.cos(this.pitch)
      const cz = v.position.z + Math.cos(this.yaw) * dist * Math.cos(this.pitch)
      let cy = v.position.y + 3.2 - Math.sin(this.pitch) * dist
      const ground = this.ctx.world.heightAt(cx, cz) + 1.2
      if (cy < ground) cy = ground
      cam.position.set(cx, cy, cz)
      tmpV.copy(v.position).setY(v.position.y + 1.4)
      cam.lookAt(tmpV)
      cam.rotateZ(sx)
      this.viewmodel.visible = false
      this.mesh.group.visible = false
      return
    }

    // Scoped weapons hide the gun once the eye is in the glass; the HUD draws the scope instead of the tube blocking the view.
    this.viewmodel.visible = this.alive && !this.scoped
    this.mesh.group.visible = !this.alive
    const moving = this.grounded ? Math.min(1, this.speed / 5) : 0
    this.bobT += dt * (this.sprinting ? 11 : 8) * moving
    const bobX = Math.sin(this.bobT) * 0.012 * moving * (1 - this.adsAmount)
    const bobY = Math.abs(Math.cos(this.bobT)) * 0.014 * moving * (1 - this.adsAmount)
    this.eyePosition(cam.position)
    cam.position.y += bobY * 1.5
    cam.rotation.set(0, 0, 0, 'YXZ')
    cam.rotation.y = this.yaw
    cam.rotation.x = this.pitch + sy
    cam.rotation.z = sx + Math.sin(this.bobT) * 0.004 * moving

    const hipPos = tmpV.set(0.24, -0.22, -0.42)
    const adsPos = tmpV2.set(0, -0.1, -0.38)
    this.viewmodel.position.lerpVectors(hipPos, adsPos, this.adsAmount)
    this.viewmodel.position.x += this.swayX + bobX
    this.viewmodel.position.y += this.swayY * 0.5 + bobY - this.reloadTilt * 0.12
    this.viewmodel.position.z += this.kick * 0.06
    this.viewmodel.rotation.set(this.kick * 0.09 + this.swayY * 0.6 - this.reloadTilt * 0.35, this.swayX * 1.2, this.reloadTilt * 0.4 + this.swayX * 0.4)
    this.viewmodel.scale.setScalar(1 - this.adsAmount * 0.15)

    // Inhaler swings up to the mouth, pauses, drops away; the gun steps aside for it.
    const puffing = this.puff > 0
    const gun = this.gunModels[this.activeWeapon]
    if (gun) gun.visible = !puffing
    this.inhaler.group.visible = puffing
    if (puffing) {
      const t = 1 - this.puff / PUFF_SECONDS
      // Fast up, hold at the mouth through the middle, fast down.
      const raise = Math.min(1, Math.sin(Math.min(1, t * 1.1) * Math.PI) * 1.6)
      const held = raise >= 1
      const g = this.inhaler.group
      // Poses are in camera space; the inhaler is parented to the viewmodel, so remove that offset.
      // The mouth sits below the lens, so the held pose is low in frame with the canister rising into view.
      g.position.set(0.22 - raise * 0.19, -0.4 + raise * 0.23, -0.4 + raise * 0.17).sub(this.viewmodel.position)
      g.rotation.set(0.3 - raise * 0.12, -0.4 + raise * 0.25, 0.15 - raise * 0.1)
      this.inhaler.canister.position.y = held ? 0.066 : 0.075
    }
    cam.updateMatrixWorld(true)
    tmpQ.copy(this.viewmodel.getWorldQuaternion(tmpQ))
    this.muzzleWorld.copy(this.muzzleLocal).applyQuaternion(tmpQ).add(this.viewmodel.getWorldPosition(tmpV2))
  }

  get healthFraction(): number {
    return this.health / SOLDIER.maxHealth
  }

  get lookFov(): number {
    return lerp(BASE_FOV, this.weapon.def.adsFov, this.adsAmount)
  }
}
