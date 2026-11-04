// ARASAKA_IN rules shared by the browser and the game server. No Date.now, Math.random or browser APIs here:
// time comes from Ctx.now and randomness from Ctx.rng (seeded from GameState.rng).

import {
  BUFFS, HEALS, MAX_LEVEL, MOD_SLOTS, MODULE_NAMES, PCT_STATS, PREFIX, RARITIES, RARITY_MULT, SLOT_BASES, STAT_CAP,
  STATIONS, WEAPON_SLOTS,
  type ModKey, type Rarity, type Slot, type StatKey,
} from './data.ts';
import type { Rng } from './rng.ts';

export class GameError extends Error {}
export function fail(message: string): never {
  throw new GameError(message);
}

export interface Ctx { now: number; utcOffsetMin: number; rng: Rng }

// ───────────── state ─────────────

export type SkillKey = 'printing' | 'medical' | 'ammo';
export interface Skill { lv: number; xp: number }

export interface Item {
  id: string;
  kind: 'gear' | 'module';
  slot?: Slot;          // gear
  stat?: StatKey;       // module
  rarity: Rarity;
  level: number;
  name: string;
  main: number;         // weapon damage, armor HP, or the module's value
  affixes: Partial<Record<StatKey, number>>;
  modSlots: number;
  equipped: boolean;
  installedIn?: string; // module fitted to this gear id
  source: string;
  at: number;
}

export interface Foe {
  name: string;
  level: number;
  rank: 'normal' | 'elite' | 'boss';
  hp: number;
  maxHp: number;
  shield: number;
  maxShield: number;
  atk: number;
  crit: number;
  critDmg: number;
  evade: number;
  defPct: number;
  mods: ModKey[];
  stunned?: boolean;
}

export interface Ally { name: string; hp: number; maxHp: number; atk: number }

export interface CombatEvent {
  text: string;
  target?: 'player' | 'foe' | number;
  dmg?: number;
  heal?: number;
  crit?: boolean;
  miss?: boolean;
  hp?: number;      // target's HP after this event
  shield?: number;  // target's shield after this event
}

export interface Combat {
  where: 'street' | 'dungeon' | 'raid';
  foe: Foe;
  entId?: string;
  streetIdx?: number;
  allies: Ally[];
  shield: number;
  maxShield: number;
  turn: number;
  events: CombatEvent[];
  result?: 'win' | 'lose' | 'fled';
  rewards: string[];
}

export type Dir = 'n' | 's' | 'e' | 'w';
export interface Ent {
  id: string;
  k: 'foe' | 'crate' | 'frag' | 'quest' | 'lore';
  x: number;
  y: number;
  foe?: Foe;
  lore?: number;
  offer?: GiverOffer; // quest giver's trade, fixed on first contact
  done?: boolean;
}
export interface GiverOffer { who: string; line: string; want: { code: string; n: number }; buff: string; minutes: number }
export interface Room {
  gx: number;
  gy: number;
  doors: Partial<Record<Dir, number>>;
  kind: 'start' | 'normal' | 'treasure';
  visited: boolean;
  walls: string[];
  ents: Ent[];
}
export interface Dungeon {
  station: number;
  idx: number;
  challenge: boolean;
  level: number;
  rooms: Room[];
  cur: number;
  x: number;
  y: number;
  startedAt: number;
  cleared: boolean;
  loot: { credits: number; xp: number; items: number };
}

export interface Street { station: number; area: number; foes: Foe[] }

export type Modal =
  | { kind: 'lore'; text: string }
  | ({ kind: 'giver'; entId: string } & GiverOffer)
  | { kind: 'sync'; entId: string; seq: Dir[]; startedAt: number; limitMs: number }
  | { kind: 'ice'; code: number[]; guesses: { g: number[]; exact: number; near: number }[]; max: number; done?: 'won' | 'lost' }
  | { kind: 'notice'; title: string; lines: string[] };

