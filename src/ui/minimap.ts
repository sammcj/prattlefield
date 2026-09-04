import { FLAGS, MAP, TEAMS } from '../config'
import type { Team } from '../types'
import { heightAt, slopeAt } from '../world/terrain'
import type { Flag } from '../world/flags'

export interface MapMark {
  readonly x: number
  readonly z: number
  readonly team: Team | 'none'
  readonly kind: 'ally' | 'enemy' | 'vehicle' | 'player'
  readonly yaw?: number
}

export interface MapDrawOptions {
  readonly centreX: number
  readonly centreZ: number
  readonly rotation: number
  readonly pixelsPerMetre: number
  readonly flags: readonly Flag[]
  readonly marks: readonly MapMark[]
  readonly viewerTeam: Team
}

const TEAM_CSS: Record<Team, string> = { blue: TEAMS[0]?.css ?? '#5aa0ff', orange: TEAMS[1]?.css ?? '#ff9a3c' }

/**
 * Draws the tactical map: a cached terrain thumbnail plus live markers.
 * Used both for the rotating HUD minimap and the deploy screen overview.
 */
export class MapRenderer {
  private readonly thumb: HTMLCanvasElement

  constructor() {
    this.thumb = document.createElement('canvas')
    const n = 256
    this.thumb.width = n
    this.thumb.height = n
    const ctx = this.thumb.getContext('2d')
    if (!ctx) return
    const img = ctx.createImageData(n, n)
    for (let py = 0; py < n; py++) {
      for (let px = 0; px < n; px++) {
        const x = (px / n - 0.5) * MAP.size
        const z = (py / n - 0.5) * MAP.size
        const h = heightAt(x, z)
        const s = slopeAt(x, z)
        let r = 70
        let g = 120
        let b = 55
        if (h < MAP.waterLevel) {
          r = 40
          g = 90
          b = 140
        } else if (h < MAP.waterLevel + 1.5) {
          r = 180
          g = 165
          b = 120
        } else {
          const shade = Math.min(1, s * 0.9)
          r = 70 + shade * 60
          g = 120 - shade * 40
          b = 55 + shade * 20
          const hf = Math.min(1, Math.max(0, (h - 4) / 20))
          r += hf * 60
          g += hf * 30
          b += hf * 40
        }
        const i = (py * n + px) * 4
        img.data[i] = r
        img.data[i + 1] = g
        img.data[i + 2] = b
        img.data[i + 3] = 255
      }
    }
    ctx.putImageData(img, 0, 0)
    // Roads between the flags help the map read as a place.
    ctx.strokeStyle = 'rgba(60,50,40,0.7)'
    ctx.lineWidth = 3
    const toPx = (v: number): number => ((v / MAP.size) + 0.5) * n
    const route = (ids: string[]): void => {
      ctx.beginPath()
      ids.forEach((id, i) => {
        const f = FLAGS.find((ff) => ff.id === id)
        if (!f) return
        if (i === 0) ctx.moveTo(toPx(f.x), toPx(f.z))
        else ctx.lineTo(toPx(f.x), toPx(f.z))
      })
      ctx.stroke()
    }
    route(['a', 'c', 'e'])
    route(['b', 'c', 'd'])
  }

  draw(ctx: CanvasRenderingContext2D, w: number, h: number, o: MapDrawOptions): void {
    ctx.save()
    ctx.translate(w / 2, h / 2)
    ctx.rotate(o.rotation)
    const s = o.pixelsPerMetre
    const toX = (x: number): number => (x - o.centreX) * s
    const toY = (z: number): number => (z - o.centreZ) * s
    ctx.drawImage(this.thumb, toX(-MAP.half), toY(-MAP.half), MAP.size * s, MAP.size * s)

    for (const f of o.flags) {
      const x = toX(f.def.x)
      const y = toY(f.def.z)
      const col = f.owner ? TEAM_CSS[f.owner] : '#e6e6e6'
      ctx.beginPath()
      ctx.arc(x, y, f.def.radius * s, 0, Math.PI * 2)
      ctx.fillStyle = f.owner ? (f.owner === 'blue' ? 'rgba(90,160,255,0.25)' : 'rgba(255,154,60,0.25)') : 'rgba(255,255,255,0.12)'
      ctx.fill()
      ctx.strokeStyle = col
      ctx.lineWidth = f.contested ? 3 : 1.5
      ctx.stroke()
      if (f.capturingTeam) {
        ctx.beginPath()
        ctx.arc(x, y, f.def.radius * s * 0.6, -Math.PI / 2, -Math.PI / 2 + Math.abs(f.progress) * Math.PI * 2)
        ctx.strokeStyle = TEAM_CSS[f.capturingTeam]
        ctx.lineWidth = 3
        ctx.stroke()
      }
      ctx.save()
      ctx.translate(x, y)
      ctx.rotate(-o.rotation)
      ctx.fillStyle = col
      const letterPx = Math.max(11, Math.min(18, 9 * s + 6))
      ctx.font = `bold ${letterPx}px Trebuchet MS, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.shadowColor = '#000'
      ctx.shadowBlur = 4
      ctx.fillText(f.def.letter, 0, 0)
      ctx.font = `${Math.max(8, Math.min(12, letterPx * 0.65))}px Trebuchet MS, sans-serif`
      ctx.fillStyle = '#f2f2f2'
      ctx.fillText(f.def.name, 0, letterPx * 0.9)
      ctx.restore()
    }

    for (const t of TEAMS) {
      const x = toX(t.hq.x)
      const y = toY(t.hq.z)
      ctx.fillStyle = t.css
      ctx.beginPath()
      ctx.rect(x - 5, y - 5, 10, 10)
      ctx.fill()
    }

    for (const m of o.marks) {
      const x = toX(m.x)
      const y = toY(m.z)
      if (m.kind === 'vehicle') {
        ctx.fillStyle = m.team === o.viewerTeam ? '#cfe7ff' : m.team === 'none' ? '#ddd' : '#ffd0a0'
        ctx.fillRect(x - 3, y - 4, 6, 8)
        continue
      }
      ctx.beginPath()
      if (m.kind === 'player' && m.yaw !== undefined) {
        ctx.save()
        ctx.translate(x, y)
        ctx.rotate(-m.yaw)
        ctx.moveTo(0, -7)
        ctx.lineTo(5, 5)
        ctx.lineTo(0, 2)
        ctx.lineTo(-5, 5)
        ctx.closePath()
        ctx.fillStyle = '#fff'
        ctx.fill()
        ctx.restore()
        continue
      }
      ctx.arc(x, y, m.kind === 'enemy' ? 3.5 : 3, 0, Math.PI * 2)
      ctx.fillStyle = m.kind === 'enemy' ? '#ff4a4a' : TEAM_CSS[o.viewerTeam]
      ctx.fill()
      if (m.kind === 'enemy') {
        ctx.strokeStyle = '#000'
        ctx.lineWidth = 1
        ctx.stroke()
      }
    }
    ctx.restore()
  }
}
