import * as THREE from 'three'
import { LEVOLUTION, THEME } from '../config'
import type { Combatant, Damageable, DamageSource } from '../types'
import { clamp, lerp, smoothstep } from '../util/math'
import type { Collider, World } from './world'

const UNIT_CYL = new THREE.CylinderGeometry(1, 1, 1, 10)
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1)
const UP = new THREE.Vector3(0, 1, 0)

const materialCache = new Map<string, THREE.MeshStandardMaterial>()

/** One flat-shaded material per colour so hundreds of props share GPU state instead of each carrying their own. */
export function solidMaterial(colour: number, roughness = 0.85, metalness = 0): THREE.MeshStandardMaterial {
  const key = `${colour}/${roughness}/${metalness}`
  let m = materialCache.get(key)
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color: colour, roughness, metalness, flatShading: true })
    materialCache.set(key, m)
  }
  return m
}

export interface TextOpts {
  readonly bg?: string
  readonly fg?: string
  readonly border?: string
  readonly width?: number
  readonly height?: number
  readonly size?: number
  readonly family?: string
  /** Draw the text this many times across the canvas; used for wrapping around cylinders. */
  readonly repeat?: number
}

/** Canvas-drawn sign text. Font size shrinks until the widest line fits so callers never need to tune it. */
export function makeTextTexture(lines: readonly string[], opts: TextOpts = {}): THREE.CanvasTexture {
  const w = opts.width ?? 512
  const h = opts.height ?? 128
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('2D canvas unavailable')
  if (opts.bg) {
    ctx.fillStyle = opts.bg
    ctx.fillRect(0, 0, w, h)
  }
  if (opts.border) {
    ctx.strokeStyle = opts.border
    ctx.lineWidth = Math.max(4, h * 0.05)
    ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, w - ctx.lineWidth, h - ctx.lineWidth)
  }
  const cols = opts.repeat ?? 1
  const cellW = w / cols
  const family = opts.family ?? 'Impact, "Arial Narrow", sans-serif'
  let size = opts.size ?? Math.floor(h / (lines.length + 0.5))
  const fits = (): boolean => {
    ctx.font = `bold ${size}px ${family}`
    return lines.every((l) => ctx.measureText(l).width <= cellW * 0.9)
  }
  while (!fits() && size > 8) size -= 2
  ctx.fillStyle = opts.fg ?? '#ffffff'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const lineH = size * 1.12
  const y0 = h / 2 - ((lines.length - 1) * lineH) / 2
  for (let c = 0; c < cols; c++) {
    lines.forEach((l, i) => ctx.fillText(l, cellW * (c + 0.5), y0 + i * lineH))
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 4
  return tex
}

/** Cylinder spanning two points: legs, braces, ladder rails and any leaning strut. */
export function strut(from: THREE.Vector3, to: THREE.Vector3, r: number, mat: THREE.Material): THREE.Mesh {
  const dir = to.clone().sub(from)
  const len = dir.length()
  const m = new THREE.Mesh(UNIT_CYL, mat)
  m.scale.set(r, len, r)
  m.position.copy(from).addScaledVector(dir, 0.5)
  m.quaternion.setFromUnitVectors(UP, dir.divideScalar(len))
  m.castShadow = true
  m.receiveShadow = true
  return m
}

const TANK_R = 5
const TANK_H = 6
const LEG_H = 18
const LEG_BASE_R = 4.4
const LEG_TOP_R = 2.8
const PAD_TOP = 0.3
// Bottom cone hangs a metre into the leg tops so the tank reads as sitting in a cradle.
const TANK_Y = PAD_TOP + LEG_H + 1 + TANK_H / 2
const COLLAPSE_TIME = 2.5
const FALL_DIST = 9.5
const TANK_COLOUR = 0xd9cfae
const SOOT = new THREE.Color(0x3a3530)

export class WaterTower implements Damageable {
  readonly team = 'none'
  readonly displayName = 'The Water Tower'
  readonly position: THREE.Vector3
  readonly group = new THREE.Group()
  hp: number = LEVOLUTION.hp
  collapsed = false
  onCollapse: ((tower: WaterTower) => void) | null = null

