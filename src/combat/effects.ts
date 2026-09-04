import * as THREE from 'three'
import { THEME } from '../config'

const MAX_PARTICLES = 3000
const MAX_TRACERS = 240
const MAX_EXPLOSIONS = 10
const MAX_FLASHES = 12

export type ImpactKind = 'dirt' | 'flesh' | 'metal'

interface Particle {
  life: number
  maxLife: number
  vx: number
  vy: number
  vz: number
  gravity: number
  drag: number
  size: number
  r: number
  g: number
  b: number
}

interface Tracer {
  life: number
}

interface Explosion {
  readonly mesh: THREE.Mesh
  readonly light: THREE.PointLight
  readonly mat: THREE.MeshBasicMaterial
  life: number
  radius: number
}

interface Flash {
  readonly sprite: THREE.Sprite
  readonly light: THREE.PointLight
  life: number
}

/**
 * Pooled visual effects: GPU point particles, additive tracer segments,
 * expanding explosion shells and muzzle flashes. Everything is pre-allocated
 * so combat never allocates geometry mid-match.
 */
export class Effects {
  readonly group = new THREE.Group()
  /** Read by the camera each frame; decays automatically. */
  shake = 0
  private readonly particles: Particle[] = []
  private readonly pPos: Float32Array
  private readonly pCol: Float32Array
  private readonly pSize: Float32Array
  private readonly pGeo: THREE.BufferGeometry
  private readonly points: THREE.Points
  private pHead = 0

  private readonly tracers: Tracer[] = []
  private readonly tPos: Float32Array
  private readonly tCol: Float32Array
  private readonly tBase: Float32Array
  private readonly tGeo: THREE.BufferGeometry
  private tHead = 0

  private readonly explosions: Explosion[] = []
  private readonly flashes: Flash[] = []
  private flashHead = 0
  private readonly tmpV = new THREE.Vector3()

