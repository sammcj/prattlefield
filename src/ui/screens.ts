import { GRENADES, MAP, PRIMARIES, TEAMS, WEAPONS } from '../config'
import type { Combatant, GrenadeDef, GrenadeId, Loadout, Team, WeaponDef } from '../types'
import type { Flag } from '../world/flags'
import { LOADING_TIPS, randomLine } from '../prattle/lines'
import { MapRenderer } from './minimap'

export interface DeployChoice {
  readonly loadout: Loadout
  readonly x: number
  readonly z: number
  readonly yaw: number
}

export interface DeployOptions {
  readonly flags: readonly Flag[]
  readonly team: Team
  readonly tickets: Readonly<Record<Team, number>>
  readonly initialLoadout: Loadout
  readonly deathNote: { readonly title: string; readonly detail: string } | null
  readonly firstTime: boolean
}

export interface EndOptions {
  readonly winner: Team
  readonly team: Team
  readonly tickets: Readonly<Record<Team, number>>
  readonly player: Combatant
  readonly combatants: readonly Combatant[]
}

interface SpawnOption {
  readonly label: string
  readonly x: number
  readonly z: number
  readonly radius: number
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (html !== undefined) e.innerHTML = html
  return e
}

const CONTROLS: ReadonlyArray<readonly [string, string]> = [
  ['WASD', 'move'],
  ['Shift', 'sprint'],
  ['Space', 'jump'],
  ['C / Ctrl', 'crouch'],
  ['Mouse', 'look, LMB fire, RMB aim'],
  ['R', 'reload'],
  ['1 / 2 / wheel', 'swap weapon'],
  ['Friendly flag', 'stand on it to resupply'],
  ['G', 'throw your grenade'],
  ['Q', 'say something unhelpful'],
  ['E', 'get in / out of the Ute'],
  ['Tab', 'scoreboard'],
  ['Esc', 'release the mouse (click to grab it back)'],
]

const STAT_LABELS: ReadonlyArray<readonly [keyof WeaponDef['stats'], string]> = [
  ['damage', 'Damage'],
  ['rate', 'Rate'],
  ['range', 'Range'],
  ['control', 'Control'],
]

function weaponCard(def: WeaponDef, selected: boolean): HTMLElement {
  const card = el('div', `class-card${selected ? ' selected' : ''}`)
  const bars = el('div', 'bars')
  for (const [key, label] of STAT_LABELS) {
    bars.appendChild(el('div', undefined, `${label}<i><b style="width:${Math.round(def.stats[key] * 100)}%"></b></i>`))
  }
  card.append(el('div', 'cname', def.name), el('div', 'cblurb', def.blurb), bars)
  return card
}

function grenadeCard(def: GrenadeDef, selected: boolean): HTMLElement {
  const card = el('div', `class-card${selected ? ' selected' : ''}`)
  card.append(el('div', 'cname', def.name), el('div', 'cweapon', `x${def.count} · ${def.kind}`), el('div', 'cblurb', def.blurb))
  return card
}

/** Full-screen menus: title, deploy and end of round. One is shown at a time. */
export class Screens {
  readonly root = el('div', 'layer screens')
  private readonly fadeEl = el('div', 'fade')
  private readonly map = new MapRenderer()
  private current: HTMLElement | null = null

  constructor(parent: HTMLElement) {
    parent.append(this.root, this.fadeEl)
  }

  private show(screen: HTMLElement): void {
    this.current?.remove()
    this.current = screen
    this.root.appendChild(screen)
  }

  hide(): void {
    this.current?.remove()
    this.current = null
  }

  fade(on: boolean): void {
    this.fadeEl.classList.toggle('on', on)
  }

  showMenu(onStart: () => void): void {
    const s = el('div', 'screen')
    s.append(el('div', 'title', 'Prattlefield'), el('div', 'tagline', 'All talk. Some action.'))
    const btn = el('button', 'btn', 'Butt In')
    btn.addEventListener('click', () => onStart())
    const controls = el('div', 'controls')
    for (const [k, v] of CONTROLS) controls.append(el('b', undefined, k), el('span', undefined, v))
    s.append(btn, controls, el('div', 'tip', randomLine(LOADING_TIPS)))
    this.show(s)
  }

