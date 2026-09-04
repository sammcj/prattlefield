import * as THREE from 'three'
import { FLAGS, LEVOLUTION, MAP, TEAMS, THEME } from '../config'
import type { FlagDef, TeamDef } from '../types'
import { dist2d } from '../util/math'
import { fbm, mulberry32 } from '../util/noise'
import { slopeAt } from './terrain'
import { makeTextTexture, solidMaterial, WaterTower, type TextOpts } from './tower'
import type { World } from './world'

export interface PropsResult {
  readonly levolution: WaterTower
}

type Rng = () => number
type OpenTest = (x: number, z: number, margin?: number) => boolean

const BOX = new THREE.BoxGeometry(1, 1, 1)
const CYL = new THREE.CylinderGeometry(1, 1, 1, 10)
const CONE = new THREE.ConeGeometry(1, 1, 7)
const PYRAMID = new THREE.ConeGeometry(1, 1, 4)
const ICO = new THREE.IcosahedronGeometry(1, 0)
const PUFF = new THREE.IcosahedronGeometry(1, 1)
const PLANE = new THREE.PlaneGeometry(1, 1)
const TYRE = new THREE.TorusGeometry(0.45, 0.16, 6, 14)
// A 3-sided cylinder tipped onto its side is a triangular prism: flat base at y=-0.5, ridge at y=1, length along z.
const PRISM = new THREE.CylinderGeometry(1, 1, 1, 3).rotateX(-Math.PI / 2)
const PRISM_W = Math.sqrt(3)
const PRISM_H = 1.5

const M = {
  wood: solidMaterial(0x7a5a3a),
  darkWood: solidMaterial(0x4d3520),
  timber: solidMaterial(0xd9b98a),
  wall: solidMaterial(THEME.building),
  roof: solidMaterial(THEME.roof),
  metal: solidMaterial(THEME.metal, 0.5, 0.6),
  tin: solidMaterial(0x8f9296, 0.6, 0.5),
  dark: solidMaterial(0x2b2b2b),
  glass: solidMaterial(0x3b5266, 0.3, 0.4),
  white: solidMaterial(0xf0efe8),
  concrete: solidMaterial(0x9d9a92),
  sandbag: solidMaterial(0xa8956a),
  canvas: solidMaterial(0x6d7a4f),
  red: solidMaterial(0xc8202a),
  green: solidMaterial(0x1f6b3a),
  blue: solidMaterial(0x2a63c2),
  bus: solidMaterial(0xe8c33a),
  rubber: solidMaterial(0x1e1e1e, 0.9),
  hay: solidMaterial(0xd8b45a),
  mound: solidMaterial(THEME.grassDark),
  trunk: solidMaterial(THEME.trunk),
  leaf: solidMaterial(0xffffff),
  rock: solidMaterial(0xffffff, 0.95),
  bronze: new THREE.MeshStandardMaterial({ color: 0xb08d57, roughness: 0.4, metalness: 0.7, flatShading: true, side: THREE.DoubleSide }),
  road: new THREE.MeshStandardMaterial({ color: 0x6f5a40, roughness: 1, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1 }),
  cloud: new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, roughness: 1, flatShading: true }),
}

/** Builds one set piece: a group anchored at a world point, with helpers that also register colliders in world space. */
class Kit {
  readonly group = new THREE.Group()

  constructor(
    private readonly world: World,
    private readonly ox: number,
    private readonly oy: number,
    private readonly oz: number,
  ) {
    this.group.position.set(ox, oy, oz)
  }

  add<T extends THREE.Object3D>(obj: T): T {
    obj.castShadow = true
    obj.receiveShadow = true
    this.group.add(obj)
    return obj
  }

  private place(geo: THREE.BufferGeometry, mat: THREE.Material, sx: number, sy: number, sz: number, x: number, y: number, z: number): THREE.Mesh {
    const m = new THREE.Mesh(geo, mat)
    m.scale.set(sx, sy, sz)
    m.position.set(x, y, z)
    return this.add(m)
  }

  /** y is the base of the box. */
  box(w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material, collide = false): THREE.Mesh {
    if (collide) this.collideBox(x, z, w / 2, d / 2, y, y + h)
    return this.place(BOX, mat, w, h, d, x, y + h / 2, z)
  }

  cyl(r: number, h: number, x: number, y: number, z: number, mat: THREE.Material, collide = false): THREE.Mesh {
    if (collide) this.collideCircle(x, z, r, y, y + h)
    return this.place(CYL, mat, r, h, r, x, y + h / 2, z)
  }

  prism(w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material, rotY = 0): THREE.Mesh {
    const m = this.place(PRISM, mat, w / PRISM_W, h / PRISM_H, d, x, y + h / 3, z)
    m.rotation.y = rotY
    return m
  }

