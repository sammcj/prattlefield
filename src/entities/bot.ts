import * as THREE from 'three'
import { MATCH } from '../config'
import type { GameContext } from '../context'
import type { ClassId, Combatant, DamageSource, Team } from '../types'
import type { Flag } from '../world/flags'
import { clamp, damp, randRange, wrapAngle } from '../util/math'
import * as LINES from '../prattle/lines'
import { Soldier } from './soldier'

type BotState = 'travel' | 'hold' | 'fight'

const tmpEye = new THREE.Vector3()
const tmpTarget = new THREE.Vector3()
const tmpFwd = new THREE.Vector3()
const tmpBefore = new THREE.Vector3()

export interface BotBrainConfig {
  readonly flags: readonly Flag[]
  readonly playerPosition: () => THREE.Vector3 | null
}

/**
 * Objective-driven soldier AI. Picks a flag, walks there, fights whatever it
 * sees on the way, and prattles constantly. Skill is deliberately uneven so
 * the battlefield feels populated by people rather than turrets.
 */
export class Bot extends Soldier {
  readonly isPlayer = false
  state: BotState = 'travel'
  objective: Flag | null = null
  enemy: Combatant | null = null
  readonly skill: number
  private readonly brain: BotBrainConfig
  private decisionTimer = 0
  private scanTimer = 0
  private lostSightTimer = 0
  private burstTimer = 0
  private burstOn = false
  private strafeDir = 1
  private strafeTimer = 0
  private holdTarget = new THREE.Vector3()
  private holdTimer = 0
  private stuckTimer = 0
  private avoidTimer = 0
  private avoidSign = 1
  private prattleTimer = randRange(6, 25)
  private aimErrYaw = 0
  private aimErrPitch = 0
  private aimErrTimer = 0
  private respawnDelay: number = MATCH.respawnDelay
  private crouchWish = false
  private wantJump = false
  private saidDry = false
  private fightTimer = 0
  private reactionTimer = 0
  private aimErrScale = 1

  constructor(ctx: GameContext, team: Team, classId: ClassId, name: string, brain: BotBrainConfig) {
    super(ctx, team, classId, name)
    this.brain = brain
    this.skill = randRange(0.35, 1)
  }

  private nearPlayer(range: number): boolean {
    const p = this.brain.playerPosition()
    return p !== null && p.distanceTo(this.position) < range
  }

  private prattle(list: readonly string[], chance = 1, range = 60): void {
    if (Math.random() > chance || !this.nearPlayer(range)) return
    this.say(LINES.randomLine(list))
  }

  /** Friendly fire is on, so bots hold their shot when a teammate is between them and the target. */
  private friendlyInTheWay(target: THREE.Vector3): boolean {
    this.eyePosition(tmpEye)
    tmpFwd.copy(target).sub(tmpEye)
    const dist = tmpFwd.length()
    if (dist < 0.01) return false
    tmpFwd.divideScalar(dist)
    const hit = this.ctx.world.raycast(tmpEye, tmpFwd, dist, this)
    return hit?.target?.team === this.team
  }

  override applyDamage(amount: number, attacker: Combatant | null, source: DamageSource): void {
    const wasAlive = this.alive
    super.applyDamage(amount, attacker, source)
    if (wasAlive && this.alive && attacker && attacker !== this && attacker.team === this.team) this.prattle(LINES.FRIENDLY_HIT, 0.5, 45)
  }

  override stun(seconds: number): void {
    super.stun(seconds)
    // Coming out of a stun feels like a fresh spot: slow to react and wide of the mark.
    this.reactionTimer = Math.max(this.reactionTimer, seconds)
    this.aimErrScale = 4
    this.prattle(LINES.STUNNED, 0.6)
  }

  protected override onDied(): void {
    this.enemy = null
    this.state = 'travel'
    this.respawnDelay = MATCH.respawnDelay + randRange(0, 5)
    this.prattle(LINES.DIED, 0.5, 45)
  }

