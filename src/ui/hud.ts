import { FLAGS, TEAMS, VEHICLE } from '../config'
import type { Player } from '../entities/player'
import type { Vehicle } from '../entities/vehicle'
import type { Combatant, Team } from '../types'
import type { Flag } from '../world/flags'
import { MapRenderer, type MapMark } from './minimap'

export interface HudFrame {
  readonly player: Player
  readonly flags: readonly Flag[]
  readonly tickets: Readonly<Record<Team, number>>
  readonly combatants: readonly Combatant[]
  readonly vehicles: readonly Vehicle[]
  readonly prompt: { readonly key: string; readonly text: string } | null
  readonly showScoreboard: boolean
}

/** Writes textContent only when it changes so the HUD doesn't churn layout every frame. */
function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (html !== undefined) e.innerHTML = html
  return e
}

function teamCss(team: Team): string {
  return TEAMS.find((t) => t.id === team)?.css ?? '#fff'
}

/** In-match overlay. DOM is built once; update() only touches what changed. */
export class Hud {
  readonly root = el('div', 'layer hud')
  private readonly crosshair = el('div', 'crosshair', '<span class="t"></span><span class="b"></span><span class="l"></span><span class="r"></span>')
  private readonly hitmarker = el('div', 'hitmarker', '<span></span><span></span><span></span><span></span>')
  private readonly scope = el('div', 'scope hidden', '<span class="h"></span><span class="v"></span>')
  private readonly pause = el('div', 'pause hidden', '<b>MOUSE RELEASED</b><span>Match paused. Click anywhere to grab it back and carry on.</span>')
  private readonly vignette = el('div', 'vignette')
  private readonly flash = el('div', 'flash')
  private readonly dmgRing = el('div', 'dmg-ring')
  private readonly minimap = el('canvas', 'minimap')
  private readonly hpBar = el('div')
  private readonly hpWrap = el('div', 'hp-bar')
  private readonly vitalsName = el('div', 'name')
  private readonly vitalsStat = el('div', 'stat')
  private readonly weaponName = el('div', 'weapon-name')
  private readonly ammo = el('div', 'ammo')
  private readonly gear = el('div', 'gear')
  private readonly ticketsBlue = el('span', 'blue')
  private readonly ticketsOrange = el('span', 'orange')
  private readonly flagEls: HTMLElement[] = []
  private readonly flagFills: HTMLElement[] = []
  private readonly toast = el('div', 'toast')
  private readonly toastBig = el('div', 'big')
  private readonly toastSmall = el('div', 'small')
  private readonly toastBar = el('div')
  private readonly toastBarWrap = el('div', 'bar')
  private readonly killfeed = el('div', 'killfeed')
  private readonly scorePop = el('div', 'score-pop')
  private readonly subtitles = el('div', 'subtitles')
  private readonly prompt = el('div', 'prompt hidden')
  private readonly scoreboard = el('div', 'scoreboard hidden')
  private readonly map = new MapRenderer()
  private toastTimer = 0
  private lastToastKey = ''
  private scorePopTimer = 0
  private scoreAccum = 0
  private scoreLabel = ''
  private scoreboardTimer = 0

  constructor(parent: HTMLElement) {
    parent.appendChild(this.root)
    this.root.append(this.vignette, this.flash, this.scope, this.crosshair, this.hitmarker, this.dmgRing)

    const bl = el('div', 'bottom-left')
    this.minimap.width = 210
    this.minimap.height = 210
    const vitals = el('div', 'vitals')
    this.hpWrap.appendChild(this.hpBar)
    vitals.append(this.vitalsName, this.hpWrap, this.vitalsStat)
    bl.append(this.minimap, vitals)
    this.root.appendChild(bl)

    const br = el('div', 'bottom-right')
    br.append(this.weaponName, this.ammo, this.gear)
    this.root.appendChild(br)

    const tc = el('div', 'top-centre')
    const tickets = el('div', 'tickets')
    tickets.append(el('span', 'label', TEAMS[0]?.shortName ?? ''), this.ticketsBlue, el('span', 'label', 'ATTENTION SPAN'), this.ticketsOrange, el('span', 'label', TEAMS[1]?.shortName ?? ''))
    const flags = el('div', 'flags')
    for (const f of FLAGS) {
      const fe = el('div', 'flag')
      const fill = el('div', 'fill')
      fe.append(fill, el('span', 'letter', f.letter))
      fe.title = f.name
      flags.appendChild(fe)
      this.flagEls.push(fe)
      this.flagFills.push(fill)
    }
    this.toastBarWrap.appendChild(this.toastBar)
    this.toast.append(this.toastBig, this.toastSmall, this.toastBarWrap)
    tc.append(tickets, flags, this.toast)
    this.root.appendChild(tc)
    this.root.append(this.killfeed, this.scorePop, this.subtitles, this.prompt, this.scoreboard, this.pause)
  }