  pyramid(w: number, h: number, x: number, y: number, z: number, mat: THREE.Material): THREE.Mesh {
    const m = this.place(PYRAMID, mat, w / Math.SQRT2, h, w / Math.SQRT2, x, y + h / 2, z)
    m.rotation.y = Math.PI / 4
    return m
  }

  /** y is the axle height. */
  wheel(r: number, w: number, x: number, y: number, z: number, axis: 'x' | 'z'): THREE.Mesh {
    const m = this.place(CYL, M.rubber, r, w, r, x, y, z)
    if (axis === 'x') m.rotation.z = Math.PI / 2
    else m.rotation.x = Math.PI / 2
    return m
  }

  sign(lines: readonly string[], w: number, h: number, x: number, y: number, z: number, rotY: number, opts: TextOpts, twoSided = true): THREE.Group {
    const mat = new THREE.MeshStandardMaterial({ map: makeTextTexture(lines, opts), roughness: 0.75, transparent: !opts.bg })
    const g = new THREE.Group()
    g.position.set(x, y, z)
    g.rotation.y = rotY
    const front = new THREE.Mesh(PLANE, mat)
    front.scale.set(w, h, 1)
    front.position.z = 0.012
    front.castShadow = true
    g.add(front)
    if (twoSided) {
      // Two single-sided planes rather than DoubleSide so the text isn't mirrored from behind.
      const back = front.clone()
      back.rotation.y = Math.PI
      back.position.z = -0.012
      g.add(back)
    }
    this.group.add(g)
    return g
  }

  sandbag(x: number, z: number, rotY: number, rows = 2): void {
    for (let r = 0; r < rows; r++) this.box(0.95, 0.36, 0.5, x, r * 0.36, z, M.sandbag).rotation.y = rotY
    this.collideBox(x, z, 0.45, 0.45, 0, rows * 0.36)
  }

  /** Axis-aligned post-and-rail fence between two local points. */
  fence(x0: number, z0: number, x1: number, z1: number, h = 1.1): void {
    const len = dist2d(x0, z0, x1, z1)
    const n = Math.max(1, Math.round(len / 2))
    for (let i = 0; i <= n; i++) {
      const t = i / n
      this.box(0.14, h, 0.14, x0 + (x1 - x0) * t, 0, z0 + (z1 - z0) * t, M.darkWood)
    }
    const alongX = Math.abs(x1 - x0) > Math.abs(z1 - z0)
    for (const ry of [h * 0.45, h * 0.85]) {
      this.box(alongX ? len : 0.08, 0.08, alongX ? 0.08 : len, (x0 + x1) / 2, ry, (z0 + z1) / 2, M.wood)
    }
    this.collideBox((x0 + x1) / 2, (z0 + z1) / 2, alongX ? len / 2 : 0.1, alongX ? 0.1 : len / 2, 0, h)
  }

  collideBox(x: number, z: number, hx: number, hz: number, y0: number, y1: number): void {
    this.world.addCollider({ kind: 'box', x: this.ox + x, z: this.oz + z, hx, hz, y0: this.oy + y0, y1: this.oy + y1 })
  }

  collideCircle(x: number, z: number, r: number, y0: number, y1: number): void {
    this.world.addCollider({ kind: 'circle', x: this.ox + x, z: this.oz + z, r, y0: this.oy + y0, y1: this.oy + y1 })
  }

  finish(): THREE.Group {
    this.world.scene.add(this.group)
    this.world.addSolid(this.group)
    return this.group
  }
}

/** Collects instance transforms then emits a single InstancedMesh. */
class Batch {
  private readonly mats: THREE.Matrix4[] = []
  private readonly cols: THREE.Color[] = []
  private readonly p = new THREE.Vector3()
  private readonly q = new THREE.Quaternion()
  private readonly s = new THREE.Vector3()
  private readonly e = new THREE.Euler()

  add(x: number, y: number, z: number, sx: number, sy: number, sz: number, rotY = 0, colour?: THREE.Color, rotX = 0, rotZ = 0): void {
    this.q.setFromEuler(this.e.set(rotX, rotY, rotZ))
    this.mats.push(new THREE.Matrix4().compose(this.p.set(x, y, z), this.q, this.s.set(sx, sy, sz)))
    if (colour) this.cols.push(colour.clone())
  }

