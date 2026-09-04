import * as THREE from 'three'
import { CLASSES, LEVOLUTION, MAP, MATCH, TEAMS, THEME } from './config'
import type { GameContext } from './context'
import { AudioEngine } from './audio/synth'
import { Voice } from './audio/voice'
import { Effects } from './combat/effects'
import { Projectiles } from './combat/projectiles'
import { Bot } from './entities/bot'
import { Player } from './entities/player'
import type { Soldier } from './entities/soldier'
import { Vehicle } from './entities/vehicle'
import { Input } from './input'
import { Match } from './match'
import * as LINES from './prattle/lines'
import type { Combatant, Damageable, Loadout, Team } from './types'
import { Hud } from './ui/hud'
import { Screens, type DeployChoice } from './ui/screens'
import { createFlags, type Flag } from './world/flags'
import { buildProps } from './world/props'
import type { WaterTower } from './world/tower'
import { World } from './world/world'
import { mulberry32 } from './util/noise'
import { pick } from './util/math'

type GameState = 'menu' | 'deploy' | 'playing' | 'dead' | 'ended'

const PLAYER_TEAM: Team = 'blue'
const PLAYER_NAME = 'Rookie'

function buildSky(): THREE.Mesh {
  const geo = new THREE.SphereGeometry(1200, 24, 12)
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      top: { value: new THREE.Color(0x3f7fd1) },
      horizon: { value: new THREE.Color(THEME.fog) },
      sunDir: { value: new THREE.Vector3(0.4, 0.5, 0.3).normalize() },
    },
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `uniform vec3 top; uniform vec3 horizon; uniform vec3 sunDir; varying vec3 vDir;
      void main(){
        float h = clamp(vDir.y, 0.0, 1.0);
        vec3 c = mix(horizon, top, pow(h, 0.55));
        float s = max(dot(normalize(vDir), sunDir), 0.0);
        c += vec3(1.0, 0.9, 0.7) * (pow(s, 600.0) * 1.2 + pow(s, 8.0) * 0.12);
        gl_FragColor = vec4(c, 1.0);
      }`,
  })
  const m = new THREE.Mesh(geo, mat)
  m.frustumCulled = false
  return m
}

/** Top-level orchestration: owns the renderer, the state machine and the loop. */
export class Game {
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly camera: THREE.PerspectiveCamera
  private readonly sun: THREE.DirectionalLight
  private readonly world: World
  private readonly effects = new Effects()
  private readonly projectiles = new Projectiles()
  private readonly audio = new AudioEngine()
  private readonly voice = new Voice()
  private readonly input: Input
  private readonly hud: Hud
  private readonly screens: Screens
  private readonly flags: Flag[]
  private readonly tower: WaterTower
  private readonly match: Match
  private readonly ctx: GameContext
  private readonly combatants: Combatant[] = []
  private readonly damageables: Damageable[] = []
  private readonly player: Player
  private readonly bots: Bot[] = []
  private readonly vehicles: Vehicle[] = []
  private state: GameState = 'menu'
  private stateTimer = 0
  private lastTime = performance.now()
  private time = 0
  private firstDeploy = true
  private lastLoadout: Loadout = { primary: 'chattergun', secondary: 'sidebar', grenade: 'hotTake' }
  private readonly tmp = new THREE.Vector3()
  private readonly tmp2 = new THREE.Vector3()

  constructor(root: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(window.innerWidth, window.innerHeight)
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFShadowMap
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.05
    this.renderer.domElement.className = 'game'
    root.appendChild(this.renderer.domElement)

    this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.05, 1500)
    this.scene.add(this.camera)
    this.scene.background = new THREE.Color(THEME.sky)
    this.scene.fog = new THREE.Fog(THEME.fog, MAP.fogNear, MAP.fogFar)
    this.scene.add(buildSky())