  /** Called by the game when this bot registers a kill. */
  celebrate(headshot: boolean): void {
    this.prattle(headshot ? LINES.HEADSHOT : LINES.KILLED_SOMEONE, 0.5, 70)
  }

  private chooseObjective(): void {
    const flags = this.brain.flags
    let best: Flag | null = null
    let bestScore = Infinity
    for (const f of flags) {
      const ours = f.owner === this.team && Math.abs(f.progress) >= 1
      const d = f.position.distanceTo(this.position)
      let score = d
      if (ours && this.outOfAmmo) {
        // Dry: head home to resupply rather than charging in with harsh language.
        score -= 200
      } else if (ours) {
        // Defend only if it's contested or nearby and we roll for it.
        const threatened = (this.team === 'blue' ? f.orangeCount : f.blueCount) > 0
        score += threatened ? -40 : 150
      } else {
        score -= 25
      }
      // Crowding penalty keeps the team from all piling onto one point.
      const others = f.targeting[this.team] - (f === this.objective ? 1 : 0)
      score += others * 16
      score += Math.random() * 60
      if (score < bestScore) {
        bestScore = score
        best = f
      }
    }
    if (best && best !== this.objective) {
      if (this.objective) this.objective.targeting[this.team] -= 1
      this.objective = best
      best.targeting[this.team] += 1
      this.holdTimer = 0
    }
  }

  private scanForEnemies(): void {
    const range = this.weapon.def.id === 'pointmaker' ? 160 : 85
    this.eyePosition(tmpEye)
    let best: Combatant | null = null
    let bestD = range
    for (const c of this.ctx.combatants) {
      if (c.team === this.team || !c.alive) continue
      const d = c.position.distanceTo(this.position)
      if (d > bestD) continue
      tmpTarget.copy(c.position)
      tmpTarget.y += 1.3
      if (!this.ctx.world.hasLineOfSight(tmpEye, tmpTarget)) continue
      best = c
      bestD = d
    }
    if (best) {
      if (best !== this.enemy) {
        // Humans need a beat to notice someone and settle their aim; so do these.
        this.reactionTimer = 0.2 + (1 - this.skill) * 0.6
        this.aimErrScale = 3
        if (!this.enemy) this.prattle(LINES.SPOTTED, 0.2, 55)
      }
      this.enemy = best
      this.lostSightTimer = 0
    }
  }

  private aimAt(dt: number, target: THREE.Vector3): void {
    const dx = target.x - this.position.x
    const dz = target.z - this.position.z
    const dy = target.y - (this.position.y + this.mesh.eyeHeight)
    const flat = Math.sqrt(dx * dx + dz * dz)
    this.aimErrTimer -= dt
    if (this.aimErrTimer <= 0) {
      this.aimErrTimer = randRange(0.3, 0.8)
      const err = (1.1 - this.skill) * 0.045 * this.aimErrScale
      this.aimErrYaw = randRange(-err, err)
      this.aimErrPitch = randRange(-err, err) * 0.6
    }
    const wantYaw = Math.atan2(-dx, -dz) + this.aimErrYaw
    const wantPitch = Math.atan2(dy, flat) + this.aimErrPitch
    const turn = 5 + this.skill * 7
    this.yaw += wrapAngle(wantYaw - this.yaw) * Math.min(1, turn * dt)
    this.pitch = damp(this.pitch, clamp(wantPitch, -1.2, 1.2), turn, dt)
  }

  private faceDirection(dt: number, dirX: number, dirZ: number): void {
    const wantYaw = Math.atan2(-dirX, -dirZ)
    this.yaw += wrapAngle(wantYaw - this.yaw) * Math.min(1, 6 * dt)
    this.pitch = damp(this.pitch, 0, 4, dt)
  }

