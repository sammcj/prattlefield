import * as THREE from 'three'
import { MAP, TEAMS, VEHICLE } from '../config'
import type { GameContext } from '../context'
import type { Combatant, DamageSource, Damageable, Team } from '../types'
import type { Collider } from '../world/world'
import type { Soldier } from './soldier'
import { clamp, damp } from '../util/math'

export interface DriveInput {
  throttle: number
  steer: number
  brake: boolean
  horn: boolean
}

const bodyGeo = new THREE.BoxGeometry(2.1, 0.7, 4.6)
const cabGeo = new THREE.BoxGeometry(1.9, 0.8, 1.7)
const trayGeo = new THREE.BoxGeometry(1.9, 0.5, 2.0)
const bullbarGeo = new THREE.BoxGeometry(2.2, 0.5, 0.2)
const wheelGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.3, 12)
const lightGeo = new THREE.BoxGeometry(0.3, 0.2, 0.1)
const wheelMat = new THREE.MeshStandardMaterial({ color: 0x1e1e1e, roughness: 0.9 })
const glassMat = new THREE.MeshStandardMaterial({ color: 0x9fd0ff, roughness: 0.1, metalness: 0.4 })
const lightMat = new THREE.MeshStandardMaterial({ color: 0xfff4c0, emissive: 0xffe090, emissiveIntensity: 1.5 })
const bullbarMat = new THREE.MeshStandardMaterial({ color: 0xaaaaaa, metalness: 0.7, roughness: 0.3 })
const wreckMat = new THREE.MeshStandardMaterial({ color: 0x2a2724, roughness: 1 })

const tmpFwd = new THREE.Vector3()
const tmpQ = new THREE.Quaternion()
const tmpE = new THREE.Euler()

/**
 * The Ute: a kinematic vehicle that hugs the heightfield by sampling the
 * terrain under each wheel. One per HQ; respawns after being wrecked.
 */
export class Vehicle implements Damageable {
  readonly team = 'none' as const
  readonly displayName = VEHICLE.name
  readonly position = new THREE.Vector3()
  readonly group = new THREE.Group()
  readonly homeTeam: Team
  yaw = 0
  speed = 0
  health: number = VEHICLE.maxHealth
  driver: Soldier | null = null
  wrecked = false
  private respawnTimer = 0
  private readonly ctx: GameContext
  private readonly home: THREE.Vector3
  private readonly homeYaw: number
  private readonly collider: Collider
  private readonly wheels: THREE.Mesh[] = []
  private readonly bodyMat: THREE.MeshStandardMaterial
  private readonly bodyMesh: THREE.Mesh
  private readonly paintedMeshes: THREE.Mesh[] = []
  private pitch = 0
  private roll = 0
  private steerVisual = 0
  private lastAttacker: Combatant | null = null
  private dustAccum = 0
  private hornCooldown = 0

