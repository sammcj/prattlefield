import type * as THREE from 'three'
import { MATCH, TEAMS } from './config'
import type { GameEvents, SpawnPoint } from './context'
import type { Bot } from './entities/bot'
import type { Player } from './entities/player'
import type { Soldier } from './entities/soldier'
import type { Effects } from './combat/effects'
import type { AudioEngine } from './audio/synth'
import type { Voice } from './audio/voice'
import type { Combatant, KillEvent, PrattleEvent, Team } from './types'
import type { Flag } from './world/flags'
import { countOwned } from './world/flags'
import type { Hud } from './ui/hud'
import * as LINES from './prattle/lines'
import { pick } from './util/math'

export interface DeathNote {
  readonly title: string
  readonly detail: string
}

/**
 * Conquest rules and the event sink for everything that happens in combat:
 * tickets, scoring, kill feed, chatter routing and round end.
 */
export class Match implements GameEvents {
  readonly tickets: Record<Team, number> = { blue: MATCH.startTickets, orange: MATCH.startTickets }
  winner: Team | null = null
  lastDeath: DeathNote | null = null
  private teamKills = 0
  private readonly flags: readonly Flag[]
  private readonly hud: Hud
  private readonly audio: AudioEngine
  private readonly voice: Voice
  private readonly effects: Effects
  private player: Player | null = null
  private bots: readonly Bot[] = []
  private soldiers: readonly Soldier[] = []
  private flagTickTimer = 0
  private live = false

  constructor(flags: readonly Flag[], hud: Hud, audio: AudioEngine, voice: Voice, effects: Effects) {
    this.flags = flags
    this.hud = hud
    this.audio = audio
    this.voice = voice
    this.effects = effects
  }

  bind(player: Player, bots: readonly Bot[]): void {
    this.player = player
    this.bots = bots
    this.soldiers = [player, ...bots]
  }

  private nameHtml(c: Combatant): string {
    return `<span class="${c.team}${c.isPlayer ? ' me' : ''}">${c.displayName}</span>`
  }

  spawnPointFor(team: Team): SpawnPoint {
    const owned = this.flags.filter((f) => f.owner === team && Math.abs(f.progress) >= 1 && !f.contested)
    const hq = TEAMS.find((t) => t.id === team)?.hq ?? { x: 0, z: 0 }
    const options: { x: number; z: number; r: number }[] = [{ x: hq.x, z: hq.z, r: 10 }]
    for (const f of owned) options.push({ x: f.def.x, z: f.def.z, r: f.def.radius * 0.7 })
    const o = pick(options)
    const a = Math.random() * Math.PI * 2
    const r = Math.random() * o.r
    const x = o.x + Math.cos(a) * r
    const z = o.z + Math.sin(a) * r
    return { x, z, yaw: Math.atan2(x, z) }
  }

  onKill(ev: KillEvent): void {
    const { attacker, victim, source } = ev
    if (this.live) this.tickets[victim.team] = Math.max(0, this.tickets[victim.team] - MATCH.ticketPerDeath)
    let verb: string
    let attackerHtml: string
    if (attacker && attacker.team !== victim.team) {
      attacker.kills += 1
      const headshot = source.kind === 'weapon' && source.headshot
      this.onScore(attacker, MATCH.scoreKill + (headshot ? MATCH.scoreHeadshot : 0), headshot ? 'HEADSHOT' : 'KILL')
      if (attacker.isPlayer) {
        this.audio.play('killConfirm')
        if (headshot) this.audio.play('headshot', { volume: 0.6 })
      } else {
        const bot = this.bots.find((b) => b === attacker)
        bot?.celebrate(headshot)
      }
      verb =
        source.kind === 'explosion'
          ? `${pick(LINES.EXPLOSION_VERBS)}`
          : source.kind === 'vehicle'
            ? 'flattened'
            : headshot
              ? `${pick(LINES.KILL_VERBS)} [HEADSHOT]`
              : pick(LINES.KILL_VERBS)
      attackerHtml = this.nameHtml(attacker)
      if (source.kind === 'vehicle') {
        const bot = this.bots.find((b) => b === attacker)
        if (bot) bot.say(pick(LINES.ROADKILL))
      }
    } else if (attacker) {
      attackerHtml = this.nameHtml(attacker)
      verb = 'accidentally silenced'
      const before = attacker.score
      attacker.score = Math.max(0, attacker.score - MATCH.scoreTeamKill)
      const victimBot = this.bots.find((b) => b === victim)
      victimBot?.say(pick(LINES.TEAMKILLED))
      if (attacker.isPlayer) {
        this.teamKills += 1
        const [big, small] = LINES.teamKillAward(this.teamKills)
        this.hud.score(attacker.score - before, 'TEAM KILL')
        this.hud.showToast(big, small, `teamkill-${this.teamKills}`, 4)
        this.audio.play('killConfirm', { pitch: 0.55, volume: 0.7 })
      }
    } else {
      const cause = source.kind === 'fall' ? pick(LINES.FALL) : source.kind === 'explosion' ? source.weaponName : source.kind === 'levolution' ? 'the water tower' : 'nobody in particular'
      attackerHtml = `<span class="verb">${cause}</span>`
      verb = source.kind === 'fall' ? 'finished off' : 'flattened'
    }
    this.hud.addKill(attackerHtml, verb, this.nameHtml(victim))

    if (victim.isPlayer) {
      const weapon = source.kind === 'weapon' || source.kind === 'explosion' ? source.weaponName : source.kind === 'vehicle' ? 'The Ute' : source.kind === 'fall' ? 'gravity' : 'the water tower'
      this.lastDeath = {
        title: attacker && attacker !== victim ? `${pick(LINES.DEATH_CAM_CAPTIONS)} ${attacker.displayName} ${verb.replace(/ \[HEADSHOT\]/, '')} you.` : pick(LINES.DEATH_CAM_CAPTIONS),
        detail: `Cause of silence: ${weapon}.${source.kind === 'weapon' && source.headshot ? ' Right in the opinion.' : ''}`,
      }
    }
  }

