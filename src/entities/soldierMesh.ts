import * as THREE from 'three'
import { SOLDIER } from '../config'
import type { Team } from '../types'
import { TEAMS } from '../config'
import { damp } from '../util/math'

const skinMat = new THREE.MeshStandardMaterial({ color: 0xe8b894, roughness: 0.9 })
const bootMat = new THREE.MeshStandardMaterial({ color: 0x2a2320, roughness: 0.9 })
const gunMat = new THREE.MeshStandardMaterial({ color: 0x2c2f33, roughness: 0.6, metalness: 0.4 })
const teamMats = new Map<Team, { body: THREE.MeshStandardMaterial; helmet: THREE.MeshStandardMaterial }>()
for (const t of TEAMS) {
  const body = new THREE.MeshStandardMaterial({ color: new THREE.Color(t.colour).multiplyScalar(0.85), roughness: 0.85 })
  const helmet = new THREE.MeshStandardMaterial({ color: new THREE.Color(t.colour).multiplyScalar(0.6), roughness: 0.7 })
  teamMats.set(t.id, { body, helmet })
}
const hitboxMat = new THREE.MeshBasicMaterial({ visible: false })

const box = (w: number, h: number, d: number): THREE.BoxGeometry => new THREE.BoxGeometry(w, h, d)
const torsoGeo = box(0.52, 0.62, 0.3)
const headGeo = box(0.3, 0.3, 0.3)
const helmetGeo = box(0.38, 0.2, 0.38)
const armGeo = box(0.14, 0.58, 0.14)
const legGeo = box(0.18, 0.7, 0.18)
const bootGeo = box(0.2, 0.1, 0.26)
const packGeo = box(0.4, 0.42, 0.16)
const gunGeo = box(0.08, 0.1, 0.72)
const bodyHitGeo = box(0.62, 1.36, 0.42)
const headHitGeo = box(0.36, 0.36, 0.36)

function limb(geo: THREE.BufferGeometry, mat: THREE.Material, len: number): THREE.Group {
  // Pivot at the top so rotation swings like a joint.
  const g = new THREE.Group()
  const m = new THREE.Mesh(geo, mat)
  m.position.y = -len / 2
  m.castShadow = true
  g.add(m)
  return g
}

export interface NameTagOptions {
  readonly name: string
  readonly colour: string
}

/**
 * Low-poly blocky soldier with procedural walk/aim animation and a floating
 * name tag that doubles as a speech bubble.
 */
export class SoldierMesh {
  readonly group = new THREE.Group()
  readonly body = new THREE.Group()
  readonly bodyHitbox: THREE.Mesh
  readonly headHitbox: THREE.Mesh
  private readonly leftLeg: THREE.Group
  private readonly rightLeg: THREE.Group
  private readonly leftArm: THREE.Group
  private readonly rightArm: THREE.Group
  private readonly head: THREE.Group
  private readonly torso: THREE.Mesh
  private readonly tag: THREE.Sprite
  private readonly tagCanvas: HTMLCanvasElement
  private readonly tagTexture: THREE.CanvasTexture
  private readonly tagName: string
  private readonly tagColour: string
  private bubbleText = ''
  private bubbleTimer = 0
  private phase = 0
  private crouchAmount = 0
  private deathT = -1
  private deathDir = 1

  constructor(team: Team, tag: NameTagOptions) {
    const mats = teamMats.get(team)
    if (!mats) throw new Error(`unknown team ${team}`)
    this.tagName = tag.name
    this.tagColour = tag.colour

    this.torso = new THREE.Mesh(torsoGeo, mats.body)
    this.torso.position.y = 1.15
    this.torso.castShadow = true
    this.body.add(this.torso)

    const pack = new THREE.Mesh(packGeo, mats.helmet)
    pack.position.set(0, 1.15, -0.22)
    pack.castShadow = true
    this.body.add(pack)

    this.head = new THREE.Group()
    this.head.position.y = 1.5
    const headMesh = new THREE.Mesh(headGeo, skinMat)
    headMesh.position.y = 0.16
    headMesh.castShadow = true
    const helmet = new THREE.Mesh(helmetGeo, mats.helmet)
    helmet.position.y = 0.32
    helmet.castShadow = true
    this.head.add(headMesh, helmet)
    this.body.add(this.head)

    this.leftArm = limb(armGeo, mats.body, 0.58)
    this.leftArm.position.set(-0.34, 1.42, 0)
    this.rightArm = limb(armGeo, mats.body, 0.58)
    this.rightArm.position.set(0.34, 1.42, 0)
    this.body.add(this.leftArm, this.rightArm)

    const gun = new THREE.Mesh(gunGeo, gunMat)
    gun.position.set(-0.1, -0.5, 0.3)
    gun.castShadow = true
    this.rightArm.add(gun)

    this.leftLeg = limb(legGeo, mats.helmet, 0.7)
    this.leftLeg.position.set(-0.13, 0.82, 0)
    this.rightLeg = limb(legGeo, mats.helmet, 0.7)
    this.rightLeg.position.set(0.13, 0.82, 0)
    for (const leg of [this.leftLeg, this.rightLeg]) {
      const boot = new THREE.Mesh(bootGeo, bootMat)
      boot.position.set(0, -0.72, 0.04)
      leg.add(boot)
    }
    this.body.add(this.leftLeg, this.rightLeg)
    this.group.add(this.body)

    this.bodyHitbox = new THREE.Mesh(bodyHitGeo, hitboxMat)
    this.bodyHitbox.position.y = 0.72
    this.headHitbox = new THREE.Mesh(headHitGeo, hitboxMat)
    this.headHitbox.position.y = 1.68
    this.group.add(this.bodyHitbox, this.headHitbox)

    this.tagCanvas = document.createElement('canvas')
    this.tagCanvas.width = 512
    this.tagCanvas.height = 128
    this.tagTexture = new THREE.CanvasTexture(this.tagCanvas)
    this.tagTexture.colorSpace = THREE.SRGBColorSpace
    const tagMat = new THREE.SpriteMaterial({ map: this.tagTexture, depthTest: false, transparent: true })
    this.tag = new THREE.Sprite(tagMat)
    this.tag.position.y = 2.25
    this.tag.scale.set(3.2, 0.8, 1)
    this.tag.renderOrder = 10
    this.group.add(this.tag)
    this.redrawTag()
  }