  build(geo: THREE.BufferGeometry, mat: THREE.Material, world: World, solid = true, shadows = true): void {
    if (this.mats.length === 0) return
    const im = new THREE.InstancedMesh(geo, mat, this.mats.length)
    this.mats.forEach((m, i) => {
      im.setMatrixAt(i, m)
      const c = this.cols[i]
      if (c) im.setColorAt(i, c)
    })
    im.castShadow = shadows
    im.receiveShadow = shadows
    world.scene.add(im)
    if (solid) world.addSolid(im)
  }
}

function flagAt(i: number): FlagDef {
  const f = FLAGS[i]
  if (!f) throw new Error(`No flag at index ${i}`)
  return f
}

function kitAt(world: World, x: number, z: number): Kit {
  return new Kit(world, x, world.heightAt(x, z), z)
}

function buildPub(world: World, f: FlagDef): void {
  const k = kitAt(world, f.x, f.z)
  // Building sits back from the pole so the capture ring stays walkable.
  k.box(11, 6.4, 8, 0, 0, -10, M.wall, true)
  k.prism(9.4, 3, 12.2, 0, 6.4, -10, M.roof, Math.PI / 2)
  k.box(1, 2.4, 1, 4, 7.4, -10.4, M.dark)
  k.box(1.4, 2.4, 0.2, 0, 0, -5.95, M.darkWood)
  for (const x of [-3.8, 3.8]) k.box(1.6, 1.4, 0.2, x, 1.2, -5.95, M.glass)
  for (const x of [-3.8, 0, 3.8]) k.box(1.6, 1.4, 0.2, x, 4.2, -5.95, M.glass)
  k.box(0.15, 0.15, 2.4, 5.6, 5.2, -4.9, M.dark)
  for (const z of [-4.9, -3.9]) k.box(0.04, 0.5, 0.04, 5.6, 4.7, z, M.dark)
  k.sign(['THE PRATTLING', 'PARROT'], 2.6, 1.3, 5.6, 4.05, -4.4, Math.PI / 2, { bg: '#2f4a2b', fg: '#f2d98a', border: '#f2d98a' })
  k.box(2, 0.1, 0.5, -3, 0.5, -5.4, M.wood)
  for (const x of [-3.9, -2.1]) k.box(0.12, 0.5, 0.5, x, 0, -5.4, M.darkWood)
  for (const z of [-7, -8.3]) k.cyl(0.5, 0.9, 6.4, 0, z, M.darkWood, true)
  // Beer garden: fenced patch beside the pub with a gate gap on the pole side.
  k.fence(-13, -14, -13, -2)
  k.fence(-13, -2, -8, -2)
  k.fence(-13, -14, -5.5, -14)
  for (const z of [-11, -6]) {
    k.box(1.8, 0.1, 0.8, -9.5, 0.75, z, M.wood)
    k.box(0.3, 0.75, 0.6, -9.5, 0, z, M.wood)
    for (const dz of [-0.7, 0.7]) k.box(1.8, 0.08, 0.3, -9.5, 0.45, z + dz, M.wood)
    k.collideBox(-9.5, z, 0.9, 0.9, 0, 0.85)
  }
  k.finish()
}

function buildBusStop(world: World, f: FlagDef): void {
  const k = kitAt(world, f.x, f.z)
  k.box(4.2, 2.6, 0.15, -6, 0, -9.7, M.glass, true)
  for (const x of [-8.05, -3.95]) k.box(0.15, 2.6, 1.8, x, 0, -8.8, M.glass, true)
  k.box(4.6, 0.15, 2.2, -6, 2.6, -8.7, M.metal)
  k.box(3, 0.08, 0.45, -6, 0.5, -9.2, M.wood)
  for (const x of [-7.3, -4.7]) k.box(0.1, 0.5, 0.4, x, 0, -9.2, M.metal)
  k.cyl(0.07, 3.2, -3, 0, -6.5, M.metal)
  k.sign(['BUS 404', 'NOT FOUND'], 1.1, 0.7, -3, 2.7, -6.5, 0.3, { bg: '#1d3f8a', fg: '#ffffff', border: '#ffffff' })
  k.cyl(0.35, 0.9, -8.8, 0, -6.8, M.green)
  k.box(14, 0.25, 0.4, 1, 0, 5.2, M.concrete)
  // Bus parked at the kerb: a box on six wheels with the emotional state on the destination board.
  k.box(11, 2.6, 2.6, 1, 0.7, 7, M.bus)
  k.collideBox(1, 7, 5.6, 1.35, 0, 3.4)
  k.box(9.5, 0.9, 2.7, 0.5, 1.9, 7, M.glass)
  k.box(11.2, 0.2, 2.7, 1, 3.3, 7, M.white)
  k.box(0.3, 0.9, 2.2, 6.6, 0.7, 7, M.dark)
  for (const x of [-2.6, 3.2, 4.4]) for (const z of [5.75, 8.25]) k.wheel(0.55, 0.4, x, 0.55, z, 'z')
  k.sign(['NOT IN SERVICE', '(EMOTIONALLY)'], 2.2, 0.6, 6.56, 2.75, 7, Math.PI / 2, { bg: '#111111', fg: '#ffb347' }, false)
  k.finish()
}

