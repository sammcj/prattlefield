import * as THREE from 'three'
import { FLAGS, MAP, TEAMS, THEME } from '../config'
import { fbm } from '../util/noise'
import { clamp, smoothstep } from '../util/math'

interface FlatSpot {
  readonly x: number
  readonly z: number
  readonly radius: number
  readonly y: number
}

function rawHeight(x: number, z: number): number {
  const nx = x / 160
  const nz = z / 160
  const base = fbm(nx + 3.1, nz - 2.7, 5) * MAP.heightScale
  const ridge = Math.abs(fbm(nx * 0.6 + 9.2, nz * 0.6 + 4.4, 3)) * MAP.heightScale * 1.4
  // A shallow creek winds diagonally across the map.
  // Runs perpendicular to the HQ axis through the middle so both teams ford it once.
  const creek = Math.exp(-Math.pow((x + z * 0.865 + fbm(nz * 2, nx * 2) * 30) / 22, 2)) * 7
  // Edges rise into hills so the world feels enclosed.
  const edge = smoothstep(MAP.half - 70, MAP.half, Math.max(Math.abs(x), Math.abs(z))) * 16
  return base + ridge * 0.6 - creek + edge + 2.2
}

const flatSpots: FlatSpot[] = [
  ...FLAGS.map((f) => ({ x: f.x, z: f.z, radius: f.radius + 8, y: rawHeight(f.x, f.z) })),
  ...TEAMS.map((t) => ({ x: t.hq.x, z: t.hq.z, radius: 24, y: rawHeight(t.hq.x, t.hq.z) })),
]

export function heightAt(x: number, z: number): number {
  let h = rawHeight(x, z)
  for (const s of flatSpots) {
    const dx = x - s.x
    const dz = z - s.z
    const d = Math.sqrt(dx * dx + dz * dz)
    if (d < s.radius * 1.8) {
      const t = 1 - smoothstep(s.radius, s.radius * 1.8, d)
      h = h + (s.y - h) * t
    }
  }
  return h
}

export function slopeAt(x: number, z: number): number {
  const e = 0.6
  const dx = heightAt(x + e, z) - heightAt(x - e, z)
  const dz = heightAt(x, z + e) - heightAt(x, z - e)
  return Math.sqrt(dx * dx + dz * dz) / (2 * e)
}

export function normalAt(x: number, z: number, out: THREE.Vector3): THREE.Vector3 {
  const e = 0.6
  const dx = heightAt(x + e, z) - heightAt(x - e, z)
  const dz = heightAt(x, z + e) - heightAt(x, z - e)
  return out.set(-dx, 2 * e, -dz).normalize()
}

const cGrass = new THREE.Color(THEME.grass)
const cGrassDark = new THREE.Color(THEME.grassDark)
const cDirt = new THREE.Color(THEME.dirt)
const cRock = new THREE.Color(THEME.rock)
const cSand = new THREE.Color(THEME.sand)

function vertexColour(x: number, z: number, y: number, out: THREE.Color): void {
  const slope = slopeAt(x, z)
  const tint = fbm(x / 23 + 50, z / 23 + 50, 2) * 0.5 + 0.5
  out.copy(cGrass).lerp(cGrassDark, tint)
  if (y < MAP.waterLevel + 1.6) out.lerp(cSand, clamp((MAP.waterLevel + 1.6 - y) / 1.6, 0, 1))
  out.lerp(cDirt, smoothstep(0.35, 0.7, slope))
  out.lerp(cRock, smoothstep(0.75, 1.3, slope))
  if (y > 14) out.lerp(cRock, smoothstep(14, 22, y) * 0.7)
}

export function buildTerrain(): THREE.Mesh {
  const seg = MAP.terrainSegments
  const geo = new THREE.PlaneGeometry(MAP.size, MAP.size, seg, seg)
  geo.rotateX(-Math.PI / 2)
  const pos = geo.attributes['position'] as THREE.BufferAttribute
  const colours = new Float32Array(pos.count * 3)
  const c = new THREE.Color()
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i)
    const z = pos.getZ(i)
    const y = heightAt(x, z)
    pos.setY(i, y)
    vertexColour(x, z, y, c)
    colours[i * 3] = c.r
    colours[i * 3 + 1] = c.g
    colours[i * 3 + 2] = c.b
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colours, 3))
  geo.computeVertexNormals()
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.receiveShadow = true
  mesh.name = 'terrain'
  return mesh
}

export function buildWater(): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(MAP.size * 1.5, MAP.size * 1.5)
  geo.rotateX(-Math.PI / 2)
  const mat = new THREE.MeshStandardMaterial({
    color: THEME.water,
    transparent: true,
    opacity: 0.78,
    roughness: 0.25,
    metalness: 0.1,
  })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.position.y = MAP.waterLevel
  mesh.name = 'water'
  return mesh
}

// Marches a ray against the analytic heightfield. Returns distance or null.
export function raymarchTerrain(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): number | null {
  let t = 0
  let step = 0.6
  let px = origin.x
  let py = origin.y
  let pz = origin.z
  let prevAbove = py > heightAt(px, pz)
  if (!prevAbove) return 0
  while (t < maxDist) {
    t += step
    px = origin.x + dir.x * t
    py = origin.y + dir.y * t
    pz = origin.z + dir.z * t
    const h = heightAt(px, pz)
    if (py <= h) {
      // Refine with a few bisection steps for a tidy impact point.
      let lo = t - step
      let hi = t
      for (let i = 0; i < 5; i++) {
        const mid = (lo + hi) / 2
        const my = origin.y + dir.y * mid
        const mh = heightAt(origin.x + dir.x * mid, origin.z + dir.z * mid)
        if (my <= mh) hi = mid
        else lo = mid
      }
      return hi
    }
    // Widen steps when high above ground, tighten when close.
    step = clamp((py - h) * 0.5, 0.4, 4)
  }
  return null
}