  setVisible(v: boolean): void {
    this.root.classList.toggle('hidden', !v)
  }

  addKill(attackerHtml: string, verb: string, victimHtml: string): void {
    const row = el('div', undefined, `${attackerHtml} <span class="verb">${verb}</span> ${victimHtml}`)
    this.killfeed.appendChild(row)
    while (this.killfeed.children.length > 6) this.killfeed.firstChild?.remove()
    setTimeout(() => row.remove(), 7000)
  }

  subtitle(speaker: string, team: Team, text: string): void {
    const row = el('div', undefined, `<span class="who ${team}">${speaker}:</span> ${text}`)
    this.subtitles.appendChild(row)
    while (this.subtitles.children.length > 3) this.subtitles.firstChild?.remove()
    setTimeout(() => row.remove(), 4500)
  }

  setPaused(on: boolean): void {
    this.pause.classList.toggle('hidden', !on)
  }

  showToast(big: string, small: string, key: string, seconds = 2.5): void {
    if (key === this.lastToastKey && this.toastTimer > 0) {
      this.toastTimer = seconds
      return
    }
    this.lastToastKey = key
    this.toastBig.textContent = big
    this.toastSmall.textContent = small
    this.toastTimer = seconds
    this.toast.classList.add('show')
  }

  score(amount: number, label: string): void {
    this.scoreAccum += amount
    this.scoreLabel = label
    this.scorePop.textContent = `${this.scoreAccum >= 0 ? '+' : ''}${this.scoreAccum} ${this.scoreLabel}`
    this.scorePop.classList.remove('show')
    void this.scorePop.offsetWidth
    this.scorePop.classList.add('show')
    this.scorePopTimer = 1.4
  }

  update(dt: number, f: HudFrame): void {
    const p = f.player
    this.crosshair.classList.toggle('ads', p.ads)
    // Gap scales with the real cone so bloom and stance are readable at a glance.
    const cone = p.weapon.spreadFor(p.ads, p.speed > 1, p.crouching, !p.grounded)
    this.crosshair.style.setProperty('--gap', `${Math.min(40, cone * 700).toFixed(1)}px`)
    this.crosshair.classList.toggle('hidden', p.inVehicle || p.scoped)
    this.scope.classList.toggle('hidden', !p.scoped)

    const hit = p.hits[p.hits.length - 1]
    this.hitmarker.classList.toggle('show', hit !== undefined)
    this.hitmarker.classList.toggle('kill', hit?.killed === true)
    this.hitmarker.classList.toggle('head', hit?.headshot === true && hit.killed !== true)

    const hp = p.healthFraction
    this.hpBar.style.width = `${Math.max(0, hp * 100).toFixed(1)}%`
    this.hpWrap.classList.toggle('low', hp < 0.35)
    this.vignette.style.opacity = hp < 0.5 ? String((0.5 - hp) * 1.6 + Math.sin(p.lowHealthPulse) * 0.1) : '0'
    setText(this.vitalsName, p.displayName)
    this.flash.style.opacity = p.flash > 0.01 ? p.flash.toFixed(2) : '0'
    setText(this.vitalsStat, `${p.kills} kills · ${p.deaths} deaths · ${p.score} pts`)

    while (this.dmgRing.children.length > p.damageIndicators.length) this.dmgRing.lastChild?.remove()
    while (this.dmgRing.children.length < p.damageIndicators.length) this.dmgRing.appendChild(el('div', 'dmg-arrow'))
    p.damageIndicators.forEach((d, i) => {
      const a = this.dmgRing.children[i] as HTMLElement | undefined
      if (!a) return
      a.style.transform = `rotate(${(-d.angle * 180) / Math.PI}deg)`
      a.style.opacity = String(Math.min(1, d.time))
    })

    if (p.vehicle) {
      setText(this.weaponName, VEHICLE.name)
      setText(this.ammo, `${Math.round(p.vehicle.health)}`)
      this.ammo.className = 'ammo'
      setText(this.gear, `${Math.round(Math.abs(p.vehicle.speed) * 3.6)} km/h · [E] hop out · [H] horn`)
    } else {
      const w = p.weapon
      setText(this.weaponName, w.def.name)
      const ammoHtml = w.reloading ? 'RELOADING' : `${w.mag}<small>/ ${Math.floor(w.reserve)}</small>`
      if (this.ammo.innerHTML !== ammoHtml) this.ammo.innerHTML = ammoHtml
      this.ammo.className = `ammo${w.reloading ? ' reloading' : w.mag <= w.def.magSize * 0.2 ? ' low' : ''}`
      setText(this.gear, `[G] ${p.grenadeDef.name} x${p.grenades} · [${p.activeWeapon === 0 ? '2' : '1'}] ${p.activeWeapon === 0 ? p.weapons[1].def.name : p.weapons[0].def.name}${p.resupplying ? ' · RESUPPLYING' : ''}`)
    }

    setText(this.ticketsBlue, String(Math.max(0, Math.ceil(f.tickets.blue))))
    setText(this.ticketsOrange, String(Math.max(0, Math.ceil(f.tickets.orange))))

    f.flags.forEach((flag, i) => {
      const fe = this.flagEls[i]
      const fill = this.flagFills[i]
      if (!fe || !fill) return
      fe.className = `flag${flag.owner ? ` ${flag.owner}` : ''}${flag.contested ? ' contested' : ''}${flag.contains(p.position) ? ' here' : ''}`
      const cap = flag.capturingTeam
      const showTeam = cap ?? flag.owner
      fill.style.height = showTeam ? `${(Math.abs(flag.progress) * 100).toFixed(0)}%` : '0'
      fill.style.background = showTeam ? teamCss(showTeam) : 'transparent'
    })

    if (this.toastTimer > 0) {
      this.toastTimer -= dt
      if (this.toastTimer <= 0) this.toast.classList.remove('show')
    }
    const here = f.flags.find((fl) => fl.contains(p.position) && p.alive)
    if (here && (here.capturingTeam !== null || here.contested)) {
      const mine = here.capturingTeam === p.team
      const big = here.contested ? 'CONTESTED' : mine ? (here.owner === p.team ? 'NEUTRALISING' : 'CAPTURING') : 'LOSING'
      this.showToast(here.contested ? `${here.def.name.toUpperCase()} IS CONTESTED` : `${big} ${here.def.name.toUpperCase()}`, here.contested ? 'Someone else is also talking' : mine ? 'Stay on the point. Keep talking.' : 'The enemy is dominating the conversation', `cap-${here.def.id}`, 0.5)
      this.toastBarWrap.style.display = 'block'
      this.toastBar.style.width = `${(Math.abs(here.progress) * 100).toFixed(0)}%`
      this.toastBar.style.background = teamCss(here.capturingTeam ?? here.owner ?? p.team)
    } else {
      this.toastBarWrap.style.display = 'none'
    }

    if (this.scorePopTimer > 0) {
      this.scorePopTimer -= dt
      if (this.scorePopTimer <= 0) this.scoreAccum = 0
    }

    this.prompt.classList.toggle('hidden', f.prompt === null)
    if (f.prompt !== null) {
      const html = `<b>${f.prompt.key}</b> ${f.prompt.text}`
      if (this.prompt.innerHTML !== html) this.prompt.innerHTML = html
    }

    this.drawMinimap(f)
    this.scoreboard.classList.toggle('hidden', !f.showScoreboard)
    this.scoreboardTimer -= dt
    if (f.showScoreboard && this.scoreboardTimer <= 0) {
      this.scoreboardTimer = 0.5
      this.renderScoreboard(f)
    }
  }