export type QuestKind = 'kill' | 'street' | 'dungeon' | 'print' | 'craft' | 'crate' | 'ice';
export interface Quest { id: number; kind: QuestKind; need: number; have: number; credits: number; xp: number }
export interface Buff { id: string; until: number }
export interface Job { id: string; startedAt: number; endsAt: number }

export type Offer =
  | { id: string; kind: 'gear'; item: Item; price: number; sold?: boolean }
  | { id: string; kind: 'stack'; code: string; n: number; label: string; price: number; sold?: boolean };
export interface Market { day: string; level: number; offers: Offer[] }
export interface Smith { hour: number; level: number; offers: Offer[] }

export interface Tally {
  kills: number; bossKills: number; deaths: number; dungeonClears: number; challengeClears: number;
  raidAttempts: number; raidWins: number; cratesOpened: number; itemsPrinted: number; iceCracked: number;
}
export interface DRecord { station: number; dungeon: number; challenge: boolean; clears: number; bestMs?: number; bestAt?: number; firstAt: number }

export interface LogEntry { at: number; text: string; tone: 'info' | 'good' | 'bad' | 'loot' }

export interface GameState {
  v: 2;
  rng: number[];
  createdAt: number;
  level: number;
  xp: number;
  totalXp: number;
  totalXpAt: number;
  credits: number;
  hp: number;
  hpAt: number;
  unlocked: number;
  bagCap: number;
  hotbar: (number | null)[];
  flatlineUntil?: number;
  overclockUntil?: number;
  raidDay?: string;
  skills: Record<SkillKey, Skill>;
  stats: Tally;
  items: Item[];
  stacks: Record<string, number>;
  records: DRecord[];
  loc: 'town' | 'street' | 'dungeon';
  dungeon?: Dungeon;
  combat?: Combat;
  street?: Street;
  modal?: Modal;
  quests: Quest[];
  questSeq: number;
  buffs: Buff[];
  job?: Job;
  market?: Market;
  smith?: Smith;
  iceUntil?: number;
  log: LogEntry[];
}

// ───────────── small helpers ─────────────

export const round = (n: number) => Math.round(n);
export const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
export const rarityIndex = (r: Rarity) => RARITIES.indexOf(r);

export function log(s: GameState, text: string, tone: LogEntry['tone'] = 'info', at = 0) {
  s.log.push({ at, text, tone });
  if (s.log.length > 80) s.log.splice(0, s.log.length - 80);
}

export const stack = (s: GameState, code: string) => s.stacks[code] ?? 0;
export function addStack(s: GameState, code: string, n: number) {
  const next = Math.min(10000, stack(s, code) + n);
  if (next < 0) fail('재료가 부족합니다');
  if (next === 0) delete s.stacks[code];
  else s.stacks[code] = next;
}
export function takeStack(s: GameState, code: string, n: number, label: string) {
  if (stack(s, code) < n) fail(`${label}이(가) 부족합니다 (${stack(s, code)}/${n})`);
  addStack(s, code, -n);
}
export function spend(s: GameState, credits: number) {
  if (s.credits < credits) fail(`크레딧이 부족합니다 (¥${s.credits} / ¥${credits})`);
  s.credits -= credits;
}

export const healCode = (tier: number) => `heal:${tier}`;
export const cacheCode = (kind: 'weapon' | 'armor', r: Rarity) => `cache:${kind}:${r}`;
export const fragCode = (station: number, idx: number) => `frag:${station}:${idx}`;

// ───────────── time ─────────────

const RESET_HOUR = 9;
/** The game day: it turns over at 09:00 in the player's time zone. */
export function businessDay(now: number, utcOffsetMin: number): string {
  return new Date(now + utcOffsetMin * 60_000 - RESET_HOUR * 3_600_000).toISOString().slice(0, 10);
}
/** Next 09:00 local after `now`. */
export function nextReset(now: number, utcOffsetMin: number): number {
  const local = now + utcOffsetMin * 60_000;
  const day = Math.floor((local - RESET_HOUR * 3_600_000) / 86_400_000) + 1;
  return day * 86_400_000 + RESET_HOUR * 3_600_000 - utcOffsetMin * 60_000;
}