function buildRoundabout(world: World, f: FlagDef): void {
  const k = kitAt(world, f.x, f.z)
  const kerb = new THREE.Mesh(new THREE.TorusGeometry(14, 0.35, 6, 48), M.concrete)
  kerb.rotation.x = Math.PI / 2
  kerb.position.y = 0.1
  k.add(kerb)
  // Low walkable mound; the pole sits on it and the plinth is pushed off-centre to keep the 3 m ring clear.
  k.cyl(7, 0.5, 0, 0, 0, M.mound)
  k.collideBox(0, 0, 5, 5, 0, 0.5)
  k.box(1.8, 1.8, 1.8, 0, 0.5, -4.2, M.concrete, true)
  const horn = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 0.45, 3.2, 12, 1, true), M.bronze)
  horn.rotation.x = Math.PI / 3
  horn.position.set(0, 3.6, -3.4)
  k.add(horn)
  const mouth = k.cyl(0.55, 0.7, 0, 0, 0, M.bronze)
  mouth.rotation.x = Math.PI / 3
  mouth.position.set(0, 2.55, -5.2)
  k.box(0.3, 0.9, 0.3, 0, 2.3, -4.6, M.bronze)
  k.sign(['TO THOSE WHO', 'NEVER STOPPED', 'TALKING'], 1.4, 0.8, 0, 1.4, -3.28, 0, { bg: '#6b5a3a', fg: '#f5e9c8', border: '#f5e9c8' }, false)
  for (let i = 0; i < 4; i++) {
    const stub = new THREE.Group()
    stub.rotation.y = (i * Math.PI) / 2
    const p = new THREE.Mesh(PLANE, M.road)
    p.rotation.x = -Math.PI / 2
    p.scale.set(6, 10, 1)
    p.position.set(0, 0.05, 19.5)
    p.receiveShadow = true
    stub.add(p)
    k.group.add(stub)
    // Sandbag arcs inside the kerb between the road stubs, open side facing the centre.
    const a = (i + 0.5) * (Math.PI / 2)
    const cx = Math.sin(a) * 10
    const cz = Math.cos(a) * 10
    for (let j = -3; j <= 3; j++) {
      const b = a + j * 0.42
      k.sandbag(cx + Math.sin(b) * 1.8, cz + Math.cos(b) * 1.8, b + Math.PI / 2)
    }
  }
  k.finish()
}

function buildBunnings(world: World, f: FlagDef): void {
  const k = kitAt(world, f.x, f.z)
  k.box(28, 9, 14, 0, 0, -13, M.green, true)
  k.box(28.4, 1.2, 14.4, 0, 8.2, -13, M.red)
  k.box(28.4, 0.4, 14.4, 0, 9, -13, M.dark)
  for (const x of [-9, 0, 9]) k.box(5, 5, 0.2, x, 0, -5.95, M.concrete)
  k.sign(
    ['WAREHOUSE', 'LOWEST PRICES ARE JUST THE', 'BEGINNING OF THE CONVERSATION'],
    16,
    2.6,
    0,
    6.6,
    -5.9,
    0,
    { bg: '#1f6b3a', fg: '#ffffff', border: '#c8202a', width: 1024, height: 192 },
    false,
  )
  // Sausage sizzle gazebo east of the pole.
  const gx = 9
  const gz = 4
  for (const dx of [-1.6, 1.6]) for (const dz of [-1.6, 1.6]) k.cyl(0.06, 2.4, gx + dx, 0, gz + dz, M.metal)
  k.pyramid(4.4, 1.2, gx, 2.4, gz, M.white)
  k.box(1.8, 0.05, 0.7, gx, 0.85, gz, M.white)
  k.box(1.6, 0.85, 0.5, gx, 0, gz, M.white)
  k.collideBox(gx, gz, 0.9, 0.35, 0, 0.9)
  k.box(1.2, 0.9, 0.6, gx, 0, gz + 1.3, M.dark, true)
  k.box(1, 0.1, 0.5, gx, 0.9, gz + 1.3, M.metal)
  // Pallet and timber stacks give the carpark some cover.
  const stacks: readonly (readonly [number, number, number])[] = [[-10, 3, 5], [-13, 8, 8], [-6, 10, 4], [12, -2, 6], [5, 12, 7], [14, 10, 5]]
  for (const [x, z, n] of stacks) {
    for (let i = 0; i < n; i++) k.box(1.2, 0.14, 1, x, i * 0.15, z, M.wood)
    k.box(1.1, 0.5, 0.9, x, n * 0.15, z, M.timber)
    k.collideBox(x, z, 0.6, 0.5, 0, n * 0.15 + 0.5)
  }
  for (const [x, z, r] of [[-4, 6, 0.4], [-2.5, 7.5, 2.1], [11, 6, 1.1]] as const) {
    const basket = k.box(0.9, 0.6, 0.55, x, 0.45, z, M.metal)
    basket.rotation.y = r
    k.box(0.9, 0.05, 0.55, x, 0.4, z, M.metal).rotation.y = r
    for (const dx of [-0.35, 0.35]) for (const dz of [-0.2, 0.2]) k.wheel(0.06, 0.05, x + dx, 0.06, z + dz, 'x')
    k.collideBox(x, z, 0.5, 0.5, 0, 1.05)
  }
  k.finish()
}

