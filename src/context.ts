import type * as THREE from 'three'
import type { World } from './world/world'
import type { Effects } from './combat/effects'
import type { Projectiles } from './combat/projectiles'
import type { AudioEngine } from './audio/synth'
import type { Combatant, Damageable, KillEvent, PrattleEvent, Team } from './types'

export interface SpawnPoint {
  readonly x: number
  readonly z: number
  readonly yaw: number
}

export interface GameEvents {
  /** Picks a spawn location for a team from owned flags and the HQ. */
  spawnPointFor(team: Team): SpawnPoint
  onKill(ev: KillEvent): void
  onScore(who: Combatant, amount: number, label: string): void
  onPrattle(ev: PrattleEvent): void
  onExplosion(position: THREE.Vector3, radius: number): void
}

/** Services every entity needs. Built once by Game and passed down. */
export interface GameContext {
  readonly world: World
  readonly effects: Effects
  readonly projectiles: Projectiles
  readonly audio: AudioEngine
  readonly events: GameEvents
  readonly combatants: readonly Combatant[]
  /** Everything splash damage can hurt: soldiers, vehicles, the water tower. */
  readonly damageables: readonly Damageable[]
  readonly time: number
}
