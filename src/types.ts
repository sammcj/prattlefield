import type * as THREE from 'three'

export type Team = 'blue' | 'orange'

export type ClassId = 'yapper' | 'debater' | 'podcaster' | 'heckler' | 'lecturer' | 'mechanic'

export type WeaponKind = 'hitscan' | 'rocket'

export interface WeaponDef {
  readonly id: string
  readonly name: string
  readonly blurb: string
  readonly kind: WeaponKind
  readonly damage: number
  readonly headshotMultiplier: number
  readonly rpm: number
  readonly magSize: number
  readonly reserveMags: number
  readonly reloadTime: number
  /** Cone radius in radians for the first hip shot; bloom grows it under sustained fire. */
  readonly spread: number
  readonly adsSpread: number
  readonly bloomPerShot: number
  readonly bloomMax: number
  /** Vertical kick per shot in radians. Sideways kick is a fraction of this. */
  readonly recoil: number
  readonly recoilSide: number
  readonly range: number
  /** Damage is full up to falloffStart and reaches damage * minDamageMul at falloffEnd. */
  readonly falloffStart: number
  readonly falloffEnd: number
  readonly minDamageMul: number
  readonly moveSpeed: number
  readonly auto: boolean
  readonly pellets: number
  readonly adsFov: number
  readonly tracerColour: number
  readonly sound: 'rifle' | 'smg' | 'lmg' | 'shotgun' | 'sniper' | 'rocket' | 'pistol'
  /** Shown on the loadout screen as 0..1 bars. */
  readonly stats: { readonly damage: number; readonly rate: number; readonly range: number; readonly control: number }
}

export type GrenadeId = 'hotTake' | 'micDrop' | 'awkwardSilence'

export type GrenadeKind = 'frag' | 'impact' | 'stun'

export interface GrenadeDef {
  readonly id: GrenadeId
  readonly name: string
  readonly blurb: string
  readonly kind: GrenadeKind
  readonly count: number
  readonly fuse: number
  readonly throwSpeed: number
  readonly radius: number
  readonly damage: number
  readonly bounce: number
  readonly colour: number
}

export interface Loadout {
  readonly primary: string
  readonly secondary: string
  readonly grenade: GrenadeId
}

export interface ClassDef {
  readonly id: ClassId
  readonly name: string
  readonly blurb: string
  readonly loadout: Loadout
}

export interface FlagDef {
  readonly id: string
  readonly letter: string
  readonly name: string
  readonly x: number
  readonly z: number
  readonly radius: number
}

export interface TeamDef {
  readonly id: Team
  readonly name: string
  readonly shortName: string
  readonly colour: number
  readonly css: string
  readonly hq: { readonly x: number; readonly z: number }
}

export type DamageSource =
  | { readonly kind: 'weapon'; readonly weaponName: string; readonly headshot: boolean }
  | { readonly kind: 'explosion'; readonly weaponName: string }
  | { readonly kind: 'vehicle' }
  | { readonly kind: 'fall' }
  | { readonly kind: 'levolution' }

export interface Damageable {
  readonly team: Team | 'none'
  readonly displayName: string
  readonly alive: boolean
  readonly position: THREE.Vector3
  applyDamage(amount: number, attacker: Combatant | null, source: DamageSource): void
}

export interface Combatant extends Damageable {
  readonly team: Team
  readonly isPlayer: boolean
  readonly classId: ClassId
  /** Dazes the target: bots lose their aim, the player loses their screen. */
  stun(seconds: number): void
  kills: number
  deaths: number
  score: number
}

export interface HitResult {
  readonly point: THREE.Vector3
  readonly normal: THREE.Vector3
  readonly distance: number
  readonly target: Damageable | null
  readonly headshot: boolean
}

export interface KillEvent {
  readonly attacker: Combatant | null
  readonly victim: Combatant
  readonly source: DamageSource
}

export interface PrattleEvent {
  readonly speaker: string
  readonly team: Team
  readonly text: string
  readonly position: THREE.Vector3 | null
}

export type SoundName =
  | 'smg'
  | 'lmg'
  | 'shotgun'
  | 'stun'
  | 'sniper'
  | 'rocket'
  | 'pistol'
  | 'rifle'
  | 'reload'
  | 'inhaler'
  | 'dryfire'
  | 'hit'
  | 'headshot'
  | 'explosion'
  | 'grenadeBounce'
  | 'pin'
  | 'footstep'
  | 'jump'
  | 'land'
  | 'capture'
  | 'lost'
  | 'flagTick'
  | 'killConfirm'
  | 'death'
  | 'ricochet'
  | 'impact'
  | 'enterVehicle'
  | 'horn'
  | 'crash'
  | 'collapse'
  | 'stinger'
  | 'victory'
  | 'defeat'
  | 'uiClick'
  | 'uiHover'
  | 'deploy'