  private readonly world: World
  private readonly legs: THREE.Group[] = []
  private readonly legAxes: THREE.Vector3[] = []
  private readonly tank = new THREE.Group()
  private readonly tankMat: THREE.MeshStandardMaterial
  private readonly hitMeshes: THREE.Object3D[] = []
  private readonly legVolume: THREE.Mesh
  private readonly legColliders: Collider[] = []
  private readonly restY: number
  // -1 while standing; counts up to COLLAPSE_TIME during the fall, then the tower is static.
  private fallT = -1

  constructor(world: World) {
    this.world = world
    const x = LEVOLUTION.towerX
    const z = LEVOLUTION.towerZ
    const ground = world.heightAt(x, z)
    this.position = new THREE.Vector3(x, ground, z)
    this.group.position.copy(this.position)
    this.tankMat = new THREE.MeshStandardMaterial({ color: TANK_COLOUR, roughness: 0.8, flatShading: true })
    this.legVolume = new THREE.Mesh(UNIT_BOX, new THREE.MeshBasicMaterial({ visible: false }))
    this.buildPad()
    this.buildLegs()
    this.buildTank()
    // The tank lands beside the legs; its rest height follows the terrain there so it doesn't sink into a slope.
    let landing = -Infinity
    for (const dz of [4, FALL_DIST, 15]) landing = Math.max(landing, world.heightAt(x, z + dz))
    this.restY = landing - ground + TANK_R
    world.scene.add(this.group)
    world.addSolid(this.group)
  }

  get alive(): boolean {
    return !this.collapsed
  }

  get damageFraction(): number {
    return 1 - this.hp / LEVOLUTION.hp
  }

  applyDamage(amount: number, _attacker: Combatant | null, source: DamageSource): void {
    if (this.collapsed || amount <= 0) return
    // Small arms only chip it; explosives are what bring it down.
    const scaled = source.kind === 'weapon' ? amount * 0.25 : amount
    this.hp = Math.max(0, this.hp - scaled)
    // Soot and a hot glow creep in past half health so players can read that the tower is close to going.
    const strain = smoothstep(0.5, 1, this.damageFraction)
    this.tankMat.color.setHex(TANK_COLOUR).lerp(SOOT, strain * 0.7)
    this.tankMat.emissive.setHex(0x4a1a08).multiplyScalar(strain * 0.6)
    if (this.hp === 0) this.collapse()
  }

  update(dt: number): void {
    if (this.fallT < 0 || this.fallT >= COLLAPSE_TIME) return
    this.fallT = Math.min(COLLAPSE_TIME, this.fallT + dt)
    const t = this.fallT / COLLAPSE_TIME
    const buckle = smoothstep(0, 0.55, t)
    this.legs.forEach((leg, i) => {
      const axis = this.legAxes[i]
      if (!axis) return
      // Uneven angles per leg so the lattice crumples rather than folding symmetrically.
      leg.quaternion.setFromAxisAngle(axis, (0.35 + 0.22 * (i % 3)) * buckle)
      leg.scale.y = 1 - 0.45 * buckle
    })
    const f = clamp(t / 0.72, 0, 1)
    this.tank.position.y = lerp(TANK_Y, this.restY, f * f)
    this.tank.position.z = FALL_DIST * Math.pow(f, 1.4)
    this.tank.rotation.x = (Math.PI / 2) * Math.pow(f, 1.7)
    if (t > 0.72) {
      const u = (t - 0.72) / 0.28
      this.tank.position.y = this.restY + 1.3 * Math.sin(Math.PI * u) * (1 - u * 0.5)
      // A little roll while it settles keeps the landing from looking like it snapped into place.
      this.tank.rotation.y = 0.35 * Math.sin(Math.PI * u)
    }
  }