  setTagVisible(v: boolean): void {
    this.tag.visible = v
  }

  say(text: string, seconds = 3.5): void {
    this.bubbleText = text
    this.bubbleTimer = seconds
    this.redrawTag()
  }

  private redrawTag(): void {
    const ctx = this.tagCanvas.getContext('2d')
    if (!ctx) return
    const w = this.tagCanvas.width
    const h = this.tagCanvas.height
    ctx.clearRect(0, 0, w, h)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    if (this.bubbleText) {
      ctx.font = 'bold 30px "Trebuchet MS", sans-serif'
      const text = this.bubbleText
      const tw = Math.min(w - 16, ctx.measureText(text).width + 32)
      ctx.fillStyle = 'rgba(255,255,255,0.92)'
      ctx.beginPath()
      ctx.roundRect((w - tw) / 2, 4, tw, 52, 12)
      ctx.fill()
      ctx.fillStyle = '#111'
      ctx.fillText(text, w / 2, 30, w - 40)
    }
    ctx.font = 'bold 34px "Trebuchet MS", sans-serif'
    ctx.lineWidth = 6
    ctx.strokeStyle = 'rgba(0,0,0,0.8)'
    ctx.strokeText(this.tagName, w / 2, 94)
    ctx.fillStyle = this.tagColour
    ctx.fillText(this.tagName, w / 2, 94)
    this.tagTexture.needsUpdate = true
  }

  /** Animates limbs. speed in m/s along ground, pitch is aim pitch in radians. */
  update(dt: number, speed: number, pitch: number, crouching: boolean, grounded: boolean): void {
    if (this.bubbleTimer > 0) {
      this.bubbleTimer -= dt
      if (this.bubbleTimer <= 0) {
        this.bubbleText = ''
        this.redrawTag()
      }
    }
    if (this.deathT >= 0) {
      this.deathT += dt
      const t = Math.min(1, this.deathT / 0.45)
      const ease = 1 - (1 - t) * (1 - t)
      this.body.rotation.x = ease * (Math.PI / 2) * this.deathDir * 0.95
      this.body.position.y = -ease * 0.15
      return
    }
    this.crouchAmount = damp(this.crouchAmount, crouching ? 1 : 0, 12, dt)
    const stride = grounded ? speed : 0
    this.phase += dt * Math.max(stride, 0) * 1.9
    const swing = Math.sin(this.phase) * Math.min(1, stride / 4) * 0.75
    this.leftLeg.rotation.x = swing * (1 - this.crouchAmount * 0.6)
    this.rightLeg.rotation.x = -swing * (1 - this.crouchAmount * 0.6)
    if (!grounded) {
      this.leftLeg.rotation.x = -0.5
      this.rightLeg.rotation.x = 0.3
    }
    // Two-handed aim pose: both arms forward, following pitch.
    const aim = -Math.PI / 2 - pitch
    this.rightArm.rotation.x = aim
    this.rightArm.rotation.z = -0.15
    this.leftArm.rotation.x = aim - 0.1
    this.leftArm.rotation.z = 0.55
    this.leftArm.rotation.y = 0.3
    this.head.rotation.x = -pitch * 0.6
    const bob = grounded ? Math.abs(Math.sin(this.phase)) * Math.min(1, stride / 4) * 0.05 : 0
    this.body.position.y = -this.crouchAmount * 0.55 + bob
    this.leftLeg.scale.y = 1 - this.crouchAmount * 0.5
    this.rightLeg.scale.y = 1 - this.crouchAmount * 0.5
    this.bodyHitbox.scale.y = 1 - this.crouchAmount * 0.3
    this.bodyHitbox.position.y = 0.72 - this.crouchAmount * 0.3
    this.headHitbox.position.y = 1.68 - this.crouchAmount * 0.55
  }

  die(): void {
    this.deathT = 0
    this.deathDir = Math.random() < 0.5 ? 1 : -1
    this.tag.visible = false
  }

  revive(): void {
    this.deathT = -1
    this.body.rotation.x = 0
    this.body.position.y = 0
    this.tag.visible = true
  }

  get eyeHeight(): number {
    return SOLDIER.eyeHeight - this.crouchAmount * (SOLDIER.eyeHeight - SOLDIER.crouchEyeHeight)
  }
}