  /** Movement toward a world point with stuck detection. Returns remaining distance. */
  private steerTo(dt: number, target: THREE.Vector3, speedScale: number, facing: boolean): number {
    let dx = target.x - this.position.x
    let dz = target.z - this.position.z
    const dist = Math.sqrt(dx * dx + dz * dz)
    if (dist < 0.3) {
      this.move(dt, { forward: 0, strafe: 0, jump: false, sprint: false, crouch: this.crouchWish })
      return dist
    }
    dx /= dist
    dz /= dist
    if (this.avoidTimer > 0) {
      this.avoidTimer -= dt
      const ax = -dz * this.avoidSign
      const az = dx * this.avoidSign
      dx = dx * 0.3 + ax
      dz = dz * 0.3 + az
      const l = Math.hypot(dx, dz) || 1
      dx /= l
      dz /= l
    }
    if (facing) this.faceDirection(dt, dx, dz)
    this.flatForward(tmpFwd)
    const rightX = Math.cos(this.yaw)
    const rightZ = -Math.sin(this.yaw)
    const forward = (dx * tmpFwd.x + dz * tmpFwd.z) * speedScale
    const strafe = (dx * rightX + dz * rightZ) * speedScale
    tmpBefore.copy(this.position)
    this.move(dt, {
      forward,
      strafe,
      jump: this.wantJump,
      sprint: facing && dist > 20 && this.state !== 'fight',
      crouch: this.crouchWish,
    })
    this.wantJump = false
    const moved = tmpBefore.distanceTo(this.position)
    if (moved < 0.02 * speedScale && speedScale > 0.3) {
      this.stuckTimer += dt
      if (this.stuckTimer > 0.5) {
        this.stuckTimer = 0
        this.avoidTimer = randRange(0.6, 1.4)
        this.avoidSign = Math.random() < 0.5 ? -1 : 1
        this.wantJump = Math.random() < 0.5
      }
    } else {
      this.stuckTimer = Math.max(0, this.stuckTimer - dt)
    }
    return dist
  }

  private pickHoldTarget(): void {
    const f = this.objective
    if (!f) return
    const a = Math.random() * Math.PI * 2
    const r = Math.random() * f.def.radius * 0.8
    this.holdTarget.set(f.position.x + Math.cos(a) * r, 0, f.position.z + Math.sin(a) * r)
    this.holdTimer = randRange(2, 6)
    this.crouchWish = Math.random() < 0.3
  }

  private updateFight(dt: number): void {
    const enemy = this.enemy
    if (!enemy) return
    tmpTarget.copy(enemy.position)
    tmpTarget.y += 1.25
    this.aimAt(dt, tmpTarget)
    this.reactionTimer -= dt
    this.aimErrScale = damp(this.aimErrScale, 1, 2.5, dt)
    const dist = enemy.position.distanceTo(this.position)
    const w = this.weapon
    if (w.def.kind === 'rocket' && dist < 12) this.switchWeapon(1)
    else if (this.classId === 'mechanic' && this.activeWeapon === 1 && dist > 16 && this.weapons[0].mag > 0) this.switchWeapon(0)

    this.burstTimer -= dt
    if (this.burstTimer <= 0) {
      this.burstOn = !this.burstOn
      const sniper = w.def.id === 'pointmaker'
      this.burstTimer = this.burstOn ? randRange(sniper ? 0.05 : 0.25, sniper ? 0.1 : 0.7) : randRange(0.15, 0.9) * (1.4 - this.skill)
      if (this.burstOn) this.prattle(LINES.FIRING, 0.08, 45)
    }
    const aligned = Math.abs(wrapAngle(Math.atan2(-(tmpTarget.x - this.position.x), -(tmpTarget.z - this.position.z)) - this.yaw)) < 0.25
    const wasReloading = w.reloading
    this.fire(this.burstOn && aligned && this.reactionTimer <= 0 && !this.friendlyInTheWay(tmpTarget), true)
    if (!wasReloading && w.reloading) this.prattle(LINES.RELOADING, 0.25, 40)

    if (dist > 10 && dist < 26 && this.grenades > 0 && Math.random() < dt * 0.08 && this.throwGrenade()) this.prattle(LINES.GRENADE_THROWN, 0.5)

    this.strafeTimer -= dt
    if (this.strafeTimer <= 0) {
      this.strafeTimer = randRange(0.6, 1.8)
      this.strafeDir = Math.random() < 0.5 ? -1 : 1
      this.crouchWish = Math.random() < 0.35 && dist > 20
    }
    // Close the gap instead of trading potshots forever; the longer a fight drags on, the bolder they get.
    this.fightTimer += dt
    const engageRange = w.def.id === 'pointmaker' ? 60 : w.def.id === 'monologue' ? 22 : w.def.id === 'talkingpoint' ? 20 : w.def.kind === 'rocket' ? 18 : w.def.id === 'interruption' ? 8 : 14
    const wantClose = dist > engageRange || (this.fightTimer > 5 && dist > 8 && w.def.id !== 'pointmaker')
    const strafeAmount = wantClose ? 0.4 : 0.7
    const rightX = Math.cos(this.yaw)
    const rightZ = -Math.sin(this.yaw)
    const towardX = (enemy.position.x - this.position.x) / dist
    const towardZ = (enemy.position.z - this.position.z) / dist
    const mx = rightX * this.strafeDir * strafeAmount + (wantClose ? towardX : 0)
    const mz = rightZ * this.strafeDir * strafeAmount + (wantClose ? towardZ : 0)
    tmpTarget.set(this.position.x + mx * 5, 0, this.position.z + mz * 5)
    this.steerTo(dt, tmpTarget, wantClose ? 1 : 0.8, false)

    this.lostSightTimer += dt
    if (this.lostSightTimer > 3 || !enemy.alive) {
      this.enemy = null
      this.state = 'travel'
      this.burstOn = false
      this.fightTimer = 0
    }
  }

