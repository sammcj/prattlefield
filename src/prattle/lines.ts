import * as SMALL from './smallTalk'
import * as WAR from './warMovie'
import { pick } from '../util/math'

export const BOT_NAMES: readonly string[] = [
  'Dazza',
  'Shazza',
  'Gaz',
  'Bazza',
  'Nozza',
  'Wozza',
  'Kez',
  'Tezza',
  'Muzza',
  'Jezza',
  'Lozza',
  'Robbo',
  'Thommo',
  'Smithy',
  'Johnno',
  'Macca',
  'Davo',
  'Steve-o',
  'Jonesy',
  'Bevan',
  'Trent',
  'Narelle',
  'Cheryl',
  'Sharon',
  'Big Kev',
  'Little Kev',
  'Uncle Terry',
  'Aunty Val',
  'Mad Dog',
  'Sensible Greg',
]

export const IDLE: readonly string[] = [
  'Anyway, as I was saying...',
  'Did I tell you about my knee?',
  "I'm not saying it's aliens. I'm saying it's probably aliens.",
  'Reckon it might rain later.',
  'Has anyone seen my keys? Not urgent. Well. A bit urgent.',
  "I've got a podcast about this, actually.",
  'Long story short. Actually, long story long.',
  'So my sister-in-law, right...',
  'Just going to put this out there.',
  "I'm only asking questions.",
  'Not to be that guy, but.',
  'This reminds me of a thing.',
  'Does anyone else find war a bit loud?',
  'I had a dream about a sandwich.',
  'Objective Bravo. Bravo. Like the TV channel.',
  'Do you reckon the enemy has snacks?',
  "Sorry, what was the plan again? I wasn't listening.",
  "I'll be honest, I'm mostly here for the sausage sizzle.",
  'My therapist says I should communicate more.',
  "Quick question: are we the baddies? No? Cool. Cool cool cool.",
  'I once met a bloke who knew a bloke.',
  "Is this mic on? It's not a mic. Okay.",
  'Just circling back on that thing from before.',
  'Per my last transmission...',
  'I could go a pie right now.',
  "I'm on the fence about fences.",
  'Would it kill them to put in a footpath?',
  "The servo's got new pies. Just saying.",
  'Right. Where was I.',
  "I've got a strong opinion about roundabouts.",
  ...SMALL.IDLE,
  ...WAR.IDLE,
]

export const SPOTTED: readonly string[] = [
  'Enemy spotted! Probably. Or a bush.',
  "Contact! Wait. No. It's a bin.",
  'I see one! I think. My eyes are bad.',
  "There's a bloke over there and he looks cranky.",
  'Enemy at... some o\'clock.',
  'Someone coming. Could be a mate. Could be not a mate.',
  'Bogey, twelve o\'clock! Which is lunch time, coincidentally.',
  "He's got a gun! We've all got guns. Never mind.",
  'Look, over there! Not there. There.',
  'Movement! Might be the wind. Might be Dave.',
  ...SMALL.SPOTTED,
  ...WAR.SPOTTED,
]

export const FIRING: readonly string[] = [
  'Take that! And that! And this, which is a follow-up point!',
  'I just want to say I disagree!',
  'Here comes my rebuttal!',
  'Let me finish!',
  'AS I WAS SAYING!',
  "I'm not yelling, this is my normal voice!",
  'Actually! Actually! Actually!',
  'Consider this a strongly worded letter!',
  'Suppressing! Also complaining!',
  'Cop that! And some feedback!',
  ...SMALL.FIRING,
  ...WAR.FIRING,
]

export const KILLED_SOMEONE: readonly string[] = [
  'Got him. Anyway, back to my story.',
  'Well that ended the conversation.',
  'And that is my final point.',
  'He got interrupted. Permanently.',
  'Sorry mate. Agree to disagree.',
  'I win the argument.',
  'Sent him to voicemail.',
  'Muted.',
  "That's on you, champ.",
  'Nailed it. Absolutely nailed it. Did anyone see that?',
  ...SMALL.KILLED_SOMEONE,
  ...WAR.KILLED_SOMEONE,
]