  /** Loadout picker: one primary, one grenade type, then the map. */
  private buildLoadoutPicker(initial: Loadout, onChange: (l: Loadout) => void): HTMLElement {
    const left = el('div')
    let primary = initial.primary
    let grenade: GrenadeId = initial.grenade
    const emit = (): void => onChange({ primary, secondary: initial.secondary, grenade })

    left.appendChild(el('h2', undefined, 'Pick your argument'))
    const weaponCards: HTMLElement[] = []
    const weaponGrid = el('div', 'weapon-grid')
    for (const id of PRIMARIES) {
      const def = WEAPONS[id]
      if (!def) continue
      const card = weaponCard(def, id === primary)
      card.addEventListener('click', () => {
        primary = id
        weaponCards.forEach((c) => c.classList.remove('selected'))
        card.classList.add('selected')
        emit()
      })
      weaponCards.push(card)
      weaponGrid.appendChild(card)
    }
    left.appendChild(weaponGrid)

    left.appendChild(el('h2', undefined, 'Pick your grenade'))
    const row = el('div', 'grenade-row')
    const grenadeCards: HTMLElement[] = []
    for (const def of Object.values(GRENADES)) {
      const card = grenadeCard(def, def.id === grenade)
      card.addEventListener('click', () => {
        grenade = def.id
        grenadeCards.forEach((c) => c.classList.remove('selected'))
        card.classList.add('selected')
        emit()
      })
      grenadeCards.push(card)
      row.appendChild(card)
    }
    left.appendChild(row)
    return left
  }