  constructor(ctx: GameContext, homeTeam: Team, x: number, z: number, yaw: number) {
    this.ctx = ctx
    this.homeTeam = homeTeam
    this.home = new THREE.Vector3(x, 0, z)
    this.homeYaw = yaw
    const teamDef = TEAMS.find((t) => t.id === homeTeam)
    this.bodyMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(teamDef?.colour ?? 0x888888).lerp(new THREE.Color(0xffffff), 0.15),
      roughness: 0.5,
      metalness: 0.3,
    })
    this.bodyMesh = new THREE.Mesh(bodyGeo, this.bodyMat)
    this.bodyMesh.position.y = 0.75
    this.bodyMesh.castShadow = true
    this.bodyMesh.receiveShadow = true
    const cab = new THREE.Mesh(cabGeo, this.bodyMat)
    cab.position.set(0, 1.5, -0.3)
    cab.castShadow = true
    const glass = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.5, 1.75), glassMat)
    glass.position.set(0, 1.55, -0.3)
    const tray = new THREE.Mesh(trayGeo, this.bodyMat)
    tray.position.set(0, 1.25, 1.3)
    tray.castShadow = true
    const bullbar = new THREE.Mesh(bullbarGeo, bullbarMat)
    bullbar.position.set(0, 0.8, -2.4)
    for (const sx of [-0.7, 0.7]) {
      const light = new THREE.Mesh(lightGeo, lightMat)
      light.position.set(sx, 0.9, -2.32)
      this.group.add(light)
    }
    this.group.add(this.bodyMesh, cab, glass, tray, bullbar)
    this.paintedMeshes.push(this.bodyMesh, cab, tray)
    for (const [wx, wz] of [
      [-1.05, -1.5],
      [1.05, -1.5],
      [-1.05, 1.5],
      [1.05, 1.5],
    ] as const) {
      const w = new THREE.Mesh(wheelGeo, wheelMat)
      w.rotation.z = Math.PI / 2
      w.position.set(wx, 0.42, wz)
      w.castShadow = true
      this.group.add(w)
      this.wheels.push(w)
    }
    ctx.world.scene.add(this.group)
    ctx.world.registerHitbox(this.bodyMesh, { damageable: this, headshot: false })
    ctx.world.registerHitbox(cab, { damageable: this, headshot: false })
    this.collider = { kind: 'circle', x, z, r: 1.7, y0: 0, y1: 2 }
    ctx.world.addCollider(this.collider)
    this.reset()
  }

  get alive(): boolean {
    return !this.wrecked
  }

  private reset(): void {
    this.position.set(this.home.x, this.ctx.world.heightAt(this.home.x, this.home.z), this.home.z)
    this.yaw = this.homeYaw
    this.speed = 0
    this.health = VEHICLE.maxHealth
    this.wrecked = false
    this.driver = null
    for (const m of this.paintedMeshes) m.material = this.bodyMat
    this.group.visible = true
    this.ctx.world.registerHitbox(this.bodyMesh, { damageable: this, headshot: false })
    this.syncTransform()
  }

  canEnter(soldier: Soldier): boolean {
    return !this.wrecked && this.driver === null && soldier.position.distanceTo(this.position) < 4
  }

  enter(soldier: Soldier): void {
    this.driver = soldier
    soldier.vehicle = this
    this.ctx.audio.play('enterVehicle', { position: this.position })
    if (soldier.isPlayer) this.ctx.audio.engine.start()
  }

  exit(): Soldier | null {
    const d = this.driver
    if (!d) return null
    this.driver = null
    d.vehicle = null
    tmpFwd.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw))
    d.position.copy(this.position).addScaledVector(tmpFwd, -2.4)
    d.position.y = this.ctx.world.heightAt(d.position.x, d.position.z)
    d.velocity.set(0, 0, 0)
    if (d.isPlayer) this.ctx.audio.engine.stop()
    return d
  }

  applyDamage(amount: number, attacker: Combatant | null, source: DamageSource): void {
    if (this.wrecked) return
    this.health -= amount
    if (attacker) this.lastAttacker = attacker
    if (this.health <= 0) this.wreck(source)
  }

  private wreck(_source: DamageSource): void {
    this.wrecked = true
    this.health = 0
    this.respawnTimer = VEHICLE.respawnDelay
    this.ctx.world.unregisterHitbox(this.bodyMesh)
    for (const m of this.paintedMeshes) m.material = wreckMat
    const driver = this.exit()
    this.ctx.projectiles.explode(this.position, 6, 150, this.lastAttacker, 'The Ute')
    if (driver && driver.alive) driver.applyDamage(999, this.lastAttacker, { kind: 'explosion', weaponName: 'The Ute' })
    this.speed = 0
  }

  private syncTransform(): void {
    this.group.position.copy(this.position)
    tmpE.set(this.pitch, this.yaw, this.roll, 'YXZ')
    tmpQ.setFromEuler(tmpE)
    this.group.quaternion.copy(tmpQ)
    this.collider.x = this.position.x
    this.collider.z = this.position.z
    this.collider.y0 = this.position.y - 0.5
    this.collider.y1 = this.position.y + 2
    this.group.updateMatrixWorld(true)
  }

  update(dt: number, input: DriveInput | null): void {
    if (this.wrecked) {
      this.respawnTimer -= dt
      if (this.respawnTimer <= 0) this.reset()
      return
    }
    const world = this.ctx.world
    const drive = this.driver && input ? input : null
    let throttle = drive ? drive.throttle : 0
    const steer = drive ? drive.steer : 0
    const braking = drive ? drive.brake : true
    this.hornCooldown -= dt
    if (drive?.horn && this.hornCooldown <= 0) {
      this.hornCooldown = 0.6
      this.ctx.audio.play('horn', { position: this.position })
    }
    const inWater = this.position.y < MAP.waterLevel + 0.3
    if (inWater) throttle *= 0.3

    if (throttle > 0) this.speed += VEHICLE.accel * throttle * dt
    else if (throttle < 0) this.speed -= (this.speed > 0 ? VEHICLE.brake : VEHICLE.accel * 0.6) * dt
    if (braking) this.speed = damp(this.speed, 0, 3, dt)
    this.speed -= this.speed * VEHICLE.drag * dt
    this.speed = clamp(this.speed, -VEHICLE.reverseSpeed, VEHICLE.maxSpeed)
    if (Math.abs(this.speed) < 0.05 && throttle === 0) this.speed = 0

    // Steering authority falls off with speed so it doesn't spin like a shopping trolley.
    const steerAuthority = clamp(Math.abs(this.speed) / 4, 0, 1) / (1 + Math.abs(this.speed) * 0.035)
    this.yaw -= steer * VEHICLE.steerRate * steerAuthority * Math.sign(this.speed || 1) * dt
    this.steerVisual = damp(this.steerVisual, steer * 0.5, 8, dt)

    tmpFwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw))
    const prevX = this.position.x
    const prevZ = this.position.z
    this.position.x += tmpFwd.x * this.speed * dt
    this.position.z += tmpFwd.z * this.speed * dt
    world.resolveCircle(this.position, 1.6, 1.8)
    const pushed = Math.hypot(this.position.x - prevX - tmpFwd.x * this.speed * dt, this.position.z - prevZ - tmpFwd.z * this.speed * dt)
    if (pushed > 0.05 && Math.abs(this.speed) > 4) {
      const impact = Math.abs(this.speed)
      this.speed *= -0.25
      this.ctx.audio.play('crash', { position: this.position, volume: clamp(impact / 20, 0.3, 1) })
      this.applyDamage(impact * 2.5, this.driver, { kind: 'vehicle' })
      this.ctx.effects.shake = Math.max(this.ctx.effects.shake, 0.4)
    }

    // Wheel contact: pitch from front/rear heights, roll from left/right.
    const cy = Math.cos(this.yaw)
    const sy = Math.sin(this.yaw)
    const sample = (lx: number, lz: number): number =>
      world.heightAt(this.position.x + lx * cy - lz * sy, this.position.z - lx * sy - lz * cy)
    const fl = sample(-1.05, 1.5)
    const fr = sample(1.05, 1.5)
    const rl = sample(-1.05, -1.5)
    const rr = sample(1.05, -1.5)
    const front = (fl + fr) / 2
    const rear = (rl + rr) / 2
    const left = (fl + rl) / 2
    const right = (fr + rr) / 2
    const targetY = (front + rear) / 2
    this.position.y = damp(this.position.y, targetY, 14, dt)
    this.pitch = damp(this.pitch, Math.atan2(front - rear, 3), 10, dt)
    this.roll = damp(this.roll, Math.atan2(right - left, 2.1), 10, dt)

    const wheelSpin = (this.speed * dt) / 0.42
    this.wheels.forEach((w, i) => {
      w.rotation.x += wheelSpin
      if (i < 2) w.rotation.y = this.steerVisual
    })

    if (Math.abs(this.speed) > 3) {
      this.dustAccum += dt * Math.abs(this.speed)
      if (this.dustAccum > 2) {
        this.dustAccum = 0
        this.ctx.effects.dust(this.position, 2)
      }
    }

    if (this.driver) {
      this.driver.position.copy(this.position)
      this.driver.position.y += 0.9
      this.driver.velocity.set(tmpFwd.x * this.speed, 0, tmpFwd.z * this.speed)
      if (this.driver.isPlayer) {
        this.ctx.audio.engine.setSpeed(Math.abs(this.speed) / VEHICLE.maxSpeed)
        this.ctx.audio.engine.setThrottle(Math.abs(throttle))
      }
      if (Math.abs(this.speed) > VEHICLE.roadkillSpeed) this.roadkill()
    }
    this.syncTransform()
  }

  private roadkill(): void {
    for (const c of this.ctx.combatants) {
      if (!c.alive || c === this.driver) continue
      const dx = c.position.x - this.position.x
      const dz = c.position.z - this.position.z
      if (dx * dx + dz * dz < 2.2 * 2.2 && Math.abs(c.position.y - this.position.y) < 2.5) {
        c.applyDamage(500, this.driver, { kind: 'vehicle' })
        this.ctx.audio.play('crash', { position: this.position, volume: 0.6 })
        this.speed *= 0.85
      }
    }
  }
}