export const DIED: readonly string[] = [
  'Tell my wife I never stopped talking.',
  'I had more to say!',
  "Ow. Rude.",
  'Unsubscribe.',
  "That's it, I'm leaving the group chat.",
  'I was mid sentence!',
  'Classic.',
  'This never happened in the tutorial.',
  "Great, now I've got to walk all the way back.",
  'Medic! ... Never mind. Dead.',
  ...SMALL.DIED,
  ...WAR.DIED,
]

export const CAPTURING: readonly string[] = [
  "We've got the flag! I've got opinions!",
  'Taking the objective. Nobody panic. Well, a bit.',
  "This is our spot now. We've decided.",
  'Capturing! Someone put the kettle on.',
  "Just standing here till the bar fills. Like a bus stop but with more shooting.",
  'Planting our flag and also our feet.',
  "It's ours! We've claimed it! Legally I don't know how this works.",
  "Holding the point. Also holding a grudge.",
  ...SMALL.CAPTURING,
  ...WAR.CAPTURING,
]

export const LOST_FLAG: readonly string[] = [
  "They took the flag! Bit rude, honestly.",
  'We lost the point. Whose fault was that? Rhetorical.',
  "We'll get it back. Or we won't. Life's like that.",
  'Objective lost! Someone write that down.',
  "They've taken the Servo. The pies, lads. THE PIES.",
  "Lost it. Classic us.",
  ...SMALL.LOST_FLAG,
  ...WAR.LOST_FLAG,
]

export const NEED_AMMO: readonly string[] = [
  'Need ammo! Also a hug!',
  "Running low. On bullets and patience.",
  'Anyone got a spare mag? Or a pen? Anything.',
  "I'm out! Of ammo, and of ideas.",
  ...SMALL.NEED_AMMO,
  ...WAR.NEED_AMMO,
]

export const RELOADING: readonly string[] = [
  'Reloading! Give me a sec!',
  'Hang on, changing mags. And subjects.',
  'Reloading, hold that thought.',
  "Just a mo, I've got to reload and also I've lost my train of thought.",
  ...SMALL.RELOADING,
  ...WAR.RELOADING,
]

export const VEHICLE: readonly string[] = [
  "Get in, I'm driving! I've had my licence for weeks!",
  'The Ute! The mighty Ute!',
  'Do you reckon this thing has cup holders?',
  "I'll drive. I'm the best driver here. Nobody else is here.",
  'Vroom. That is a technical term.',
  ...SMALL.VEHICLE,
  ...WAR.VEHICLE,
]

export const ROADKILL: readonly string[] = [
  'Sorry! Sorry! Sorry! Not sorry!',
  'He walked into me!',
  'Did I hit something? I hit something.',
  "Speed bump. Chatty speed bump.",
  ...SMALL.ROADKILL,
  ...WAR.ROADKILL,
]

export const HEADSHOT: readonly string[] = [
  'Right in the opinion!',
  'Head shot! Where the ideas live!',
  "That'll interrupt his train of thought.",
  'Straight to the noggin.',
  ...SMALL.HEADSHOT,
  ...WAR.HEADSHOT,
]

export const TOWER_DOWN: readonly string[] = [
  'THE WATER TOWER! MY BEAUTIFUL WATER TOWER!',
  'Prattlevolution!',
  "Well that's the water bill sorted.",
  'Did everyone see that? Everyone saw that.',
  'Structural integrity: opinion-based.',
]

export const FALL: readonly string[] = ['gravity', 'a poorly judged step', 'the ground', 'a strongly worded cliff', 'the creek', 'a swim they did not plan']

export const KILL_VERBS: readonly string[] = [
  'interrupted',
  'talked over',
  'muted',
  'fact-checked',
  'out-yapped',
  'sent to voicemail',
  'shushed',
  'corrected',
  'ratioed',
  'unfriended',
  'cut off mid sentence',
  'told a long story to',
]