// ───────────── levels and skills ─────────────

export const xpToNext = (level: number) => round(25 * level ** 1.55 + 25);
export const skillNeed = (lv: number) => 8 + 4 * lv;

export function gainXp(s: GameState, xp: number, now: number) {
  if (xp <= 0 || s.level >= MAX_LEVEL) return;
  s.xp += xp;
  s.totalXp += xp;
  s.totalXpAt = now;
  while (s.level < MAX_LEVEL && s.xp >= xpToNext(s.level)) {
    s.xp -= xpToNext(s.level);
    s.level++;
    s.hp = calc(s, now).maxHp;
    log(s, `레벨 업! Lv.${s.level}. 체력이 가득 찼다`, 'good', now);
  }
  if (s.level >= MAX_LEVEL) s.xp = 0;
}

export function gainSkill(s: GameState, key: SkillKey, xp: number, now: number) {
  const sk = s.skills[key];
  sk.xp += xp;
  while (sk.lv < 100 && sk.xp >= skillNeed(sk.lv)) {
    sk.xp -= skillNeed(sk.lv);
    sk.lv++;
    const label = key === 'printing' ? '인쇄' : key === 'medical' ? '의료' : '탄약';
    log(s, `${label} 숙련도 ${sk.lv}`, 'good', now);
  }
}

// ───────────── computed stats ─────────────

export interface PlayerStats {
  maxHp: number;
  maxShield: number;
  armor: number;
  crit: number;
  critDmg: number;
  evade: number;
  escape: number;
  stun: number;
  regen: number;
  dmgPct: number;
  defPct: number;
  dmg: Record<'primary' | 'special' | 'destructive', number>;
}

export const buffActive = (s: GameState, now: number) => s.buffs.filter((b) => b.until > now);

export function calc(s: GameState, now: number): PlayerStats {
  const sum: Record<StatKey, number> = { hp: 0, shield: 0, armor: 0, crit: 5, critDmg: 150, evade: 0, escape: 30, stun: 0, regen: 0, dmgPct: 0 };
  const weapon: Record<'primary' | 'special' | 'destructive', number> = { primary: 0, special: 0, destructive: 0 };
  for (const it of s.items) {
    if (it.kind !== 'gear' || !it.equipped || !it.slot) continue;
    if (WEAPON_SLOTS.includes(it.slot)) weapon[it.slot as 'primary'] = it.main;
    else sum.hp += it.main;
    for (const [k, v] of Object.entries(it.affixes)) sum[k as StatKey] += v ?? 0;
    for (const m of s.items) if (m.installedIn === it.id && m.stat) sum[m.stat] += m.main;
  }
  let shieldPct = 0;
  let defPct = 0;
  for (const b of buffActive(s, now)) {
    const def = BUFFS.find((x) => x.id === b.id);
    if (!def) continue;
    if (def.stat === 'dmg') sum.dmgPct += def.pct;
    else if (def.stat === 'def') defPct += def.pct;
    else shieldPct += def.pct;
  }
  if ((s.overclockUntil ?? 0) > now) sum.dmgPct += 20;
  for (const k of Object.keys(STAT_CAP) as StatKey[]) sum[k] = Math.min(sum[k], STAT_CAP[k] ?? Infinity);
  const mult = 1 + sum.dmgPct / 100;
  return {
    maxHp: round(60 + 10 * (s.level - 1) + sum.hp),
    maxShield: round(sum.shield * (1 + shieldPct / 100)),
    armor: round(sum.armor * 10) / 10,
    crit: sum.crit,
    critDmg: sum.critDmg,
    evade: sum.evade,
    escape: sum.escape,
    stun: sum.stun,
    regen: round(sum.regen),
    dmgPct: sum.dmgPct,
    defPct,
    dmg: {
      primary: round((weapon.primary || 2 + s.level) * mult),
      special: round(weapon.special * mult),
      destructive: round(weapon.destructive * mult),
    },
  };
}