  private collapse(): void {
    this.collapsed = true
    this.fallT = 0
    for (const m of this.hitMeshes) this.world.unregisterHitbox(m)
    // The lattice volume would otherwise linger as an invisible wall once the legs have crumpled.
    this.legVolume.removeFromParent()
    for (const c of this.legColliders) {
      const i = this.world.colliders.indexOf(c)
      if (i >= 0) this.world.colliders.splice(i, 1)
    }
    const ground = this.position.y
    this.world.addCollider({
      kind: 'box',
      x: this.position.x,
      z: this.position.z + FALL_DIST + 0.5,
      hx: TANK_R + 0.4,
      hz: TANK_H / 2 + 2.6,
      y0: ground,
      y1: ground + this.restY + TANK_R,
    })
    const hook = this.onCollapse
    if (hook) hook(this)
  }

  private buildPad(): void {
    const pad = new THREE.Mesh(UNIT_BOX, solidMaterial(0x8f8c84))
    // Extends below ground so a sloped site never shows daylight under the slab.
    pad.scale.set(LEG_BASE_R * 2.6, PAD_TOP + 1.5, LEG_BASE_R * 2.6)
    pad.position.y = PAD_TOP - pad.scale.y / 2
    pad.castShadow = true
    pad.receiveShadow = true
    this.group.add(pad)
    const hx = LEG_BASE_R * 1.3
    this.world.addCollider({ kind: 'box', x: this.position.x, z: this.position.z, hx, hz: hx, y0: this.position.y - 1, y1: this.position.y + PAD_TOP })
  }

  private buildLegs(): void {
    const steel = solidMaterial(0x6e6a63, 0.6, 0.5)
    const legPoint = (i: number, r: number, y: number): THREE.Vector3 => {
      const a = ((i + 0.5) * Math.PI) / 2
      return new THREE.Vector3(Math.sin(a) * r, y, Math.cos(a) * r)
    }
    for (let i = 0; i < 4; i++) {
      const a = ((i + 0.5) * Math.PI) / 2
      const base = legPoint(i, LEG_BASE_R, PAD_TOP)
      const top = legPoint(i, LEG_TOP_R, PAD_TOP + LEG_H)
      const nextBase = legPoint(i + 1, LEG_BASE_R, PAD_TOP)
      const nextTop = legPoint(i + 1, LEG_TOP_R, PAD_TOP + LEG_H)
      const leg = new THREE.Group()
      leg.position.copy(base)
      const local = (p: THREE.Vector3): THREE.Vector3 => p.clone().sub(base)
      const at = (b: THREE.Vector3, t: THREE.Vector3, h: number): THREE.Vector3 => local(b.clone().lerp(t, h / LEG_H))
      leg.add(strut(new THREE.Vector3(), local(top), 0.32, steel))
      // Braces belong to the leg they start from so they crumple with it during the collapse.
      for (let h = 0; h < LEG_H; h += 6) {
        const p0 = at(base, top, h)
        const p1 = at(nextBase, nextTop, h)
        const p2 = at(base, top, h + 6)
        const p3 = at(nextBase, nextTop, h + 6)
        leg.add(strut(p2, p3, 0.12, steel), strut(p0, p3, 0.09, steel), strut(p1, p2, 0.09, steel))
      }
      if (i === 0) this.buildLadder(leg, local(top), a)
      this.legs.push(leg)
      // Tangent axis: positive rotation about it leans the leg top outward.
      this.legAxes.push(new THREE.Vector3(Math.cos(a), 0, -Math.sin(a)))
      this.group.add(leg)
      const c: Collider = {
        kind: 'circle',
        x: this.position.x + base.x,
        z: this.position.z + base.z,
        r: 0.7,
        y0: this.position.y,
        y1: this.position.y + LEG_H,
      }
      this.legColliders.push(c)
      this.world.addCollider(c)
    }
  }