  private drawMinimap(f: HudFrame): void {
    const ctx = this.minimap.getContext('2d')
    if (!ctx) return
    const p = f.player
    const w = this.minimap.width
    ctx.clearRect(0, 0, w, w)
    ctx.save()
    ctx.beginPath()
    ctx.arc(w / 2, w / 2, w / 2 - 2, 0, Math.PI * 2)
    ctx.clip()
    const marks: MapMark[] = []
    for (const c of f.combatants) {
      if (!c.alive || c === p) continue
      if (c.team === p.team) marks.push({ x: c.position.x, z: c.position.z, team: c.team, kind: 'ally' })
      else if (c.position.distanceTo(p.position) < 45) marks.push({ x: c.position.x, z: c.position.z, team: c.team, kind: 'enemy' })
    }
    for (const v of f.vehicles) if (!v.wrecked) marks.push({ x: v.position.x, z: v.position.z, team: v.homeTeam, kind: 'vehicle' })
    marks.push({ x: p.position.x, z: p.position.z, team: p.team, kind: 'player', yaw: 0 })
    this.map.draw(ctx, w, w, {
      centreX: p.position.x,
      centreZ: p.position.z,
      rotation: p.yaw,
      pixelsPerMetre: 0.8,
      flags: f.flags,
      marks,
      viewerTeam: p.team,
    })
    ctx.restore()
  }

  private renderScoreboard(f: HudFrame): void {
    const table = (team: Team): string => {
      const def = TEAMS.find((t) => t.id === team)
      const rows = f.combatants
        .filter((c) => c.team === team)
        .sort((a, b) => b.score - a.score)
        .map((c) => `<tr class="${c.isPlayer ? 'me' : ''}"><td>${c.displayName}</td><td>${c.score}</td><td>${c.kills}</td><td>${c.deaths}</td></tr>`)
        .join('')
      return `<table class="${team}"><caption>${def?.name ?? team} · ${Math.ceil(f.tickets[team])}</caption><tr><th>NAME</th><th>SCORE</th><th>K</th><th>D</th></tr>${rows}</table>`
    }
    this.scoreboard.innerHTML = table('blue') + table('orange')
  }
}