// ───────────── gear ─────────────

export function rollRarity(r: Rng, level: number, bonus = 0, min: Rarity = 'trash'): Rarity {
  const score = r.next() ** (1 / (1 + bonus + level / 45));
  const cut = [0.5, 0.78, 0.92, 0.975, 0.995];
  let i = cut.findIndex((c) => score < c);
  if (i < 0) i = 5;
  return RARITIES[Math.max(i, rarityIndex(min))];
}

const WEAPON_AFFIX: StatKey[] = ['crit', 'critDmg', 'stun', 'dmgPct'];
const ARMOR_AFFIX: StatKey[] = ['crit', 'critDmg', 'evade', 'escape', 'regen', 'stun'];
const AFFIX_COUNT: Record<Rarity, [number, number]> = { trash: [0, 0], common: [0, 1], hq: [1, 1], rare: [2, 2], legendary: [2, 3], epic: [3, 3] };

function affixValue(r: Rng, stat: StatKey, level: number, rm: number): number {
  const x = r.between(0.6, 1);
  const v: Record<StatKey, number> = {
    crit: 1.5 + 2.5 * rm * x, critDmg: 6 + 12 * rm * x, evade: 1 + 2.5 * rm * x, escape: 2 + 5 * rm * x,
    stun: 1 + 2.5 * rm * x, regen: (0.5 + 0.25 * level) * rm * x, dmgPct: 2 + 4 * rm * x,
    hp: (4 + 3 * level) * rm * x, shield: (2 + 1.2 * level) * rm * x, armor: (0.2 + 0.1 * level) * rm * x,
  };
  return round(v[stat] * 10) / 10;
}

export function makeGear(r: Rng, slot: Slot, level: number, rarity: Rarity, source: string, at: number): Item {
  const rm = RARITY_MULT[rarity];
  const q = () => r.between(0.92, 1.08);
  const L = level;
  const affixes: Partial<Record<StatKey, number>> = {};
  let main: number;
  const wpn = (5 + 2.6 * L) * rm;
  switch (slot) {
    case 'primary': main = wpn * q(); break;
    case 'special': main = wpn * 1.6 * q(); break;
    case 'destructive': main = wpn * 2.4 * q(); break;
    case 'helmet': main = (8 + 5 * L) * rm * q(); affixes.shield = round((2 + 1.5 * L) * rm * q()); break;
    case 'upper': main = (14 + 9 * L) * rm * q(); affixes.shield = round((3 + 2 * L) * rm * q()); affixes.armor = round((0.4 + 0.28 * L) * rm * q() * 10) / 10; break;
    case 'lower': main = (12 + 8 * L) * rm * q(); affixes.armor = round((0.3 + 0.22 * L) * rm * q() * 10) / 10; break;
    case 'boots': main = (6 + 4 * L) * rm * q(); affixes.escape = round((3 + 0.1 * L) * rm * q() * 10) / 10; break;
  }
  const pool = WEAPON_SLOTS.includes(slot) ? WEAPON_AFFIX : ARMOR_AFFIX;
  const [lo, hi] = AFFIX_COUNT[rarity];
  const n = r.int(lo, hi);
  for (let i = 0; i < n; i++) {
    const stat = r.pick(pool);
    affixes[stat] = round(((affixes[stat] ?? 0) + affixValue(r, stat, L, rm)) * 10) / 10;
  }
  const [mlo, mhi] = MOD_SLOTS[rarity];
  return {
    id: r.uuid(), kind: 'gear', slot, rarity, level, name: `${r.pick(PREFIX[rarity])} ${r.pick(SLOT_BASES[slot])}`,
    main: round(main), affixes, modSlots: r.int(mlo, mhi), equipped: false, source, at,
  };
}

