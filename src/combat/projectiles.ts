import * as THREE from 'three'
import { MAP, ROCKET } from '../config'
import type { GameContext } from '../context'
import type { Combatant, GrenadeDef, WeaponDef } from '../types'

interface Grenade {
  readonly mesh: THREE.Mesh
  readonly vel: THREE.Vector3
  readonly owner: Combatant
  readonly def: GrenadeDef
  fuse: number
  bounced: number
}

const GRENADE_GRAVITY = 20
const STUN_SECONDS = 3.5

interface Rocket {
  readonly mesh: THREE.Group
  readonly vel: THREE.Vector3
  readonly owner: Combatant
  readonly weapon: WeaponDef
  life: number
  smoke: number
}

const grenadeGeo = new THREE.SphereGeometry(0.14, 8, 6)
const grenadeMats = new Map<number, THREE.MeshStandardMaterial>()
function grenadeMaterial(colour: number): THREE.MeshStandardMaterial {
  let m = grenadeMats.get(colour)
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color: colour, roughness: 0.7, metalness: 0.3 })
    grenadeMats.set(colour, m)
  }
  return m
}
const rocketBodyGeo = new THREE.CylinderGeometry(0.08, 0.08, 0.7, 8)
const rocketTipGeo = new THREE.ConeGeometry(0.1, 0.25, 8)
const rocketMat = new THREE.MeshStandardMaterial({ color: 0x556b2f, roughness: 0.6 })
const rocketTipMat = new THREE.MeshStandardMaterial({ color: 0xc0392b, roughness: 0.5 })

/**
 * Thrown and launched things with simple ballistic motion. Both kinds end in
 * `explode`, which applies falloff damage to every damageable in range with
 * line-of-sight.
 */
export class Projectiles {
  readonly group = new THREE.Group()
  private readonly grenades: Grenade[] = []
  private readonly rockets: Rocket[] = []
  private ctx: GameContext | null = null
  private readonly tmp = new THREE.Vector3()
  private readonly tmp2 = new THREE.Vector3()

  bind(ctx: GameContext): void {
    this.ctx = ctx
  }

  throwGrenade(owner: Combatant, origin: THREE.Vector3, dir: THREE.Vector3, def: GrenadeDef, extraSpeed = 0): void {
    const mesh = new THREE.Mesh(grenadeGeo, grenadeMaterial(def.colour))
    mesh.castShadow = true
    mesh.position.copy(origin)
    this.group.add(mesh)
    const vel = dir.clone().multiplyScalar(def.throwSpeed + extraSpeed)
    vel.y += 2
    this.grenades.push({ mesh, vel, owner, def, fuse: def.fuse, bounced: 0 })
    this.ctx?.audio.play('pin', { position: origin })
  }

  /** Everyone inside the radius with a clear line to the blast loses their aim, thrower and team included. */
  private stunBurst(position: THREE.Vector3, def: GrenadeDef, attacker: Combatant): void {
    const ctx = this.ctx
    if (!ctx) return
    ctx.effects.explosion(position, def.radius * 0.6)
    ctx.audio.play('stun', { position })
    ctx.events.onExplosion(position, def.radius * 0.5)
    const eye = this.tmp.copy(position)
    eye.y += 0.5
    for (const c of ctx.combatants) {
      if (!c.alive) continue
      const target = this.tmp2.copy(c.position)
      target.y += 0.9
      const dist = target.distanceTo(position)
      if (dist > def.radius) continue
      if (dist > 1.5 && !ctx.world.hasLineOfSight(eye, target)) continue
      c.stun(STUN_SECONDS * (1 - (dist / def.radius) * 0.5))
      c.applyDamage(def.damage, attacker, { kind: 'explosion', weaponName: def.name })
    }
  }

  private detonateGrenade(g: Grenade): void {
    if (g.def.kind === 'stun') this.stunBurst(g.mesh.position, g.def, g.owner)
    else this.explode(g.mesh.position, g.def.radius, g.def.damage, g.owner, g.def.name)
  }

  spawnRocket(owner: Combatant, origin: THREE.Vector3, dir: THREE.Vector3, weapon: WeaponDef): void {
    const mesh = new THREE.Group()
    const body = new THREE.Mesh(rocketBodyGeo, rocketMat)
    body.rotation.x = Math.PI / 2
    const tip = new THREE.Mesh(rocketTipGeo, rocketTipMat)
    tip.rotation.x = Math.PI / 2
    tip.position.z = 0.45
    mesh.add(body, tip)
    mesh.position.copy(origin)
    mesh.lookAt(origin.clone().add(dir))
    this.group.add(mesh)
    this.rockets.push({ mesh, vel: dir.clone().multiplyScalar(ROCKET.speed), owner, weapon, life: ROCKET.lifetime, smoke: 0 })
  }