  onScore(who: Combatant, amount: number, label: string): void {
    who.score += amount
    if (who.isPlayer) this.hud.score(amount, label)
  }

  onPrattle(ev: PrattleEvent): void {
    const p = this.player
    if (!p) return
    const dist = ev.position ? ev.position.distanceTo(p.position) : 0
    const isPlayer = ev.speaker === p.displayName
    if (dist > 70 && !isPlayer) return
    this.hud.subtitle(ev.speaker, ev.team, ev.text)
    this.voice.speak(ev.speaker, ev.text, { distance: isPlayer ? 0 : dist, priority: isPlayer })
  }

  onExplosion(position: THREE.Vector3, radius: number): void {
    const p = this.player
    if (!p) return
    const d = position.distanceTo(p.position)
    const amount = Math.max(0, 1 - d / (radius * 6))
    this.effects.shake = Math.max(this.effects.shake, amount * 1.2)
  }

  /** Runs conquest logic. Tickets only move while `live` so the menu doesn't decide the round. */
  update(dt: number, combatants: readonly Combatant[], live = true): Team | null {
    this.live = live
    const p = this.player
    for (const f of this.flags) {
      const change = f.update(dt, combatants)
      if (!change) continue
      for (const c of change.capturers) this.onScore(c, MATCH.scoreCapture, 'CAPTURE')
      if (change.owner) {
        const teamDef = TEAMS.find((t) => t.id === change.owner)
        if (p) {
          const mine = change.owner === p.team
          this.audio.play(mine ? 'capture' : 'lost')
          this.hud.showToast(`${mine ? 'WE' : 'THEY'} TOOK ${f.def.name.toUpperCase()}`, mine ? `${teamDef?.name ?? ''} now dominate the conversation at ${f.def.letter}` : `${f.def.letter} is under new, louder management`, `own-${f.def.id}-${change.owner}`)
          if (!mine) {
            const nearby = this.bots.find((b) => b.team === p.team && b.alive && b.position.distanceTo(p.position) < 50)
            if (nearby && Math.random() < 0.6) nearby.say(pick(LINES.LOST_FLAG))
          }
        }
      } else if (p) {
        this.audio.play('flagTick', { volume: 0.5 })
        this.hud.showToast(`${f.def.name.toUpperCase()} NEUTRALISED`, 'Nobody is talking here right now', `neutral-${f.def.id}`)
      }
    }

    // Friendly flags double as ammo dumps so a long life doesn't end in a stalemate of empty guns.
    for (const s of this.soldiers) {
      if (!s.alive) continue
      const here = this.flags.find((f) => f.owner === s.team && Math.abs(f.progress) >= 1 && f.contains(s.position))
      if (here) s.resupply(dt)
    }

    if (p && p.alive) {
      const here = this.flags.find((f) => f.contains(p.position))
      this.flagTickTimer -= dt
      if (here && here.capturingTeam === p.team && this.flagTickTimer <= 0) {
        this.flagTickTimer = 1
        this.audio.play('flagTick', { volume: 0.25 })
      }
    }

    if (!live) return null
    const blueFlags = countOwned(this.flags, 'blue')
    const orangeFlags = countOwned(this.flags, 'orange')
    if (blueFlags !== orangeFlags) {
      const loser: Team = blueFlags < orangeFlags ? 'blue' : 'orange'
      const diff = Math.abs(blueFlags - orangeFlags)
      this.tickets[loser] = Math.max(0, this.tickets[loser] - MATCH.bleedPerSecondPerFlag * diff * dt)
    }
    if (this.winner === null) {
      if (this.tickets.blue <= 0) this.winner = 'orange'
      else if (this.tickets.orange <= 0) this.winner = 'blue'
    }
    return this.winner
  }
}