  showDeploy(o: DeployOptions, onDeploy: (choice: DeployChoice) => void): void {
    const s = el('div', 'screen')
    const grid = el('div', 'deploy')
    const teamDef = TEAMS.find((t) => t.id === o.team)
    if (o.deathNote) {
      grid.appendChild(el('div', 'death-note', `${o.deathNote.title}<small>${o.deathNote.detail}</small>`))
    } else if (o.firstTime) {
      grid.appendChild(el('div', 'death-note', `Welcome to ${teamDef?.name ?? 'the team'}.<small>Operation Small Talk. Hold the flags, drain their Attention Span, and never, ever stop talking.</small>`))
    }

    let loadout = o.initialLoadout
    const status = el('div', 'deploy-status')
    const left = this.buildLoadoutPicker(o.initialLoadout, (l) => {
      loadout = l
      updateStatus()
    })
    left.appendChild(el('div', 'tip', randomLine(LOADING_TIPS)))

    const right = el('div')
    right.appendChild(el('h2', undefined, 'Pick where to start talking'))
    const canvas = el('canvas', 'deploy-map')
    canvas.width = 560
    canvas.height = 560
    right.appendChild(canvas)

    const spawns: SpawnOption[] = []
    if (teamDef) spawns.push({ label: 'HQ', x: teamDef.hq.x, z: teamDef.hq.z, radius: 10 })
    for (const f of o.flags) if (f.owner === o.team && Math.abs(f.progress) >= 1 && !f.contested) spawns.push({ label: f.def.name, x: f.def.x, z: f.def.z, radius: f.def.radius })
    let selected: SpawnOption = spawns[0] ?? { label: 'HQ', x: 0, z: 0, radius: 10 }
    const pxPerM = canvas.width / MAP.size

    const updateStatus = (): void => {
      status.innerHTML = `Deploying at <b>${selected.label}</b> with <b>${WEAPONS[loadout.primary]?.name ?? ''}</b> and <b>${GRENADES[loadout.grenade].name}</b>. Click a highlighted point to move.`
    }

    const draw = (): void => {
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      this.map.draw(ctx, canvas.width, canvas.height, {
        centreX: 0,
        centreZ: 0,
        rotation: 0,
        pixelsPerMetre: pxPerM,
        flags: o.flags,
        marks: [],
        viewerTeam: o.team,
      })
      for (const sp of spawns) {
        const x = (sp.x + MAP.half) * pxPerM
        const y = (sp.z + MAP.half) * pxPerM
        const r = Math.max(14, sp.radius * pxPerM)
        ctx.beginPath()
        ctx.arc(x, y, r + (sp === selected ? 6 : 0), 0, Math.PI * 2)
        ctx.strokeStyle = sp === selected ? '#ffb347' : 'rgba(255,255,255,0.6)'
        ctx.lineWidth = sp === selected ? 3 : 1.5
        ctx.setLineDash(sp === selected ? [] : [4, 4])
        ctx.stroke()
        ctx.setLineDash([])
      }
      ctx.fillStyle = '#fff'
      ctx.font = '12px Trebuchet MS, sans-serif'
      ctx.fillText('N', 10, 18)
    }
    canvas.addEventListener('click', (e) => {
      const rect = canvas.getBoundingClientRect()
      const mx = ((e.clientX - rect.left) / rect.width) * canvas.width
      const my = ((e.clientY - rect.top) / rect.height) * canvas.height
      let best: SpawnOption | null = null
      let bestD = 40
      for (const sp of spawns) {
        const d = Math.hypot((sp.x + MAP.half) * pxPerM - mx, (sp.z + MAP.half) * pxPerM - my)
        if (d < bestD) {
          bestD = d
          best = sp
        }
      }
      if (best) {
        selected = best
        draw()
        updateStatus()
      }
    })
    draw()
    updateStatus()

    const foot = el('div', 'deploy-foot')
    const btn = el('button', 'btn', 'Deploy')
    btn.addEventListener('click', () => {
      // Ownership may have changed while the player dithered; fall back to HQ rather than spawning into the enemy.
      const stillOurs = selected.label === 'HQ' || o.flags.some((f) => f.def.name === selected.label && f.owner === o.team && Math.abs(f.progress) >= 1 && !f.contested)
      const spot = stillOurs ? selected : (spawns[0] ?? selected)
      const a = Math.random() * Math.PI * 2
      const r = Math.random() * spot.radius * 0.6
      const x = spot.x + Math.cos(a) * r
      const z = spot.z + Math.sin(a) * r
      onDeploy({ loadout, x, z, yaw: Math.atan2(x, z) })
    })
    foot.append(status, btn)
    grid.append(left, right, foot)
    s.appendChild(grid)
    this.show(s)
  }

  showEnd(o: EndOptions, onRestart: () => void): void {
    const s = el('div', 'screen')
    const won = o.winner === o.team
    const winner = TEAMS.find((t) => t.id === o.winner)
    s.append(
      el('div', `result ${won ? 'win' : 'loss'}`, won ? 'Victory' : 'Defeat'),
      el('div', 'result-sub', won ? `${winner?.name ?? ''} got the last word.` : `${winner?.name ?? ''} out-talked you. Attention span exhausted.`),
    )
    const stats = el('div', 'stats')
    const top = [...o.combatants].sort((a, b) => b.score - a.score)
    const rank = top.indexOf(o.player) + 1
    stats.append(
      el('div', undefined, `${o.player.score}<span>SCORE</span>`),
      el('div', undefined, `${o.player.kills}<span>KILLS</span>`),
      el('div', undefined, `${o.player.deaths}<span>DEATHS</span>`),
      el('div', undefined, `#${rank}<span>OF ${top.length}</span>`),
      el('div', undefined, `${top[0]?.displayName ?? ''}<span>LOUDEST</span>`),
    )
    const btn = el('button', 'btn', 'Go again')
    btn.addEventListener('click', () => onRestart())
    s.append(stats, btn, el('div', 'tip', randomLine(LOADING_TIPS)))
    this.show(s)
  }
}