  constructor() {
    this.pPos = new Float32Array(MAX_PARTICLES * 3)
    this.pCol = new Float32Array(MAX_PARTICLES * 3)
    this.pSize = new Float32Array(MAX_PARTICLES)
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.particles.push({ life: 0, maxLife: 1, vx: 0, vy: 0, vz: 0, gravity: 0, drag: 0, size: 0, r: 0, g: 0, b: 0 })
      this.pPos[i * 3 + 1] = -1000
    }
    this.pGeo = new THREE.BufferGeometry()
    this.pGeo.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3).setUsage(THREE.DynamicDrawUsage))
    this.pGeo.setAttribute('color', new THREE.BufferAttribute(this.pCol, 3).setUsage(THREE.DynamicDrawUsage))
    this.pGeo.setAttribute('psize', new THREE.BufferAttribute(this.pSize, 1).setUsage(THREE.DynamicDrawUsage))
    const pMat = new THREE.PointsMaterial({
      size: 0.14,
      map: makeParticleTexture(),
      alphaTest: 0.02,
      vertexColors: true,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      sizeAttenuation: true,
    })
    // Per-particle size via a tiny shader patch keeps one draw call for all particles.
    pMat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('uniform float size;', 'uniform float size; attribute float psize;')
        .replace('gl_PointSize = size;', 'gl_PointSize = size * psize;')
    }
    this.points = new THREE.Points(this.pGeo, pMat)
    this.points.frustumCulled = false
    this.group.add(this.points)

    this.tPos = new Float32Array(MAX_TRACERS * 6)
    this.tCol = new Float32Array(MAX_TRACERS * 6)
    this.tBase = new Float32Array(MAX_TRACERS * 3)
    for (let i = 0; i < MAX_TRACERS; i++) {
      this.tracers.push({ life: 0 })
      this.tPos[i * 6 + 1] = -1000
      this.tPos[i * 6 + 4] = -1000
    }
    this.tGeo = new THREE.BufferGeometry()
    this.tGeo.setAttribute('position', new THREE.BufferAttribute(this.tPos, 3).setUsage(THREE.DynamicDrawUsage))
    this.tGeo.setAttribute('color', new THREE.BufferAttribute(this.tCol, 3).setUsage(THREE.DynamicDrawUsage))
    const tMat = new THREE.LineBasicMaterial({
      vertexColors: true,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
    })
    const lines = new THREE.LineSegments(this.tGeo, tMat)
    lines.frustumCulled = false
    this.group.add(lines)

    const shellGeo = new THREE.IcosahedronGeometry(1, 1)
    for (let i = 0; i < MAX_EXPLOSIONS; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffa040,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
      const mesh = new THREE.Mesh(shellGeo, mat)
      mesh.visible = false
      const light = new THREE.PointLight(0xffa040, 0, 30, 1.5)
      this.group.add(mesh, light)
      this.explosions.push({ mesh, light, mat, life: 0, radius: 1 })
    }

    const flashTex = makeFlashTexture()
    for (let i = 0; i < MAX_FLASHES; i++) {
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: flashTex, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }),
      )
      sprite.visible = false
      const light = new THREE.PointLight(0xffc070, 0, 10, 2)
      this.group.add(sprite, light)
      this.flashes.push({ sprite, light, life: 0 })
    }
  }

  private emit(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    life: number,
    size: number,
    colour: number,
    gravity: number,
    drag: number,
  ): void {
    const i = this.pHead
    this.pHead = (this.pHead + 1) % MAX_PARTICLES
    const p = this.particles[i]
    if (!p) return
    p.life = life
    p.maxLife = life
    p.vx = vx
    p.vy = vy
    p.vz = vz
    p.gravity = gravity
    p.drag = drag
    p.size = size
    p.r = ((colour >> 16) & 255) / 255
    p.g = ((colour >> 8) & 255) / 255
    p.b = (colour & 255) / 255
    this.pPos[i * 3] = x
    this.pPos[i * 3 + 1] = y
    this.pPos[i * 3 + 2] = z
  }

  tracer(from: THREE.Vector3, to: THREE.Vector3, colour: number): void {
    const i = this.tHead
    this.tHead = (this.tHead + 1) % MAX_TRACERS
    const t = this.tracers[i]
    if (!t) return
    t.life = 0.09
    this.tPos[i * 6] = from.x
    this.tPos[i * 6 + 1] = from.y
    this.tPos[i * 6 + 2] = from.z
    this.tPos[i * 6 + 3] = to.x
    this.tPos[i * 6 + 4] = to.y
    this.tPos[i * 6 + 5] = to.z
    const r = ((colour >> 16) & 255) / 255
    const g = ((colour >> 8) & 255) / 255
    const b = (colour & 255) / 255
    this.tBase[i * 3] = r
    this.tBase[i * 3 + 1] = g
    this.tBase[i * 3 + 2] = b
    this.tCol[i * 6] = r * 0.4
    this.tCol[i * 6 + 1] = g * 0.4
    this.tCol[i * 6 + 2] = b * 0.4
    this.tCol[i * 6 + 3] = r
    this.tCol[i * 6 + 4] = g
    this.tCol[i * 6 + 5] = b
  }

  impact(point: THREE.Vector3, normal: THREE.Vector3, kind: ImpactKind): void {
    const count = kind === 'flesh' ? 7 : 8
    const colour = kind === 'flesh' ? THEME.blood : kind === 'metal' ? 0xffd080 : 0xa88a5a
    for (let i = 0; i < count; i++) {
      const s = kind === 'flesh' ? 3 : 4.5
      this.emit(
        point.x,
        point.y,
        point.z,
        normal.x * s + (Math.random() - 0.5) * s,
        normal.y * s + Math.random() * s,
        normal.z * s + (Math.random() - 0.5) * s,
        0.3 + Math.random() * 0.25,
        kind === 'flesh' ? 0.2 : 0.35,
        colour,
        kind === 'flesh' ? 12 : 9,
        1.5,
      )
    }
    if (kind === 'dirt') {
      for (let i = 0; i < 4; i++) {
        this.emit(
          point.x,
          point.y + 0.1,
          point.z,
          (Math.random() - 0.5) * 1.2,
          0.8 + Math.random(),
          (Math.random() - 0.5) * 1.2,
          0.7 + Math.random() * 0.5,
          1.4,
          0xc9b48c,
          -0.3,
          2,
        )
      }
    }
  }

  muzzleFlash(position: THREE.Vector3, dir: THREE.Vector3, scale: number): void {
    const f = this.flashes[this.flashHead]
    this.flashHead = (this.flashHead + 1) % MAX_FLASHES
    if (!f) return
    f.life = 0.05
    f.sprite.visible = true
    f.sprite.position.copy(position).addScaledVector(dir, 0.15)
    const s = (0.5 + Math.random() * 0.4) * scale
    f.sprite.scale.set(s, s, s)
    f.sprite.material.rotation = Math.random() * Math.PI * 2
    f.light.position.copy(f.sprite.position)
    f.light.intensity = 25 * scale
    for (let i = 0; i < 3; i++) {
      this.emit(
        position.x,
        position.y,
        position.z,
        dir.x * 6 + (Math.random() - 0.5) * 3,
        dir.y * 6 + Math.random(),
        dir.z * 6 + (Math.random() - 0.5) * 3,
        0.2,
        0.3,
        0xffd27a,
        0,
        4,
      )
    }
    // Lingering smoke puff.
    this.emit(position.x, position.y, position.z, (Math.random() - 0.5) * 0.5, 0.6, (Math.random() - 0.5) * 0.5, 0.9, 1.1, 0x9a9a9a, -0.4, 2)
  }

  explosion(position: THREE.Vector3, radius: number): void {
    const slot = this.explosions.find((e) => e.life <= 0) ?? this.explosions[0]
    if (!slot) return
    slot.life = 0.6
    slot.radius = radius
    slot.mesh.visible = true
    slot.mesh.position.copy(position)
    slot.mesh.scale.setScalar(0.3)
    slot.mat.opacity = 0.95
    slot.light.position.copy(position).y += 1
    slot.light.intensity = 400
    slot.light.distance = radius * 5
    for (let i = 0; i < 70; i++) {
      const dir = this.tmpV.set(Math.random() - 0.5, Math.random() * 0.8, Math.random() - 0.5).normalize()
      const sp = radius * (0.8 + Math.random() * 1.8)
      const hot = Math.random() < 0.55
      this.emit(
        position.x,
        position.y + 0.3,
        position.z,
        dir.x * sp,
        dir.y * sp + 2,
        dir.z * sp,
        hot ? 0.4 + Math.random() * 0.4 : 1.2 + Math.random() * 1.4,
        hot ? 0.9 : 2.4,
        hot ? (Math.random() < 0.5 ? 0xffb040 : 0xff6020) : Math.random() < 0.5 ? 0x55504a : 0x2e2b28,
        hot ? 4 : -1.2,
        hot ? 2.5 : 1.6,
      )
    }
    for (let i = 0; i < 30; i++) {
      this.emit(
        position.x,
        position.y,
        position.z,
        (Math.random() - 0.5) * radius * 3,
        Math.random() * radius * 2 + 4,
        (Math.random() - 0.5) * radius * 3,
        1 + Math.random(),
        0.6,
        0x8a6a44,
        18,
        0.8,
      )
    }
  }

  /** Soft dust kicked up by tyres or sprinting boots. */
  dust(position: THREE.Vector3, amount: number): void {
    for (let i = 0; i < amount; i++) {
      this.emit(
        position.x + (Math.random() - 0.5) * 0.8,
        position.y + 0.1,
        position.z + (Math.random() - 0.5) * 0.8,
        (Math.random() - 0.5) * 1.5,
        0.6 + Math.random() * 0.8,
        (Math.random() - 0.5) * 1.5,
        0.8 + Math.random() * 0.6,
        1.6,
        0xbfa77e,
        -0.2,
        2,
      )
    }
  }

  blood(position: THREE.Vector3): void {
    for (let i = 0; i < 18; i++) {
      this.emit(
        position.x,
        position.y + 1,
        position.z,
        (Math.random() - 0.5) * 4,
        Math.random() * 3,
        (Math.random() - 0.5) * 4,
        0.5 + Math.random() * 0.4,
        0.6,
        THEME.blood,
        14,
        1,
      )
    }
  }

  update(dt: number): void {
    this.shake = Math.max(0, this.shake - dt * 2.2)
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const p = this.particles[i]
      if (!p || p.life <= 0) continue
      p.life -= dt
      if (p.life <= 0) {
        this.pPos[i * 3 + 1] = -1000
        this.pSize[i] = 0
        continue
      }
      const k = 1 - Math.min(1, p.drag * dt)
      p.vx *= k
      p.vz *= k
      p.vy = p.vy * k - p.gravity * dt
      this.pPos[i * 3] = (this.pPos[i * 3] ?? 0) + p.vx * dt
      this.pPos[i * 3 + 1] = (this.pPos[i * 3 + 1] ?? 0) + p.vy * dt
      this.pPos[i * 3 + 2] = (this.pPos[i * 3 + 2] ?? 0) + p.vz * dt
      const t = p.life / p.maxLife
      const fade = t < 0.4 ? t / 0.4 : 1
      this.pCol[i * 3] = p.r * fade
      this.pCol[i * 3 + 1] = p.g * fade
      this.pCol[i * 3 + 2] = p.b * fade
      this.pSize[i] = p.size * (p.gravity < 0 ? 1 + (1 - t) * 1.5 : 1)
    }
    ;(this.pGeo.attributes['position'] as THREE.BufferAttribute).needsUpdate = true
    ;(this.pGeo.attributes['color'] as THREE.BufferAttribute).needsUpdate = true
    ;(this.pGeo.attributes['psize'] as THREE.BufferAttribute).needsUpdate = true

    for (let i = 0; i < MAX_TRACERS; i++) {
      const t = this.tracers[i]
      if (!t || t.life <= 0) continue
      t.life -= dt
      if (t.life <= 0) {
        this.tPos[i * 6 + 1] = -1000
        this.tPos[i * 6 + 4] = -1000
        continue
      }
      const f = t.life / 0.09
      this.tCol[i * 6 + 3] = (this.tBase[i * 3] ?? 1) * f
      this.tCol[i * 6 + 4] = (this.tBase[i * 3 + 1] ?? 1) * f
      this.tCol[i * 6 + 5] = (this.tBase[i * 3 + 2] ?? 1) * f
    }
    ;(this.tGeo.attributes['position'] as THREE.BufferAttribute).needsUpdate = true
    ;(this.tGeo.attributes['color'] as THREE.BufferAttribute).needsUpdate = true

    for (const e of this.explosions) {
      if (e.life <= 0) continue
      e.life -= dt
      if (e.life <= 0) {
        e.mesh.visible = false
        e.light.intensity = 0
        continue
      }
      const t = 1 - e.life / 0.6
      e.mesh.scale.setScalar(0.3 + t * e.radius * 0.9)
      e.mat.opacity = (1 - t) * 0.9
      e.light.intensity = 400 * (1 - t)
    }
    for (const f of this.flashes) {
      if (f.life <= 0) continue
      f.life -= dt
      if (f.life <= 0) {
        f.sprite.visible = false
        f.light.intensity = 0
      }
    }
  }
}

function makeParticleTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 32
  c.height = 32
  const ctx = c.getContext('2d')
  if (ctx) {
    const g = ctx.createRadialGradient(16, 16, 2, 16, 16, 16)
    // Firm core with a short falloff so close particles read as specks rather than blurry blobs.
    g.addColorStop(0, 'rgba(255,255,255,1)')
    g.addColorStop(0.55, 'rgba(255,255,255,0.9)')
    g.addColorStop(0.8, 'rgba(255,255,255,0.25)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 32, 32)
  }
  return new THREE.CanvasTexture(c)
}

function makeFlashTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas')
  c.width = 64
  c.height = 64
  const ctx = c.getContext('2d')
  if (ctx) {
    const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 32)
    g.addColorStop(0, 'rgba(255,255,230,1)')
    g.addColorStop(0.3, 'rgba(255,200,90,0.9)')
    g.addColorStop(1, 'rgba(255,120,30,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 64, 64)
  }
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}