function buildServo(world: World, f: FlagDef): void {
  const k = kitAt(world, f.x, f.z)
  const cx = -1
  const cz = -7
  for (const dx of [-6, 6]) for (const dz of [-3.5, 3.5]) k.cyl(0.35, 5, cx + dx, 0, cz + dz, M.white, true)
  k.box(17, 0.7, 11, cx, 5, cz, M.white)
  k.box(17.2, 0.35, 11.2, cx, 5.35, cz, M.red)
  for (const ix of [cx - 3, cx + 3]) {
    k.box(1.4, 0.18, 6, ix, 0, cz, M.concrete)
    for (const dz of [-1.6, 1.6]) {
      k.box(0.7, 1.7, 0.9, ix, 0.18, cz + dz, M.white)
      k.box(0.5, 0.35, 0.05, ix, 1.25, cz + dz + 0.47, M.dark)
      k.box(0.12, 0.5, 0.12, ix + 0.3, 1.2, cz + dz - 0.47, M.dark)
      k.collideBox(ix, cz + dz, 0.35, 0.45, 0, 1.9)
    }
  }
  k.box(10, 3.6, 7, 8, 0, -11, M.wall, true)
  k.box(6, 1.6, 0.2, 7, 1, -7.45, M.glass)
  k.box(1.2, 2.4, 0.2, 11.5, 0, -7.45, M.dark)
  k.box(10.2, 1.3, 0.3, 8, 3.6, -7.45, M.red)
  k.sign(['SERVO', 'PIES . ICE . OPINIONS'], 8, 1.2, 8, 4.25, -7.28, 0, { bg: '#c8202a', fg: '#ffffff', width: 1024, height: 160 }, false)
  k.cyl(0.3, 9, -12, 0, 6, M.metal, true)
  k.sign(['UNLEADED 91', '$2.19', 'OPINIONS FREE'], 3.2, 4, -12, 7, 6, 0.6, { bg: '#1d3f8a', fg: '#ffffff', border: '#ffb347', width: 512, height: 640 })
  k.box(1.4, 1.6, 0.9, 3.2, 0, -6.9, M.white, true)
  k.box(1.45, 0.25, 0.95, 3.2, 1.6, -6.9, M.blue)
  // Tyre pile: four flat, two leaning against them.
  for (let i = 0; i < 4; i++) {
    const t = k.add(new THREE.Mesh(TYRE, M.rubber))
    t.rotation.x = Math.PI / 2
    t.position.set(14, 0.16 + i * 0.32, -3)
  }
  for (const [x, z, r] of [[14.9, -3.4, 0.25], [13.2, -2.5, -0.3]] as const) {
    const t = k.add(new THREE.Mesh(TYRE, M.rubber))
    t.rotation.set(r, 0.8, 0)
    t.position.set(x, 0.45, z)
  }
  k.collideCircle(14, -3, 0.7, 0, 1.3)
  k.finish()
}