const MODULE_STATS: StatKey[] = ['hp', 'shield', 'armor', 'crit', 'critDmg', 'evade', 'escape', 'stun', 'regen', 'dmgPct'];
export function makeModule(r: Rng, level: number, rarity: Rarity, source: string, at: number): Item {
  const stat = r.pick(MODULE_STATS);
  return {
    id: r.uuid(), kind: 'module', stat, rarity, level, name: MODULE_NAMES[stat],
    main: affixValue(r, stat, level, RARITY_MULT[rarity] * 1.2), affixes: {}, modSlots: 0, equipped: false, source, at,
  };
}

export const SELL_MULT: Record<Rarity, number> = { trash: 0.6, common: 1, hq: 1.8, rare: 3.5, legendary: 7, epic: 14 };
export const sellPrice = (it: Item) => round((4 + 2.2 * it.level) * SELL_MULT[it.rarity] * (it.kind === 'module' ? 0.8 : 1));

/** Items that take a bag slot: not worn, not fitted into gear. */
export const bagCount = (s: GameState) => s.items.filter((i) => !i.equipped && !i.installedIn).length;

/** Adds an item, or turns it into scrap when the bag is full. */
export function giveItem(s: GameState, it: Item, now: number): string {
  if (bagCount(s) >= s.bagCap) {
    const scrap = 1 + rarityIndex(it.rarity) * 2;
    addStack(s, 'scrap', scrap);
    log(s, `가방이 가득 차서 ${it.name}을(를) 고철 ${scrap}개로 바꿨다`, 'bad', now);
    return `고철 ${scrap} (가방 가득)`;
  }
  s.items.push(it);
  return it.name;
}

// ───────────── enemies ─────────────

/** Gear grade a player usually has at this level (trash/common early → legendary late); enemies keep pace with it. */
const gradeCurve = (level: number) => 0.8 + 0.011 * level;
export const foeHp = (level: number) => (12 + 9 * level) * gradeCurve(level);
export const foeAtk = (level: number) => (6 + 4.3 * level) * gradeCurve(level);

export function makeFoe(r: Rng, station: number, level: number, rank: Foe['rank'], modChance: number): Foe {
  const st = STATIONS[station];
  let hp = foeHp(level) * r.between(0.9, 1.1);
  let atk = foeAtk(level);
  let shield = 0;
  let crit = 5;
  let critDmg = 150;
  let evade = 0;
  let defPct = 0;
  let name = r.pick(st.enemies);
  if (rank === 'elite') { hp *= 2.2; atk *= 1.15; name = `정예 ${name}`; }
  if (rank === 'boss') { hp *= 5; atk *= 1.35; name = r.pick(st.bosses); }
  const mods: ModKey[] = [];
  const nMods = rank === 'boss' ? 1 + (r.chance(0.5) ? 1 : 0) : r.chance(modChance) ? 1 : 0;
  const all: ModKey[] = ['frenzied', 'plated', 'warded', 'twitchy', 'deadeye', 'hulking'];
  while (mods.length < nMods) {
    const m = r.pick(all);
    if (!mods.includes(m)) mods.push(m);
  }
  for (const m of mods) {
    if (m === 'frenzied') atk *= 1.25;
    if (m === 'plated') defPct += 20;
    if (m === 'warded') { hp *= 0.85; shield += hp * 1.5; }
    if (m === 'twitchy') { evade += 15; shield += hp * 0.4; }
    if (m === 'deadeye') { crit += 15; critDmg += 50; }
    if (m === 'hulking') { hp *= 1.8; atk *= 1.2; }
  }
  return {
    name, level, rank, hp: round(hp), maxHp: round(hp), shield: round(shield), maxShield: round(shield),
    atk: round(atk * 10) / 10, crit, critDmg, evade, defPct, mods,
  };
}