  explode(position: THREE.Vector3, radius: number, damage: number, attacker: Combatant | null, weaponName: string): void {
    const ctx = this.ctx
    if (!ctx) return
    ctx.effects.explosion(position, radius)
    ctx.audio.play('explosion', { position })
    ctx.events.onExplosion(position, radius)
    const eye = this.tmp.copy(position)
    eye.y += 0.5
    for (const d of ctx.damageables) {
      if (!d.alive) continue
      const target = this.tmp2.copy(d.position)
      target.y += 0.9
      const dist = target.distanceTo(position)
      if (dist > radius) continue
      if (dist > 1.5 && !ctx.world.hasLineOfSight(eye, target)) continue
      const falloff = 1 - Math.pow(dist / radius, 1.6)
      const amount = damage * Math.max(0.15, falloff)
      d.applyDamage(amount, attacker, { kind: 'explosion', weaponName })
    }
  }

  update(dt: number): void {
    const ctx = this.ctx
    if (!ctx) return
    for (let i = this.grenades.length - 1; i >= 0; i--) {
      const g = this.grenades[i]
      if (!g) continue
      g.fuse -= dt
      g.vel.y -= GRENADE_GRAVITY * dt
      const p = g.mesh.position
      const impact = g.def.kind === 'impact'
      if (impact) {
        // Impact grenades stop at the first thing they touch, people included.
        const step = this.tmp.copy(g.vel).multiplyScalar(dt)
        const len = step.length()
        const dir = this.tmp2.copy(step).divideScalar(len || 1)
        const hit = ctx.world.raycast(p, dir, len + 0.2, g.owner)
        if (hit) {
          p.copy(hit.point).addScaledVector(dir, -0.15)
          g.fuse = 0
        }
      }
      if (g.fuse > 0) p.addScaledVector(g.vel, dt)
      g.mesh.rotation.x += dt * 6
      g.mesh.rotation.z += dt * 4
      const ground = ctx.world.groundAt(p.x, p.z, p.y)
      if (p.y < ground + 0.14) {
        p.y = ground + 0.14
        if (impact) g.fuse = 0
        else if (g.vel.y < -1.5) {
          g.vel.y = -g.vel.y * g.def.bounce
          g.vel.x *= 0.6
          g.vel.z *= 0.6
          g.bounced += 1
          ctx.audio.play('grenadeBounce', { position: p, volume: 0.6 })
        } else {
          g.vel.y = 0
          g.vel.x *= 1 - Math.min(1, dt * 4)
          g.vel.z *= 1 - Math.min(1, dt * 4)
        }
      }
      ctx.world.resolveCircle(p, 0.15, 0.2)
      if (p.y < MAP.waterLevel - 0.5 && g.fuse > 0.4) g.fuse = 0.4
      if (g.fuse <= 0) {
        this.detonateGrenade(g)
        this.group.remove(g.mesh)
        this.grenades.splice(i, 1)
      }
    }

    for (let i = this.rockets.length - 1; i >= 0; i--) {
      const r = this.rockets[i]
      if (!r) continue
      r.life -= dt
      r.vel.y -= ROCKET.gravity * dt
      const p = r.mesh.position
      const step = this.tmp.copy(r.vel).multiplyScalar(dt)
      const len = step.length()
      const dir = this.tmp2.copy(step).divideScalar(len || 1)
      const hit = ctx.world.raycast(p, dir, len + 0.3, r.owner)
      r.smoke += dt
      while (r.smoke > 0.012) {
        r.smoke -= 0.012
        ctx.effects.dust(p, 1)
      }
      let detonate = r.life <= 0
      if (hit) {
        p.copy(hit.point).addScaledVector(dir, -0.2)
        detonate = true
      } else {
        p.add(step)
        r.mesh.lookAt(p.x + r.vel.x, p.y + r.vel.y, p.z + r.vel.z)
      }
      if (detonate) {
        this.explode(p, ROCKET.radius, r.weapon.damage, r.owner, r.weapon.name)
        this.group.remove(r.mesh)
        this.rockets.splice(i, 1)
      }
    }
  }
}