function buildHQ(world: World, t: TeamDef): void {
  const k = kitAt(world, t.hq.x, t.hq.z)
  // Layout mirrors across the map so both camps face the centre.
  const s = t.hq.x < 0 ? 1 : -1
  for (const [x, z] of [[-8, -4], [-8, 6], [2, -10]] as const) {
    k.box(4, 1.5, 5, x * s, 0, z * s, M.canvas, true)
    k.prism(4.6, 1.8, 5.4, x * s, 1.5, z * s, M.canvas)
    k.box(1.2, 1.4, 0.2, x * s, 0, (z + 2.5) * s, M.dark)
  }
  for (let i = 0; i <= 12; i++) {
    k.sandbag(9 * s, (-6 + i) * s, Math.PI / 2)
    k.sandbag((-6 + i) * s, 9 * s, 0)
  }
  for (const [x, z] of [[4, -3], [5.2, -3], [4.6, -3], [-2, 8]] as const) k.box(1.1, 1.1, 1.1, x * s, 0, z * s, M.wood, true)
  k.box(1.1, 1.1, 1.1, 4.6 * s, 1.1, -3 * s, M.wood)
  k.cyl(0.12, 14, -3 * s, 0, 2 * s, M.metal)
  for (const y of [10, 12]) k.box(1.6, 0.06, 0.06, -3 * s, y, 2 * s, M.metal)
  k.box(0.6, 0.6, 0.6, -3 * s, 13.4, 2 * s, M.dark)
  k.cyl(0.08, 9, 0, 0, 0, M.white)
  const flag = new THREE.Mesh(PLANE, new THREE.MeshStandardMaterial({ color: t.colour, side: THREE.DoubleSide, flatShading: true }))
  flag.scale.set(2.4, 1.4, 1)
  flag.position.set(1.2 * s, 8.1, 0)
  k.add(flag)
  k.finish()
}

function buildRoadRibbon(world: World, pts: THREE.Vector3[]): THREE.Vector3[] {
  const curve = new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.5)
  const n = Math.ceil(curve.getLength() / 3)
  const samples = curve.getSpacedPoints(n)
  const pos = new Float32Array(samples.length * 6)
  const idx: number[] = []
  const tangent = new THREE.Vector3()
  samples.forEach((p, i) => {
    const prev = samples[Math.max(0, i - 1)] ?? p
    const next = samples[Math.min(samples.length - 1, i + 1)] ?? p
    tangent.subVectors(next, prev).setY(0).normalize()
    for (const side of [-1, 1]) {
      const x = p.x - tangent.z * side * 2.6
      const z = p.z + tangent.x * side * 2.6
      const o = i * 6 + (side + 1) * 1.5
      pos[o] = x
      pos[o + 1] = world.heightAt(x, z) + 0.1
      pos[o + 2] = z
    }
    if (i < samples.length - 1) idx.push(i * 2, i * 2 + 2, i * 2 + 1, i * 2 + 1, i * 2 + 2, i * 2 + 3)
    p.y = world.heightAt(p.x, p.z)
  })
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setIndex(idx)
  geo.computeVertexNormals()
  const mesh = new THREE.Mesh(geo, M.road)
  mesh.receiveShadow = true
  world.scene.add(mesh)
  return samples
}

/** Dirt tracks A-C-E and B-C-D. Returns the sampled centreline so scatter can keep off the road. */
function buildRoads(world: World): THREE.Vector3[] {
  const all: THREE.Vector3[] = []
  for (const chain of [[0, 2, 4], [1, 2, 3]]) {
    const pts: THREE.Vector3[] = []
    for (const fi of chain) {
      const f = flagAt(fi)
      const prev = pts[pts.length - 1]
      if (prev) {
        // A sideways bend between flags keeps the track from reading as a ruler line.
        const dx = f.x - prev.x
        const dz = f.z - prev.z
        const len = Math.hypot(dx, dz)
        pts.push(new THREE.Vector3((prev.x + f.x) / 2 - (dz / len) * 14, 0, (prev.z + f.z) / 2 + (dx / len) * 14))
      }
      pts.push(new THREE.Vector3(f.x, 0, f.z))
    }
    all.push(...buildRoadRibbon(world, pts))
  }
  return all
}

function makeOpenTest(world: World): OpenTest {
  const zones = [
    ...FLAGS.map((f) => ({ x: f.x, z: f.z, r: f.radius + 8 })),
    ...TEAMS.map((t) => ({ x: t.hq.x, z: t.hq.z, r: 26 })),
    { x: LEVOLUTION.towerX, z: LEVOLUTION.towerZ, r: 14 },
  ]
  return (x, z, margin = 0) => {
    if (Math.abs(x) > MAP.half - 6 || Math.abs(z) > MAP.half - 6) return false
    if (world.heightAt(x, z) < MAP.waterLevel + 0.8) return false
    return zones.every((zn) => dist2d(x, z, zn.x, zn.z) > zn.r + margin)
  }
}

function nearRoad(x: number, z: number, road: readonly THREE.Vector3[], d: number): boolean {
  return road.some((p) => (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z) < d * d)
}

function randomPoint(rng: Rng): [number, number] {
  return [(rng() * 2 - 1) * (MAP.half - 8), (rng() * 2 - 1) * (MAP.half - 8)]
}