    const hemi = new THREE.HemisphereLight(THEME.ambientSky, THEME.ambientGround, 0.75)
    this.scene.add(hemi)
    this.sun = new THREE.DirectionalLight(THEME.sun, 2.4)
    this.sun.position.set(80, 120, 60)
    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(2048, 2048)
    this.sun.shadow.camera.near = 10
    this.sun.shadow.camera.far = 400
    this.sun.shadow.camera.left = -70
    this.sun.shadow.camera.right = 70
    this.sun.shadow.camera.top = 70
    this.sun.shadow.camera.bottom = -70
    this.sun.shadow.bias = -0.0008
    this.sun.shadow.normalBias = 0.05
    this.scene.add(this.sun, this.sun.target)

    this.world = new World(this.scene)
    this.scene.add(this.effects.group, this.projectiles.group)
    this.flags = createFlags(this.world)
    const props = buildProps(this.world)
    this.tower = props.levolution

    this.input = new Input(this.renderer.domElement)
    this.hud = new Hud(root)
    this.hud.setVisible(false)
    this.screens = new Screens(root)
    this.match = new Match(this.flags, this.hud, this.audio, this.voice, this.effects)

    const game = this
    this.ctx = {
      world: this.world,
      effects: this.effects,
      projectiles: this.projectiles,
      audio: this.audio,
      events: this.match,
      combatants: this.combatants,
      damageables: this.damageables,
      get time(): number {
        return game.time
      },
    }
    this.projectiles.bind(this.ctx)

    this.player = new Player(this.ctx, PLAYER_TEAM, 'yapper', PLAYER_NAME, this.camera)
    this.player.setLoadout(this.lastLoadout)
    this.combatants.push(this.player)
    this.spawnBots()
    this.match.bind(this.player, this.bots)

    for (const t of TEAMS) {
      const side = t.id === 'blue' ? 1 : -1
      this.vehicles.push(new Vehicle(this.ctx, t.id, t.hq.x + 12 * side, t.hq.z - 8 * side, t.id === 'blue' ? Math.PI * 0.75 : -Math.PI * 0.25))
    }
    this.damageables.push(...this.combatants, ...this.vehicles, this.tower)
    this.tower.onCollapse = () => this.onTowerCollapse()

