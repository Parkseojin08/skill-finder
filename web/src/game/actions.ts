// The one entry point the browser and the game server share: actions in, next state out.
// applyActions is deterministic: the same state, actions, time and time zone always give the same result.

import type { Rarity } from './data.ts';
import { GameError, newGame, settle, type Ctx, type Dir, type GameState } from './core.ts';
import { makeRng, seedState } from './rng.ts';
import { closeCombat, combatAction, type Weapon } from './combat.ts';
import { enterDungeon, giverAnswer, leaveDungeon, move, syncAbandon, syncRetry, syncSubmit } from './dungeon.ts';
import {
  closeModal, craft, ensureMarket, ensureSmith, equip, forgeKey, iceGuess, iceStart, jobClaim, jobStart, marketBuy,
  modInstall, modRemove, overclock, pharmBuy, pharmParts, print, questClaim, raidStart, scrap, sell, setHotbar,
  smithAmmo, smithBuy, smithRefresh, streetEnter, streetFight, streetLeave, unequip, type Recipe,
} from './town.ts';

export type Action =
  | { t: 'move'; dir: Dir }
  | { t: 'attack'; w: Weapon }
  | { t: 'useItem'; slot: number }
  | { t: 'escape' }
  | { t: 'combat.close' }
  | { t: 'dungeon.enter'; station: number; dungeon: number; challenge: boolean }
  | { t: 'dungeon.leave' }
  | { t: 'sync.submit'; inputs: Dir[] }
  | { t: 'sync.retry' }
  | { t: 'sync.abandon' }
  | { t: 'giver'; accept: boolean }
  | { t: 'modal.close' }
  | { t: 'street.enter'; station: number; area: number }
  | { t: 'street.fight'; idx: number }
  | { t: 'street.leave' }
  | { t: 'equip'; id: string }
  | { t: 'unequip'; id: string }
  | { t: 'sell'; id: string }
  | { t: 'scrap'; id: string }
  | { t: 'mod.install'; mod: string; gear: string }
  | { t: 'mod.remove'; mod: string }
  | { t: 'hotbar'; slot: number; tier: number | null }
  | { t: 'print'; kind: 'weapon' | 'armor'; rarity: Rarity }
  | { t: 'craft'; recipe: Recipe; tier: number }
  | { t: 'smith.buy'; id: string }
  | { t: 'smith.refresh' }
  | { t: 'smith.ammo'; kind: 'cells' | 'antimatter' }
  | { t: 'pharm.buy'; tier: number; n: number }
  | { t: 'pharm.parts'; code: 'med' | 'ammoparts' }
  | { t: 'market.buy'; id: string }
  | { t: 'key.forge'; station: number }
  | { t: 'ice.start' }
  | { t: 'ice.guess'; g: number[] }
  | { t: 'job.start'; id: string; minutes: number }
  | { t: 'job.claim' }
  | { t: 'quest.claim'; id: number }
  | { t: 'overclock' }
  | { t: 'raid.start'; crew: number }
  | { t: 'sync' }; // no-op: just applies the passage of time (opening a shop, checking timers)

export interface Clock { now: number; utcOffsetMin: number }

function apply(s: GameState, a: Action, ctx: Ctx) {
  const flatlined = !!s.flatlineUntil && ctx.now < s.flatlineUntil;
  if (flatlined && !['combat.close', 'modal.close', 'sync', 'hotbar', 'equip', 'unequip', 'mod.install', 'mod.remove', 'quest.claim', 'job.claim', 'job.start'].includes(a.t)) {
    throw new GameError('플랫라인 중입니다. 잠시 기다리세요');
  }
  switch (a.t) {
    case 'move': return move(s, a.dir, ctx);
    case 'attack': case 'useItem': case 'escape': return combatAction(s, a, ctx);
    case 'combat.close': return closeCombat(s);
    case 'dungeon.enter': return enterDungeon(s, a.station, a.dungeon, a.challenge, ctx);
    case 'dungeon.leave': return leaveDungeon(s, ctx);
    case 'sync.submit': return syncSubmit(s, a.inputs, ctx);
    case 'sync.retry': return syncRetry(s, ctx);
    case 'sync.abandon': return syncAbandon(s, ctx);
    case 'giver': return giverAnswer(s, a.accept, ctx);
    case 'modal.close': return closeModal(s);
    case 'street.enter': return streetEnter(s, a.station, a.area, ctx);
    case 'street.fight': return streetFight(s, a.idx, ctx);
    case 'street.leave': return streetLeave(s);
    case 'equip': return equip(s, a.id);
    case 'unequip': return unequip(s, a.id);
    case 'sell': return sell(s, a.id, ctx);
    case 'scrap': return scrap(s, a.id, ctx);
    case 'mod.install': return modInstall(s, a.mod, a.gear);
    case 'mod.remove': return modRemove(s, a.mod);
    case 'hotbar': return setHotbar(s, a.slot, a.tier);
    case 'print': return print(s, a.kind, a.rarity, ctx);
    case 'craft': return craft(s, a.recipe, a.tier, ctx);
    case 'smith.buy': return smithBuy(s, a.id, ctx);
    case 'smith.refresh': return smithRefresh(s, ctx);
    case 'smith.ammo': return smithAmmo(s, a.kind, ctx);
    case 'pharm.buy': return pharmBuy(s, a.tier, a.n, ctx);
    case 'pharm.parts': return pharmParts(s, a.code, ctx);
    case 'market.buy': return marketBuy(s, a.id, ctx);
    case 'key.forge': return forgeKey(s, a.station, ctx);
    case 'ice.start': return iceStart(s, ctx);
    case 'ice.guess': return iceGuess(s, a.g, ctx);
    case 'job.start': return jobStart(s, a.id, a.minutes, ctx);
    case 'job.claim': return jobClaim(s, ctx);
    case 'quest.claim': return questClaim(s, a.id, ctx);
    case 'overclock': return overclock(s, ctx);
    case 'raid.start': return raidStart(s, a.crew, ctx);
    case 'sync': return;
    default: throw new GameError('알 수 없는 행동입니다');
  }
}

/**
 * Applies a batch atomically: if any action is refused, the whole batch is discarded and the GameError is thrown.
 * The input state is never modified.
 */
export function applyActions(state: GameState, actions: readonly Action[], clock: Clock): GameState {
  const s = structuredClone(state);
  const rng = makeRng(s.rng);
  const ctx: Ctx = { ...clock, rng };
  for (const a of actions) {
    settle(s, ctx);
    apply(s, a, ctx);
  }
  settle(s, ctx);
  ensureSmith(s, ctx);
  ensureMarket(s, ctx);
  for (const e of s.log) if (e.at === 0) e.at = clock.now;
  s.rng = rng.save();
  return s;
}

export function createGame(seed: number, clock: Clock): GameState {
  const rng = makeRng(seedState(seed));
  const s = newGame(rng, clock.now);
  const ctx: Ctx = { ...clock, rng };
  ensureSmith(s, ctx);
  ensureMarket(s, ctx);
  s.rng = rng.save();
  return s;
}

/** What the server sends to the browser: everything except the PRNG state, so future rolls stay unpredictable. */
export function publicState(s: GameState): GameState {
  return { ...s, rng: [] };
}