function scatterTrees(world: World, rng: Rng, open: OpenTest, road: readonly THREE.Vector3[]): void {
  const trunk = new Batch()
  const low = new Batch()
  const high = new Batch()
  const c = new THREE.Color()
  for (let placed = 0, tries = 0; placed < 350 && tries < 8000; tries++) {
    const [x, z] = randomPoint(rng)
    if (!open(x, z) || nearRoad(x, z, road, 4)) continue
    // Noise-gated density so trees gather into woods instead of an even sprinkle.
    if (fbm(x / 55 + 11, z / 55 + 7, 2) < -0.25 + rng() * 0.45) continue
    const y = world.heightAt(x, z)
    const s = 0.75 + rng() * 0.7
    const rot = rng() * Math.PI * 2
    c.setHSL(0.26 + rng() * 0.07, 0.45 + rng() * 0.2, 0.26 + rng() * 0.12)
    trunk.add(x, y + 1.5 * s, z, 0.3 * s, 3 * s, 0.3 * s, rot)
    low.add(x, y + 3.2 * s, z, 2.1 * s, 3.2 * s, 2.1 * s, rot, c)
    high.add(x, y + 4.9 * s, z, 1.5 * s, 2.6 * s, 1.5 * s, rot + 0.4, c)
    world.addCollider({ kind: 'circle', x, z, r: 0.35 * s, y0: y, y1: y + 3 * s })
    placed++
  }
  trunk.build(CYL, M.trunk, world)
  low.build(CONE, M.leaf, world)
  high.build(CONE, M.leaf, world)
}

function scatterRocks(world: World, rng: Rng, open: OpenTest): void {
  const rocks = new Batch()
  const c = new THREE.Color()
  for (let placed = 0, tries = 0; placed < 120 && tries < 3000; tries++) {
    const [x, z] = randomPoint(rng)
    if (!open(x, z)) continue
    const y = world.heightAt(x, z)
    const s = 0.5 + rng() * 1.8
    c.setHSL(0.08 + rng() * 0.05, 0.05 + rng() * 0.08, 0.4 + rng() * 0.2)
    rocks.add(x, y + s * 0.2, z, s, s * 0.7, s * 1.2, rng() * Math.PI * 2, c, (rng() - 0.5) * 0.4)
    if (s > 0.6) world.addCollider({ kind: 'circle', x, z, r: s * 0.8, y0: y, y1: y + s * 0.9 })
    placed++
  }
  rocks.build(ICO, M.rock, world)
}

function scatterHay(world: World, rng: Rng, open: OpenTest): void {
  const bales = new Batch()
  for (let clusters = 0, tries = 0; clusters < 6 && tries < 600; tries++) {
    const [cx, cz] = randomPoint(rng)
    if (!open(cx, cz, 6) || slopeAt(cx, cz) > 0.45) continue
    const n = 4 + Math.floor(rng() * 4)
    for (let i = 0; i < n; i++) {
      const x = cx + (rng() - 0.5) * 9
      const z = cz + (rng() - 0.5) * 9
      const y = world.heightAt(x, z)
      bales.add(x, y + 0.75, z, 0.8, 1.5, 0.8, rng() * Math.PI * 2, undefined, 0, Math.PI / 2)
      world.addCollider({ kind: 'box', x, z, hx: 0.8, hz: 0.8, y0: y, y1: y + 1.6 })
    }
    clusters++
  }
  bales.build(CYL, M.hay, world)
}

function scatterFences(world: World, rng: Rng, open: OpenTest, road: readonly THREE.Vector3[]): void {
  const posts = new Batch()
  const rails = new Batch()
  for (let runs = 0, tries = 0; runs < 9 && tries < 400; tries++) {
    const [x0, z0] = randomPoint(rng)
    const alongX = rng() < 0.5
    const len = 16 + rng() * 26
    const n = Math.round(len / 2.5)
    const pts: [number, number, number][] = []
    for (let i = 0; i <= n; i++) {
      const x = alongX ? x0 + i * 2.5 : x0
      const z = alongX ? z0 : z0 + i * 2.5
      if (!open(x, z, 2) || nearRoad(x, z, road, 4) || slopeAt(x, z) > 0.6) break
      pts.push([x, world.heightAt(x, z), z])
    }
    if (pts.length < 4) continue
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]
      const b = pts[i + 1]
      if (!a) continue
      posts.add(a[0], a[1] + 0.6, a[2], 0.14, 1.3, 0.14)
      if (!b) continue
      const dy = b[1] - a[1]
      const pitch = Math.atan2(dy, 2.5)
      const mx = (a[0] + b[0]) / 2
      const mz = (a[2] + b[2]) / 2
      const my = (a[1] + b[1]) / 2
      for (const h of [0.5, 1]) rails.add(mx, my + h, mz, 2.55, 0.08, 0.06, alongX ? 0 : -Math.PI / 2, undefined, 0, pitch)
      world.addCollider({
        kind: 'box',
        x: mx,
        z: mz,
        hx: alongX ? 1.3 : 0.1,
        hz: alongX ? 0.1 : 1.3,
        y0: Math.min(a[1], b[1]),
        y1: Math.max(a[1], b[1]) + 1.1,
      })
    }
    runs++
  }
  posts.build(BOX, M.darkWood, world)
  rails.build(BOX, M.wood, world)
}

