import * as THREE from 'three'
import type { Damageable, HitResult } from '../types'
import { MAP } from '../config'
import { buildTerrain, buildWater, heightAt, normalAt, raymarchTerrain } from './terrain'

export type Collider =
  | { readonly kind: 'box'; x: number; z: number; hx: number; hz: number; y0: number; y1: number }
  | { readonly kind: 'circle'; x: number; z: number; r: number; y0: number; y1: number }

export interface HitboxOwner {
  readonly damageable: Damageable
  readonly headshot: boolean
}

/**
 * Owns the static scene: terrain, water, props, colliders and the list of
 * meshes bullets can hit. Entities register hitboxes here so combat can
 * resolve a single raycast against everything.
 */
export class World {
  readonly scene: THREE.Scene
  readonly terrain: THREE.Mesh
  readonly colliders: Collider[] = []
  readonly solids: THREE.Object3D[] = []
  readonly hitboxes: THREE.Object3D[] = []
  private readonly raycaster = new THREE.Raycaster()
  private readonly tmpN = new THREE.Vector3()
  private readonly tmpDir = new THREE.Vector3()

  constructor(scene: THREE.Scene) {
    this.scene = scene
    this.terrain = buildTerrain()
    scene.add(this.terrain)
    scene.add(buildWater())
  }

  heightAt(x: number, z: number): number {
    return heightAt(x, z)
  }

  addCollider(c: Collider): void {
    this.colliders.push(c)
  }

  addSolid(obj: THREE.Object3D): void {
    this.solids.push(obj)
  }

  removeSolid(obj: THREE.Object3D): void {
    const i = this.solids.indexOf(obj)
    if (i >= 0) this.solids.splice(i, 1)
  }

  registerHitbox(mesh: THREE.Object3D, owner: HitboxOwner): void {
    mesh.userData['hitbox'] = owner
    this.hitboxes.push(mesh)
  }

  unregisterHitbox(mesh: THREE.Object3D): void {
    const i = this.hitboxes.indexOf(mesh)
    if (i >= 0) this.hitboxes.splice(i, 1)
  }

  /** Ground height including the tops of box colliders the point stands on. */
  groundAt(x: number, z: number, y: number): number {
    let g = heightAt(x, z)
    for (const c of this.colliders) {
      if (c.kind !== 'box') continue
      if (Math.abs(x - c.x) <= c.hx && Math.abs(z - c.z) <= c.hz && y >= c.y1 - 0.6 && c.y1 > g) g = c.y1
    }
    return g
  }

  /** Pushes a circle (x,z,r) at height range out of overlapping colliders. Mutates pos. */
  resolveCircle(pos: THREE.Vector3, r: number, height: number): void {
    const y0 = pos.y
    const y1 = pos.y + height
    for (const c of this.colliders) {
      if (y1 <= c.y0 + 0.05 || y0 >= c.y1 - 0.35) continue
      if (c.kind === 'circle') {
        const dx = pos.x - c.x
        const dz = pos.z - c.z
        const d = Math.sqrt(dx * dx + dz * dz)
        const minD = c.r + r
        if (d < minD && d > 1e-5) {
          const push = (minD - d) / d
          pos.x += dx * push
          pos.z += dz * push
        }
      } else {
        const dx = pos.x - c.x
        const dz = pos.z - c.z
        const ox = c.hx + r - Math.abs(dx)
        const oz = c.hz + r - Math.abs(dz)
        if (ox > 0 && oz > 0) {
          if (ox < oz) pos.x += Math.sign(dx || 1) * ox
          else pos.z += Math.sign(dz || 1) * oz
        }
      }
    }
    const lim = MAP.half - 2
    if (pos.x > lim) pos.x = lim
    if (pos.x < -lim) pos.x = -lim
    if (pos.z > lim) pos.z = lim
    if (pos.z < -lim) pos.z = -lim
  }

  /** Full raycast: hitboxes, props, then terrain. `ignore` skips a set of hitbox owners. */
  raycast(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    maxDist: number,
    ignore: Damageable | null = null,
  ): HitResult | null {
    this.raycaster.set(origin, dir)
    this.raycaster.near = 0.05
    this.raycaster.far = maxDist
    let best: HitResult | null = null
    const hits = this.raycaster.intersectObjects(this.hitboxes, false)
    for (const h of hits) {
      const owner = h.object.userData['hitbox'] as HitboxOwner | undefined
      if (!owner || !owner.damageable.alive) continue
      if (ignore !== null && owner.damageable === ignore) continue
      best = {
        point: h.point,
        normal: h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : dir.clone().negate(),
        distance: h.distance,
        target: owner.damageable,
        headshot: owner.headshot,
      }
      break
    }
    const limit = best ? best.distance : maxDist
    this.raycaster.far = limit
    const solidHits = this.raycaster.intersectObjects(this.solids, true)
    const s = solidHits[0]
    if (s && s.distance < limit) {
      best = {
        point: s.point,
        normal: s.face ? s.face.normal.clone().transformDirection(s.object.matrixWorld) : dir.clone().negate(),
        distance: s.distance,
        target: null,
        headshot: false,
      }
    }
    const tLimit = best ? best.distance : maxDist
    const t = raymarchTerrain(origin, dir, tLimit)
    if (t !== null && t < tLimit) {
      const p = origin.clone().addScaledVector(dir, t)
      best = { point: p, normal: normalAt(p.x, p.z, this.tmpN).clone(), distance: t, target: null, headshot: false }
    }
    return best
  }

  /** Cheap line-of-sight check used by bots: props and terrain only. */
  hasLineOfSight(from: THREE.Vector3, to: THREE.Vector3): boolean {
    const dir = this.tmpDir.copy(to).sub(from)
    const dist = dir.length()
    if (dist < 0.01) return true
    dir.divideScalar(dist)
    if (raymarchTerrain(from, dir, dist) !== null) return false
    this.raycaster.set(from, dir)
    this.raycaster.near = 0.05
    this.raycaster.far = dist
    return this.raycaster.intersectObjects(this.solids, true).length === 0
  }
}