// ───────────── rewards ─────────────

export function foeXp(f: Foe, playerLevel: number): number {
  const mult = (f.rank === 'boss' ? 8 : f.rank === 'elite' ? 3 : 1) * (1 + 0.25 * f.mods.length);
  let xp = (5 + 3.2 * f.level ** 1.12) * mult;
  const gap = playerLevel - f.level;
  if (gap > 6) xp *= Math.max(0.1, 1 - (gap - 6) * 0.15);
  return round(xp);
}

/** Credits, ammo and materials for a defeated enemy (or a crate). Returns what was given, for the result screen. */
export function dropLoot(s: GameState, r: Rng, level: number, rank: Foe['rank'], where: 'street' | 'dungeon' | 'crate', challenge: boolean, now: number): string[] {
  const got: string[] = [];
  const add = (code: string, n: number, label: string) => {
    if (n <= 0) return;
    addStack(s, code, n);
    got.push(`${label} ×${n}`);
  };
  const mult = rank === 'boss' ? 6 : rank === 'elite' ? 2.5 : where === 'crate' ? 1.6 : 1;
  const credits = round((3 + 1.8 * level) * r.between(0.8, 1.2) * mult);
  s.credits += credits;
  got.unshift(`¥${credits}`);
  if (r.chance(where === 'crate' ? 0.6 : 0.35)) add('cells', r.int(1, 3) + Math.floor(level / 10), '에너지 탄약');
  if (r.chance(where === 'crate' ? 0.3 : 0.12)) add('antimatter', 1 + Math.floor(level / 20), '반물질');
  if (r.chance(0.22)) add('med', r.int(1, 2), '의료 부품');
  if (r.chance(0.22)) add('ammoparts', r.int(1, 2), '탄약 부품');
  if (r.chance(0.25)) add('scrap', r.int(1, 2), '고철');
  const cacheChance = rank === 'boss' ? 1 : rank === 'elite' ? 0.6 : where === 'crate' ? 0.45 : where === 'dungeon' ? 0.09 : 0.05;
  const bonus = (rank === 'boss' ? 0.8 : rank === 'elite' ? 0.4 : where === 'crate' ? 0.3 : 0) + (challenge ? 0.3 : 0);
  if (r.chance(cacheChance)) {
    const kind = r.chance(0.5) ? 'weapon' : 'armor';
    const rar = rollRarity(r, level, bonus);
    add(cacheCode(kind, rar), 1, `${kind === 'weapon' ? '무기' : '방어구'} 상자(${rarLabel(rar)})`);
  }
  if (rank === 'boss') {
    const slot = r.pick(['primary', 'special', 'destructive', 'helmet', 'upper', 'lower', 'boots'] as Slot[]);
    const it = makeGear(r, slot, Math.min(level, s.level), rollRarity(r, level, 1.2, 'rare'), 'drop', now);
    got.push(giveItem(s, it, now));
  }
  if (r.chance(rank === 'boss' ? 0.35 : 0.03)) got.push(giveItem(s, makeModule(r, Math.min(level, s.level), rollRarity(r, level, bonus), 'drop', now), now));
  return got;
}

const RAR_LABEL: Record<Rarity, string> = { trash: '폐품', common: '일반', hq: '고급', rare: '희귀', legendary: '전설', epic: '에픽' };
export const rarLabel = (r: Rarity) => RAR_LABEL[r];

// ───────────── quests ─────────────