/** Windmill on the highest open, gentle spot; the farm shed goes on the nearest flat ground beside it. */
function buildFarm(world: World, rng: Rng, open: OpenTest): void {
  let best: [number, number, number] | null = null
  for (let i = 0; i < 400; i++) {
    const [x, z] = randomPoint(rng)
    if (!open(x, z, 12) || slopeAt(x, z) > 0.4) continue
    const y = world.heightAt(x, z)
    if (!best || y > best[1]) best = [x, y, z]
  }
  if (!best) return
  const [wx, , wz] = best
  const k = kitAt(world, wx, wz)
  const tower = k.add(new THREE.Mesh(new THREE.CylinderGeometry(0.5, 1.8, 14, 4), M.metal))
  tower.position.y = 7
  k.collideCircle(0, 0, 1.6, 0, 14)
  const rotor = new THREE.Group()
  rotor.position.set(1.1, 14.3, 0)
  rotor.rotation.y = Math.PI / 2
  for (let i = 0; i < 8; i++) {
    const pivot = new THREE.Group()
    pivot.rotation.z = (i * Math.PI) / 4
    const blade = new THREE.Mesh(BOX, M.tin)
    blade.scale.set(0.45, 3.4, 0.06)
    blade.position.y = 1.9
    blade.castShadow = true
    pivot.add(blade)
    rotor.add(pivot)
  }
  const hub = new THREE.Mesh(CYL, M.dark)
  hub.scale.set(0.4, 0.5, 0.4)
  hub.rotation.x = Math.PI / 2
  rotor.add(hub)
  k.group.add(rotor)
  k.box(2.6, 0.06, 1, -1.8, 14.2, 0, M.tin)
  k.box(2.4, 0.6, 0.9, 3.2, 0, 1, M.metal, true)
  k.finish()
  for (let i = 0; i < 60; i++) {
    const a = rng() * Math.PI * 2
    const d = 14 + rng() * 10
    const sx = wx + Math.sin(a) * d
    const sz = wz + Math.cos(a) * d
    if (!open(sx, sz, 6) || slopeAt(sx, sz) > 0.3) continue
    const s = kitAt(world, sx, sz)
    s.box(9, 3.5, 6, 0, 0, 0, M.tin, true)
    s.prism(6.6, 1.6, 9.6, 0, 3.5, 0, solidMaterial(0x8a4a30, 0.7, 0.3), Math.PI / 2)
    s.box(2.6, 2.8, 0.2, 0, 0, 3.05, M.dark)
    s.box(1.1, 1.1, 1.1, 5.6, 0, 1, M.wood, true)
    s.finish()
    return
  }
}

function buildClouds(world: World, rng: Rng): void {
  const puffs = new Batch()
  for (let i = 0; i < 30; i++) {
    const cx = (rng() * 2 - 1) * MAP.half * 1.4
    const cz = (rng() * 2 - 1) * MAP.half * 1.4
    const cy = 90 + rng() * 40
    const n = 3 + Math.floor(rng() * 3)
    for (let j = 0; j < n; j++) {
      const s = 7 + rng() * 8
      puffs.add(cx + (rng() - 0.5) * 22, cy + (rng() - 0.5) * 3, cz + (rng() - 0.5) * 12, s, s * 0.38, s * 0.8, rng() * Math.PI)
    }
  }
  puffs.build(PUFF, M.cloud, world, false, false)
}

export function buildProps(world: World): PropsResult {
  const rng = mulberry32(20260903)
  buildPub(world, flagAt(0))
  buildBusStop(world, flagAt(1))
  buildRoundabout(world, flagAt(2))
  buildBunnings(world, flagAt(3))
  buildServo(world, flagAt(4))
  for (const t of TEAMS) buildHQ(world, t)
  const road = buildRoads(world)
  const open = makeOpenTest(world)
  scatterTrees(world, rng, open, road)
  scatterRocks(world, rng, open)
  scatterHay(world, rng, open)
  scatterFences(world, rng, open, road)
  buildFarm(world, rng, open)
  buildClouds(world, rng)
  return { levolution: new WaterTower(world) }
}