    window.addEventListener('resize', () => this.onResize())
    this.renderer.domElement.addEventListener('click', () => {
      if (this.state === 'playing') this.input.requestLock()
    })
  }

  private spawnBots(): void {
    const rng = mulberry32(42)
    const names = [...LINES.BOT_NAMES].sort(() => rng() - 0.5)
    let n = 0
    for (const t of TEAMS) {
      for (let i = 0; i < MATCH.botsPerTeam; i++) {
        const cls = CLASSES[i % CLASSES.length]
        const name = names[n++ % names.length] ?? `Bot ${n}`
        const bot = new Bot(this.ctx, t.id, cls?.id ?? 'yapper', name, {
          flags: this.flags,
          playerPosition: () => (this.player.alive || this.state === 'dead' ? this.player.position : null),
        })
        this.bots.push(bot)
        this.combatants.push(bot)
      }
    }
    // Stagger initial arrivals so both teams roll out of their HQs in waves.
    this.bots.forEach((b, i) => {
      b.respawnTimer = -(i % MATCH.botsPerTeam) * 0.4
    })
  }

  private onTowerCollapse(): void {
    const pos = this.tower.position.clone()
    pos.y += 6
    this.projectiles.explode(pos, LEVOLUTION.radius, LEVOLUTION.damage, null, 'The Water Tower')
    this.audio.play('collapse', { position: this.tower.position })
    this.effects.shake = Math.max(this.effects.shake, 1.5)
    this.hud.showToast('PRATTLEVOLUTION', 'The water tower has entered the conversation. Horizontally.', 'tower', 4)
    const speaker = this.bots.find((b) => b.alive && b.position.distanceTo(this.player.position) < 60) ?? this.bots[0]
    speaker?.say(pick(LINES.TOWER_DOWN))
  }

  private onResize(): void {
    this.camera.aspect = window.innerWidth / window.innerHeight
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(window.innerWidth, window.innerHeight)
  }

  start(): void {
    this.setState('menu')
    this.screens.showMenu(() => {
      this.audio.resume()
      this.audio.play('stinger')
      this.audio.play('uiClick')
      this.openDeploy()
    })
    // A slow cinematic orbit behind the menu so the world is visible immediately.
    this.camera.position.set(-60, 40, 80)
    requestAnimationFrame(() => this.loop())
  }

  private setState(s: GameState): void {
    this.state = s
    this.stateTimer = 0
  }

  private openDeploy(): void {
    this.setState('deploy')
    this.input.releaseLock()
    this.hud.setVisible(false)
    this.screens.fade(false)
    this.screens.showDeploy(
      {
        flags: this.flags,
        team: PLAYER_TEAM,
        tickets: this.match.tickets,
        initialLoadout: this.lastLoadout,
        deathNote: this.match.lastDeath,
        firstTime: this.firstDeploy,
      },
      (choice) => this.deploy(choice),
    )
  }

  private deploy(choice: DeployChoice): void {
    const first = this.firstDeploy
    this.firstDeploy = false
    this.match.lastDeath = null
    const l = this.lastLoadout
    if (l.primary !== choice.loadout.primary || l.secondary !== choice.loadout.secondary || l.grenade !== choice.loadout.grenade) {
      this.player.setLoadout(choice.loadout)
    }
    this.lastLoadout = choice.loadout
    this.player.spawnAt(choice.x, choice.z, choice.yaw)
    this.screens.hide()
    this.hud.setVisible(true)
    this.audio.play('deploy')
    this.setState('playing')
    this.input.requestLock()
    if (first) this.hud.showToast('MOUSE CAPTURED', 'Press Esc to release it, click the game to grab it again', 'mouse-hint', 6)
  }

  private endRound(winner: Team): void {
    this.setState('ended')
    this.input.releaseLock()
    this.hud.setVisible(false)
    this.screens.fade(false)
    this.audio.play(winner === PLAYER_TEAM ? 'victory' : 'defeat')
    this.audio.engine.stop()
    this.screens.showEnd(
      { winner, team: PLAYER_TEAM, tickets: this.match.tickets, player: this.player, combatants: this.combatants },
      () => window.location.reload(),
    )
  }

  private handleVehicleToggle(): void {
    const p = this.player
    if (!p.wantsVehicleToggle) return
    p.wantsVehicleToggle = false
    if (p.vehicle) {
      p.vehicle.exit()
      return
    }
    const v = this.vehicles.find((veh) => veh.canEnter(p))
    if (v) {
      v.enter(p)
      if (Math.random() < 0.5) p.say(pick(LINES.VEHICLE))
    }
  }

  private updatePlaying(dt: number): void {
    const p = this.player
    p.control(dt, this.input)
    if (p.wantsPrattle) {
      p.wantsPrattle = false
      p.say(pick(LINES.IDLE))
    }
    this.handleVehicleToggle()

    for (const v of this.vehicles) {
      const driving = v.driver === p
      v.update(
        dt,
        driving
          ? {
              throttle: (this.input.isDown('KeyW') ? 1 : 0) - (this.input.isDown('KeyS') ? 1 : 0),
              steer: (this.input.isDown('KeyD') ? 1 : 0) - (this.input.isDown('KeyA') ? 1 : 0),
              brake: this.input.isDown('Space'),
              horn: this.input.wasPressed('KeyH'),
            }
          : null,
      )
    }
    if (!p.alive) {
      this.setState('dead')
      this.audio.engine.stop()
    }
  }

  private updateDead(dt: number): void {
    // Death cam: slow orbit around the body, then back to deploy.
    const p = this.player
    const a = this.stateTimer * 0.5
    const r = 5
    this.tmp.set(p.position.x + Math.sin(a) * r, p.position.y + 2.5, p.position.z + Math.cos(a) * r)
    const ground = this.world.heightAt(this.tmp.x, this.tmp.z) + 0.8
    if (this.tmp.y < ground) this.tmp.y = ground
    this.camera.position.lerp(this.tmp, Math.min(1, dt * 3))
    this.tmp2.copy(p.position).setY(p.position.y + 0.6)
    this.camera.lookAt(this.tmp2)
    if (this.stateTimer > MATCH.respawnDelay - 0.8) this.screens.fade(true)
    if (this.stateTimer > MATCH.respawnDelay) this.openDeploy()
  }

  private updateMenuCamera(dt: number): void {
    const a = this.time * 0.05
    const c = this.flags[2]?.position ?? new THREE.Vector3()
    this.tmp.set(c.x + Math.sin(a) * 90, c.y + 28, c.z + Math.cos(a) * 90)
    this.camera.position.lerp(this.tmp, Math.min(1, dt * 2))
    this.camera.lookAt(c.x, c.y + 4, c.z)
  }

  private update(dt: number): void {
    this.time += dt
    if (this.state === 'menu' || this.state === 'deploy' || this.state === 'ended') {
      this.updateMenuCamera(dt)
      this.player.viewmodel.visible = false
    } else if (this.state === 'playing') {
      this.updatePlaying(dt)
    } else if (this.state === 'dead') {
      this.updateDead(dt)
    }

    const simulate = this.state !== 'ended'
    if (simulate) {
      for (const b of this.bots) b.update(dt)
      for (const c of this.combatants) {
        const s = c as Soldier
        s.tick(dt)
        if (!s.alive && s.respawnTimer > MATCH.respawnDelay - 0.5 && s.mesh.group.visible && !s.isPlayer) s.hideBody()
      }
      if (this.state !== 'playing') for (const v of this.vehicles) v.update(dt, null)
      this.projectiles.update(dt)
      this.tower.update(dt)
      const winner = this.match.update(dt, this.combatants, this.state !== 'menu')
      if (winner) {
        this.endRound(winner)
        return
      }
    }
    this.effects.update(dt)

    if (this.state === 'playing') {
      this.player.updateCamera(dt)
      const near = this.player.alive && !this.player.inVehicle ? this.vehicles.find((v) => v.canEnter(this.player)) : null
      this.hud.update(dt, {
        player: this.player,
        flags: this.flags,
        tickets: this.match.tickets,
        combatants: this.combatants,
        vehicles: this.vehicles,
        prompt: !this.input.locked ? { key: 'Click', text: 'to capture the mouse and resume. Esc releases it.' } : near ? { key: 'E', text: `Get in ${near.displayName}` } : null,
        showScoreboard: this.input.isDown('Tab'),
      })
    }

    this.camera.getWorldDirection(this.tmp)
    this.audio.setListener(this.camera.position, this.tmp)
    // Shadow frustum follows the camera so detail stays where the player looks.
    this.sun.target.position.copy(this.camera.position)
    this.sun.position.copy(this.camera.position).add(this.tmp2.set(80, 120, 60))
    this.input.endFrame()
  }

  /** Dev-only: advances the simulation without rendering so tests can fast-forward a match. */
  debugStep(seconds: number): void {
    const step = 1 / 60
    for (let t = 0; t < seconds; t += step) {
      this.stateTimer += step
      this.update(step)
    }
  }

  debugSnapshot(): { state: string; tickets: Record<Team, number>; flags: string[]; kills: number; alive: number } {
    return {
      state: this.state,
      tickets: { ...this.match.tickets },
      flags: this.flags.map((f) => `${f.def.letter}:${f.owner ?? '-'}:${f.progress.toFixed(2)}`),
      kills: this.combatants.reduce((n, c) => n + c.kills, 0),
      alive: this.combatants.filter((c) => c.alive).length,
    }
  }

  private loop(): void {
    requestAnimationFrame(() => this.loop())
    const now = performance.now()
    const dt = Math.min(0.05, (now - this.lastTime) / 1000)
    this.lastTime = now
    this.stateTimer += dt
    this.update(dt)
    this.renderer.render(this.scene, this.camera)
  }
}