const QUEST_SPEC: Record<QuestKind, { need: [number, number]; f: number }> = {
  kill: { need: [8, 14], f: 1 }, street: { need: [5, 8], f: 0.8 }, dungeon: { need: [1, 2], f: 1.6 },
  print: { need: [2, 4], f: 0.7 }, craft: { need: [3, 6], f: 0.7 }, crate: { need: [3, 6], f: 0.9 }, ice: { need: [1, 1], f: 0.6 },
};
export const QUEST_LABEL: Record<QuestKind, string> = {
  kill: '적 처치', street: '길거리 적 처치', dungeon: '던전 보물방 정리', print: '상자 인쇄', craft: '아이템 제작', crate: '던전 상자 열기', ice: 'ICE 크래킹 성공',
};

export function fillQuests(s: GameState, r: Rng) {
  while (s.quests.length < 3) {
    const used = s.quests.map((q) => q.kind);
    const kinds = (Object.keys(QUEST_SPEC) as QuestKind[]).filter((k) => !used.includes(k));
    const kind = r.pick(kinds);
    const spec = QUEST_SPEC[kind];
    s.quests.push({
      id: ++s.questSeq, kind, need: r.int(...spec.need), have: 0,
      credits: round((30 + 14 * s.level) * spec.f), xp: round(xpToNext(s.level) * 0.12 * spec.f),
    });
  }
}

export function bump(s: GameState, kind: QuestKind, n = 1) {
  for (const q of s.quests) if (q.kind === kind) q.have = Math.min(q.need, q.have + n);
}

// ───────────── settle: apply the passage of time ─────────────

export const HUB_REGEN = 0.04;     // share of max HP per second in town
export const STREET_REGEN = 0.008; // in a street area

/** HP right now, counting regeneration since hpAt (none inside a dungeon, during combat or while flatlined). */
export function hpNow(s: GameState, now: number): number {
  const max = calc(s, now).maxHp;
  if (s.loc === 'dungeon' || s.combat || now <= s.hpAt) return Math.min(s.hp, max);
  const rate = s.loc === 'town' ? HUB_REGEN : STREET_REGEN;
  return Math.min(max, round(s.hp + max * rate * ((now - s.hpAt) / 1000)));
}

export function settle(s: GameState, ctx: Ctx) {
  const { now } = ctx;
  if (s.flatlineUntil && now >= s.flatlineUntil) s.flatlineUntil = undefined;
  if (now > s.hpAt) {
    s.hp = hpNow(s, now);
    s.hpAt = now;
  }
  s.buffs = s.buffs.filter((b) => b.until > now);
  fillQuests(s, ctx.rng);
}

// ───────────── new game ─────────────

/** A fresh character. The caller stores r.save() into s.rng afterwards. */
export function newGame(r: Rng, now: number): GameState {
  const s: GameState = {
    v: 2, rng: [], createdAt: now, level: 1, xp: 0, totalXp: 0, totalXpAt: now, credits: 120, hp: 1, hpAt: now,
    unlocked: 0, bagCap: 40, hotbar: [0, null, null],
    skills: { printing: { lv: 1, xp: 0 }, medical: { lv: 1, xp: 0 }, ammo: { lv: 1, xp: 0 } },
    stats: { kills: 0, bossKills: 0, deaths: 0, dungeonClears: 0, challengeClears: 0, raidAttempts: 0, raidWins: 0, cratesOpened: 0, itemsPrinted: 0, iceCracked: 0 },
    items: [], stacks: { [healCode(0)]: 5, cells: 20, antimatter: 2 }, records: [],
    loc: 'town', quests: [], questSeq: 0, buffs: [], log: [],
  };
  for (const slot of ['primary', 'special', 'upper', 'lower', 'boots'] as Slot[]) {
    const it = makeGear(r, slot, 1, slot === 'primary' ? 'common' : 'trash', 'start', now);
    it.equipped = true;
    s.items.push(it);
  }
  s.hp = calc(s, now).maxHp;
  fillQuests(s, r);
  log(s, '접속 완료. 제로 플라자에 도착했다. 마그레일 역에서 하수 순환로로 가 보자.', 'info', now);
  return s;
}

export { HEALS, PCT_STATS };