  private buildLadder(leg: THREE.Group, top: THREE.Vector3, angle: number): void {
    const steel = solidMaterial(0x4f4b45, 0.6, 0.5)
    const out = new THREE.Vector3(Math.sin(angle), 0, Math.cos(angle)).multiplyScalar(0.45)
    const side = new THREE.Vector3(Math.cos(angle), 0, -Math.sin(angle)).multiplyScalar(0.28)
    for (const s of [-1, 1]) {
      const off = out.clone().addScaledVector(side, s)
      leg.add(strut(off, top.clone().add(off), 0.05, steel))
    }
    const rungs = new THREE.InstancedMesh(UNIT_BOX, steel, 19)
    const m = new THREE.Matrix4()
    const q = new THREE.Quaternion().setFromAxisAngle(UP, angle)
    const scale = new THREE.Vector3(0.62, 0.05, 0.05)
    for (let i = 0; i < 19; i++) {
      const p = top.clone().multiplyScalar((i + 0.5) / 19).add(out)
      rungs.setMatrixAt(i, m.compose(p, q, scale))
    }
    rungs.castShadow = true
    leg.add(rungs)
  }

  private buildTank(): void {
    const body = new THREE.Mesh(new THREE.CylinderGeometry(TANK_R, TANK_R, TANK_H, 14), this.tankMat)
    const roof = new THREE.Mesh(new THREE.ConeGeometry(TANK_R + 0.4, 2.6, 14), solidMaterial(THEME.roof))
    roof.position.y = TANK_H / 2 + 1.3
    const bottom = new THREE.Mesh(new THREE.ConeGeometry(TANK_R, 2, 14), this.tankMat)
    bottom.rotation.x = Math.PI
    bottom.position.y = -TANK_H / 2 - 1
    const finial = new THREE.Mesh(UNIT_CYL, solidMaterial(0x4a4a4a, 0.5, 0.6))
    finial.scale.set(0.25, 1.2, 0.25)
    finial.position.y = TANK_H / 2 + 3
    const band = solidMaterial(0x4a4a4a, 0.5, 0.6)
    const hoopGeo = new THREE.TorusGeometry(TANK_R + 0.05, 0.12, 5, 20)
    const parts: THREE.Mesh[] = [body, roof, bottom, finial]
    for (const y of [-2.4, 2.4]) {
      const hoop = new THREE.Mesh(hoopGeo, band)
      hoop.rotation.x = Math.PI / 2
      hoop.position.y = y
      parts.push(hoop)
    }
    // Transparent sleeve just outside the tank carries the painted name; the text repeats so it reads from two sides.
    const sign = new THREE.Mesh(
      new THREE.CylinderGeometry(TANK_R + 0.06, TANK_R + 0.06, 2.4, 24, 1, true),
      new THREE.MeshStandardMaterial({
        map: makeTextTexture(['PRATTLEFIELD'], { fg: '#7a1f1f', width: 2048, height: 256, repeat: 2 }),
        transparent: true,
        roughness: 0.8,
      }),
    )
    sign.position.y = 0.2
    parts.push(sign)
    for (const p of parts) {
      p.castShadow = true
      p.receiveShadow = true
      this.tank.add(p)
    }
    // Hit volume sits just outside the sign sleeve and hoops so those solids can't shield the tank from damage.
    // Enough segments that its flat faces still clear the 24-sided sign sleeve.
    const tankVolume = new THREE.Mesh(new THREE.CylinderGeometry(TANK_R + 0.4, TANK_R + 0.4, TANK_H + 1.6, 24), this.legVolume.material)
    this.tank.add(tankVolume)
    this.tank.position.y = TANK_Y
    this.group.add(this.tank)
    this.world.registerHitbox(tankVolume, { damageable: this, headshot: false })
    // Invisible volume around the lattice so shots through the gaps still count against the tower.
    this.legVolume.scale.set(LEG_BASE_R * 1.7, LEG_H, LEG_BASE_R * 1.7)
    this.legVolume.position.y = PAD_TOP + LEG_H / 2
    this.group.add(this.legVolume)
    this.world.registerHitbox(this.legVolume, { damageable: this, headshot: false })
    this.hitMeshes.push(tankVolume, this.legVolume)
  }
}