  update(dt: number): void {
    if (!this.alive) {
      if (this.respawnTimer >= this.respawnDelay) {
        const sp = this.ctx.events.spawnPointFor(this.team)
        this.spawnAt(sp.x, sp.z, sp.yaw)
        this.chooseObjective()
      }
      return
    }
    this.decisionTimer -= dt
    if (this.decisionTimer <= 0) {
      this.decisionTimer = randRange(3, 7)
      this.chooseObjective()
    }
    this.scanTimer -= dt
    if (this.scanTimer <= 0) {
      this.scanTimer = 0.2 + (1 - this.skill) * 0.3
      this.scanForEnemies()
    }
    this.prattleTimer -= dt
    if (this.prattleTimer <= 0) {
      this.prattleTimer = randRange(12, 40)
      if (this.state === 'hold') this.prattle(LINES.CAPTURING, 0.6, 50)
      else this.prattle(LINES.IDLE, 0.8, 50)
    }
    if (this.enemy && this.enemy.alive) this.state = 'fight'

    if (this.outOfAmmo) {
      if (!this.saidDry) {
        this.saidDry = true
        this.prattle(LINES.NEED_AMMO, 0.7, 60)
        this.decisionTimer = 0
      }
      this.state = 'travel'
      this.enemy = null
    } else {
      this.saidDry = false
    }

    if (this.state === 'fight') {
      this.updateFight(dt)
      return
    }
    if (this.weapon.canReload && this.weapon.mag < this.weapon.def.magSize * 0.4) this.weapon.startReload()
    if (this.activeWeapon === 1 && this.weapons[0].mag > 0) this.switchWeapon(0)

    const f = this.objective
    if (!f) {
      this.chooseObjective()
      return
    }
    const dist = f.position.distanceTo(this.position)
    if (this.state === 'travel') {
      this.crouchWish = false
      this.steerTo(dt, f.position, 1, true)
      if (dist < f.def.radius * 0.7) {
        this.state = 'hold'
        this.pickHoldTarget()
      }
    } else {
      this.holdTimer -= dt
      if (this.holdTimer <= 0) this.pickHoldTarget()
      this.steerTo(dt, this.holdTarget, 0.5, true)
      const ours = f.owner === this.team && Math.abs(f.progress) >= 1
      if (ours && Math.random() < dt * 0.15) {
        this.state = 'travel'
        this.chooseObjective()
      } else if (dist > f.def.radius * 1.2) {
        this.state = 'travel'
      }
    }
  }
}
