import * as THREE from 'three'
import { FLAGS, MATCH, TEAMS } from '../config'
import type { Combatant, FlagDef, Team } from '../types'
import type { World } from './world'

const neutralColour = 0xdddddd
const poleGeo = new THREE.CylinderGeometry(0.08, 0.1, 7, 8)
const poleMat = new THREE.MeshStandardMaterial({ color: 0xbfc4c9, metalness: 0.5, roughness: 0.4 })
const clothGeo = new THREE.PlaneGeometry(2.2, 1.3, 6, 2)
const baseGeo = new THREE.CylinderGeometry(1.2, 1.4, 0.35, 16)
const baseMat = new THREE.MeshStandardMaterial({ color: 0x8c8c8c, roughness: 0.9 })
const ringGeo = new THREE.RingGeometry(0.85, 1, 48)
const insideScratch: Combatant[] = []

export interface FlagChange {
  readonly flag: Flag
  readonly previous: Team | null
  readonly owner: Team | null
  readonly capturers: readonly Combatant[]
}

export class Flag {
  readonly def: FlagDef
  owner: Team | null = null
  /** -1 (fully orange) .. 0 (neutral) .. +1 (fully blue). */
  progress = 0
  blueCount = 0
  orangeCount = 0
  /** How many bots per team currently have this flag as their objective. Spreads the AI out. */
  readonly targeting: Record<Team, number> = { blue: 0, orange: 0 }
  readonly group = new THREE.Group()
  readonly position: THREE.Vector3
  private readonly cloth: THREE.Mesh
  private readonly clothMat: THREE.MeshStandardMaterial
  private readonly ring: THREE.Mesh
  private readonly ringMat: THREE.MeshBasicMaterial
  private wave = Math.random() * 10

  constructor(def: FlagDef, world: World) {
    this.def = def
    const y = world.groundAt(def.x, def.z, world.heightAt(def.x, def.z) + 1)
    this.position = new THREE.Vector3(def.x, y, def.z)
    this.group.position.copy(this.position)
    const base = new THREE.Mesh(baseGeo, baseMat)
    base.position.y = 0.15
    base.receiveShadow = true
    base.castShadow = true
    const pole = new THREE.Mesh(poleGeo, poleMat)
    pole.position.y = 3.5
    pole.castShadow = true
    this.clothMat = new THREE.MeshStandardMaterial({ color: neutralColour, side: THREE.DoubleSide, roughness: 0.8 })
    this.cloth = new THREE.Mesh(clothGeo.clone(), this.clothMat)
    this.cloth.position.set(1.1, 6.2, 0)
    this.cloth.castShadow = true
    this.ringMat = new THREE.MeshBasicMaterial({ color: neutralColour, transparent: true, opacity: 0.35, depthWrite: false })
    this.ring = new THREE.Mesh(ringGeo, this.ringMat)
    this.ring.rotation.x = -Math.PI / 2
    this.ring.position.y = 0.12
    this.ring.scale.setScalar(def.radius)
    this.group.add(base, pole, this.cloth, this.ring)
    world.scene.add(this.group)
    world.addCollider({ kind: 'circle', x: def.x, z: def.z, r: 0.25, y0: y, y1: y + 7 })
  }

  contains(p: THREE.Vector3): boolean {
    const dx = p.x - this.def.x
    const dz = p.z - this.def.z
    return dx * dx + dz * dz <= this.def.radius * this.def.radius
  }

  get contested(): boolean {
    return this.blueCount > 0 && this.orangeCount > 0
  }

  /** Team currently pushing the bar, if any. */
  get capturingTeam(): Team | null {
    if (this.contested) return null
    if (this.blueCount > 0 && (this.owner !== 'blue' || this.progress < 1)) return 'blue'
    if (this.orangeCount > 0 && (this.owner !== 'orange' || this.progress > -1)) return 'orange'
    return null
  }

  private setVisual(team: Team | null): void {
    const colour = team ? (TEAMS.find((t) => t.id === team)?.colour ?? neutralColour) : neutralColour
    this.clothMat.color.setHex(colour)
    this.ringMat.color.setHex(colour)
  }

  /** Advances capture state. Returns a change event when ownership flips. */
  update(dt: number, combatants: readonly Combatant[]): FlagChange | null {
    this.blueCount = 0
    this.orangeCount = 0
    const inside = insideScratch
    inside.length = 0
    for (const c of combatants) {
      if (!c.alive || !this.contains(c.position)) continue
      inside.push(c)
      if (c.team === 'blue') this.blueCount += 1
      else this.orangeCount += 1
    }
    const rate = 1 / MATCH.captureSeconds
    if (!this.contested) {
      const diff = this.blueCount - this.orangeCount
      if (diff !== 0) {
        const boost = 1 + Math.min(3, Math.abs(diff) - 1) * 0.35
        this.progress += Math.sign(diff) * rate * boost * dt
      }
    }
    this.progress = Math.max(-1, Math.min(1, this.progress))
    const prev = this.owner
    if (this.progress >= 1) this.owner = 'blue'
    else if (this.progress <= -1) this.owner = 'orange'
    else if (this.owner === 'blue' && this.progress <= 0) this.owner = null
    else if (this.owner === 'orange' && this.progress >= 0) this.owner = null
    // Cloth hangs low while neutral and climbs as ownership firms up.
    this.wave += dt * 3
    const pos = this.cloth.geometry.attributes['position'] as THREE.BufferAttribute
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i)
      pos.setZ(i, Math.sin(this.wave + x * 2.2) * 0.12 * (x + 1.1))
    }
    pos.needsUpdate = true
    this.cloth.position.y = 3.2 + Math.abs(this.progress) * 3
    if (prev !== this.owner) {
      this.setVisual(this.owner)
      const capturers = inside.filter((c) => c.team === this.owner)
      return { flag: this, previous: prev, owner: this.owner, capturers }
    }
    return null
  }
}

export function createFlags(world: World): Flag[] {
  return FLAGS.map((def) => new Flag(def, world))
}

export function countOwned(flags: readonly Flag[], team: Team): number {
  return flags.reduce((n, f) => n + (f.owner === team ? 1 : 0), 0)
}