export const EXPLOSION_VERBS: readonly string[] = [
  'blew up the group chat with',
  'dropped a hot take on',
  'went off at',
  'made an explosive point to',
]

export const DEATH_CAM_CAPTIONS: readonly string[] = [
  'You were interrupted.',
  'You lost the argument.',
  'You have been talked over.',
  'Your point was not taken.',
  'Someone has muted you.',
  'You were mid sentence. Rude.',
  'Consider yourself corrected.',
  ...SMALL.DEATH_CAM_CAPTIONS,
  ...WAR.DEATH_CAM_CAPTIONS,
]

export const LOADING_TIPS: readonly string[] = [
  'Tip: The enemy can hear you. They just choose not to listen.',
  'Tip: Bunnings runs the sausage sizzle every weekend. Also during wars.',
  'Tip: Attention Span drains faster when you hold fewer flags. Like a real conversation.',
  'Tip: The Point-Maker Rifle is extremely accurate and extremely slow. Like an academic.',
  'Tip: Press Q to say something. Nobody will listen, but it feels good.',
  'Tip: The water tower can be shot down. This is called Prattlevolution.',
  'Tip: Bus 404 is not coming. It was never coming.',
  'Tip: The Ute has no seatbelts. Or brakes, really.',
  'Tip: Headshots hurt more because that is where the opinions are kept.',
  'Tip: Crouching makes you harder to hit and easier to ignore.',
  ...SMALL.LOADING_TIPS,
  ...WAR.LOADING_TIPS,
]

export function randomLine(list: readonly string[]): string {
  return pick(list)
}

/** Shouted by a bot that a teammate just hit. */
export const FRIENDLY_HIT: readonly string[] = [
  'Same team! Same team!',
  'Ow. We are on the same side, mate.',
  'Check your target, genius.',
  'I am wearing the same colour as you.',
  'Are you doing this on purpose?',
  'Point that somewhere useful.',
  'Friendly! Friendly! Very unfriendly!',
  'I will remember this at the debrief.',
]

/** Last words of a bot killed by their own side. */
export const TEAMKILLED: readonly string[] = [
  'Tell my squad... they did this.',
  'Not even the enemy managed that.',
  'This is going in my review.',
  'I trusted you. Briefly.',
  'Whose side are you on?',
  'Well. That was a team effort.',
]

/** Escalating awards for the player's team kills, indexed by running count. */
export const TEAMKILL_AWARDS: ReadonlyArray<readonly [string, string]> = [
  ['TEAM PLAYER', 'Friendly fire. That one was on your side.'],
  ['CONSTRUCTIVE FEEDBACK', 'Two of ours. They were listening, too.'],
  ['HR WOULD LIKE A WORD', 'Hat trick of shame. The squad has started a group chat without you.'],
  ['DOUBLE AGENT', 'Four team kills. The enemy sends their thanks.'],
  ['ENQUIRY PENDING', 'Five. There will be a tribunal. It will be verbal.'],
  ['CAREER CHANGE', 'Have you considered joining the other team? They have.'],
]

export function teamKillAward(count: number): readonly [string, string] {
  const i = Math.max(0, Math.min(count, TEAMKILL_AWARDS.length) - 1)
  return TEAMKILL_AWARDS[i] ?? ['TEAM PLAYER', 'Friendly fire.']
}

export const STUNNED: readonly string[] = [
  'Sorry, what were we talking about?',
  'Everything has gone quiet and I hate it.',
  'Is this what listening feels like?',
  ...SMALL.STUNNED,
  ...WAR.STUNNED,
]

export const GRENADE_THROWN: readonly string[] = [
  'Here is a thought.',
  'Catch this one.',
  'You are going to want to sit down for this.',
  ...SMALL.GRENADE_THROWN,
  ...WAR.GRENADE_THROWN,
]
