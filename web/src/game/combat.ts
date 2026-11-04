// Turn-based combat. One player action resolves the whole turn (player → mercenaries → enemy) and leaves the
// sequence in combat.events, which the screen plays back one by one.

import { MERCS, STATIONS } from './data.ts';
import {
  bump, cacheCode, calc, dropLoot, fail, foeXp, gainXp, giveItem, HEALS, healCode, log, makeFoe, makeGear, rarLabel,
  rollRarity, round, takeStack, xpToNext, addStack,
  type Ally, type Combat, type CombatEvent, type Ctx, type Foe, type GameState, type PlayerStats,
} from './core.ts';
import type { Slot } from './data.ts';

export type Weapon = 'primary' | 'special' | 'destructive';
export const WEAPON_AMMO: Record<Weapon, { code: string; label: string } | null> = {
  primary: null,
  special: { code: 'cells', label: '에너지 탄약' },
  destructive: { code: 'antimatter', label: '반물질' },
};
/** How hard each weapon hits shields: special is good against them, destructive is poor. */
const SHIELD_MULT: Record<Weapon, number> = { primary: 1, special: 1.2, destructive: 0.5 };

export function startCombat(s: GameState, foe: Foe, where: Combat['where'], ctx: Ctx, extra: { entId?: string; streetIdx?: number; allies?: Ally[] } = {}) {
  const st = calc(s, ctx.now);
  s.combat = {
    where, foe: structuredClone(foe), entId: extra.entId, streetIdx: extra.streetIdx, allies: extra.allies ?? [],
    shield: st.maxShield, maxShield: st.maxShield, turn: 0, rewards: [],
    events: [{ text: `${foe.name}(Lv.${foe.level})와(과) 교전을 시작했다` }],
  };
}

/** Shield takes `dmg × mult` first; whatever is left over hits health at full strength. */
function soak(target: { hp: number; shield: number }, dmg: number, mult: number) {
  const onShield = Math.min(target.shield, dmg * mult);
  target.shield = round(target.shield - onShield);
  target.hp = Math.max(0, round(target.hp - (dmg - onShield / mult)));
}

function playerHits(c: Combat, st: PlayerStats, w: Weapon, ctx: Ctx) {
  const r = ctx.rng;
  const f = c.foe;
  if (r.chance(f.evade / 100)) {
    c.events.push({ text: `${f.name}이(가) 피했다`, target: 'foe', miss: true, hp: f.hp, shield: f.shield });
    return;
  }
  let dmg = st.dmg[w] * r.between(0.9, 1.1);
  const crit = r.chance(st.crit / 100);
  if (crit) dmg *= st.critDmg / 100;
  dmg = Math.max(1, round(dmg * (1 - f.defPct / 100)));
  soak(f, dmg, SHIELD_MULT[w]);
  const label = w === 'primary' ? '주무기' : w === 'special' ? '특수무기' : '파괴무기';
  c.events.push({ text: `${label}로 ${dmg} 피해${crit ? ' (치명타!)' : ''}`, target: 'foe', dmg, crit, hp: f.hp, shield: f.shield });
  if (f.hp > 0 && r.chance(st.stun / 100)) {
    f.stunned = true;
    c.events.push({ text: `${f.name}이(가) 기절했다`, target: 'foe', hp: f.hp, shield: f.shield });
  }
}

function alliesHit(c: Combat, ctx: Ctx) {
  const f = c.foe;
  for (const a of c.allies) {
    if (a.hp <= 0 || f.hp <= 0) continue;
    const dmg = round(a.atk * ctx.rng.between(0.85, 1.15) * (1 - f.defPct / 100));
    soak(f, dmg, 1);
    c.events.push({ text: `${a.name}: ${dmg} 피해`, target: 'foe', dmg, hp: f.hp, shield: f.shield });
  }
}

function foeTurn(s: GameState, c: Combat, st: PlayerStats, ctx: Ctx) {
  const r = ctx.rng;
  const f = c.foe;
  if (f.stunned) {
    f.stunned = false;
    c.events.push({ text: `${f.name}은(는) 기절해서 움직이지 못한다` });
    return;
  }
  let raw = f.atk * r.between(0.9, 1.1);
  const crit = r.chance(f.crit / 100);
  if (crit) raw *= f.critDmg / 100;
  const alive = c.allies.map((a, i) => ({ a, i })).filter((x) => x.a.hp > 0);
  if (alive.length && r.chance(alive.length / (alive.length + 1))) {
    const { a, i } = r.pick(alive);
    const dmg = round(raw * 0.9);
    a.hp = Math.max(0, a.hp - dmg);
    c.events.push({ text: `${f.name} → ${a.name} ${dmg}${crit ? ' (치명타)' : ''}${a.hp === 0 ? ' — 쓰러졌다' : ''}`, target: i, dmg, crit, hp: a.hp });
    return;
  }
  if (r.chance(st.evade / 100)) {
    c.events.push({ text: `${f.name}의 공격을 피했다`, target: 'player', miss: true, hp: s.hp, shield: c.shield });
    return;
  }
  const dmg = Math.max(1, round((raw - st.armor) * (1 - st.defPct / 100)));
  const me = { hp: s.hp, shield: c.shield };
  soak(me, dmg, 1);
  s.hp = me.hp;
  c.shield = me.shield;
  c.events.push({ text: `${f.name}에게 ${dmg} 피해를 입었다${crit ? ' (치명타!)' : ''}`, target: 'player', dmg, crit, hp: s.hp, shield: c.shield });
}

export type CombatAction = { t: 'attack'; w: Weapon } | { t: 'useItem'; slot: number } | { t: 'escape' };

export function combatAction(s: GameState, a: CombatAction, ctx: Ctx) {
  const c = s.combat;
  if (!c) fail('전투 중이 아닙니다');
  if (c.result) fail('이미 끝난 전투입니다');
  const st = calc(s, ctx.now);
  c.events = [];
  c.turn++;

  if (a.t === 'attack') {
    if (a.w !== 'primary') {
      if (st.dmg[a.w] <= 0) fail(`${a.w === 'special' ? '특수무기' : '파괴무기'}를 장착하지 않았습니다`);
      const ammo = WEAPON_AMMO[a.w]!;
      takeStack(s, ammo.code, 1, ammo.label);
    }
    playerHits(c, st, a.w, ctx);
  } else if (a.t === 'useItem') {
    if (c.where === 'street') fail('길거리 전투에서는 아이템을 쓸 수 없습니다');
    const tier = s.hotbar[a.slot];
    if (tier == null) fail('빈 단축칸입니다');
    takeStack(s, healCode(tier), 1, HEALS[tier].name);
    const healed = Math.min(st.maxHp - s.hp, HEALS[tier].heal);
    s.hp += healed;
    c.events.push({ text: `${HEALS[tier].name}: 체력 +${healed}`, target: 'player', heal: healed, hp: s.hp, shield: c.shield });
  } else {
    const chance = c.where === 'street' ? 1 : st.escape / 100;
    if (ctx.rng.chance(chance)) {
      c.result = 'fled';
      c.events.push({ text: '도주에 성공했다' });
      return;
    }
    c.events.push({ text: `도주 실패 (${Math.round(chance * 100)}%)` });
  }

  if (c.foe.hp <= 0) return win(s, ctx);
  alliesHit(c, ctx);
  if (c.foe.hp <= 0) return win(s, ctx);
  foeTurn(s, c, st, ctx);
  if (s.hp > 0 && st.regen > 0) {
    const healed = Math.min(st.maxHp - s.hp, st.regen);
    if (healed > 0) {
      s.hp += healed;
      c.events.push({ text: `재생 +${healed}`, target: 'player', heal: healed, hp: s.hp, shield: c.shield });
    }
  }
  if (s.hp <= 0) lose(s, ctx);
}

function win(s: GameState, ctx: Ctx) {
  const c = s.combat!;
  const { now } = ctx;
  const r = ctx.rng;
  const f = c.foe;
  c.result = 'win';
  c.events.push({ text: `${f.name}을(를) 쓰러뜨렸다!`, target: 'foe', hp: 0, shield: 0 });
  s.stats.kills++;
  if (f.rank === 'boss') s.stats.bossKills++;

  if (c.where === 'raid') {
    s.stats.raidWins++;
    const credits = 120 * s.level;
    const xp = round(xpToNext(s.level) * 0.5);
    s.credits += credits;
    gainXp(s, xp, now);
    c.rewards = [`경험치 +${xp}`, `¥${credits}`];
    for (let i = 0; i < 2; i++) {
      const kind = r.chance(0.5) ? 'weapon' : 'armor';
      const rar = rollRarity(r, s.level, 1, 'hq');
      addStack(s, cacheCode(kind, rar), 1);
      c.rewards.push(`${kind === 'weapon' ? '무기' : '방어구'} 상자(${rarLabel(rar)})`);
    }
    const slot = r.pick(['primary', 'special', 'destructive', 'helmet', 'upper', 'lower', 'boots'] as Slot[]);
    c.rewards.push(giveItem(s, makeGear(r, slot, s.level, rollRarity(r, s.level, 1.5, 'rare'), 'raid', now), now));
    log(s, `레이드 승리! ${c.rewards.join(', ')}`, 'loot', now);
    return;
  }

  const xp = foeXp(f, s.level);
  const challenge = s.dungeon?.challenge ?? false;
  const creditsBefore = s.credits;
  const loot = s.level - f.level > 10 ? ['(레벨 차이가 커서 전리품 없음)'] : dropLoot(s, r, f.level, f.rank, c.where, challenge, now);
  gainXp(s, xp, now);
  c.rewards = [`경험치 +${xp}`, ...loot];
  bump(s, 'kill');

  if (c.where === 'street' && s.street && c.streetIdx != null) {
    bump(s, 'street');
    const area = STATIONS[s.street.station].areas[s.street.area];
    s.street.foes[c.streetIdx] = makeFoe(r, s.street.station, r.int(area.min, area.max), 'normal', 0.15);
  }
  if (c.where === 'dungeon' && s.dungeon) {
    const d = s.dungeon;
    const room = d.rooms[d.cur];
    const ent = room.ents.find((e) => e.id === c.entId);
    if (ent) ent.done = true;
    d.loot.xp += xp;
    d.loot.credits += s.credits - creditsBefore;
    if (!room.ents.some((e) => e.k === 'foe' && !e.done)) {
      c.rewards.push('방 정리 — 문이 열렸다');
      if (room.kind === 'treasure' && !d.cleared) completeDungeon(s, ctx);
    }
  }
}

function completeDungeon(s: GameState, ctx: Ctx) {
  const d = s.dungeon!;
  const { now } = ctx;
  d.cleared = true;
  const ms = Math.max(1, now - d.startedAt);
  s.stats.dungeonClears++;
  if (d.challenge) s.stats.challengeClears++;
  bump(s, 'dungeon');
  const bonusXp = round(xpToNext(s.level) * (d.challenge ? 0.25 : 0.15));
  const bonusCredits = round((20 + 8 * d.level) * (d.challenge ? 2 : 1));
  s.credits += bonusCredits;
  gainXp(s, bonusXp, now);
  let rec = s.records.find((x) => x.station === d.station && x.dungeon === d.idx && x.challenge === d.challenge);
  if (!rec) {
    rec = { station: d.station, dungeon: d.idx, challenge: d.challenge, clears: 0, firstAt: now };
    s.records.push(rec);
  }
  rec.clears++;
  const best = rec.bestMs == null || ms < rec.bestMs;
  if (best) { rec.bestMs = ms; rec.bestAt = now; }
  const name = STATIONS[d.station].dungeons[d.idx].name;
  const time = `${Math.floor(ms / 60000)}분 ${Math.floor((ms % 60000) / 1000)}초`;
  s.combat?.rewards.push(`던전 정리 보너스: 경험치 +${bonusXp}, ¥${bonusCredits}`, `기록 ${time}${best ? ' (최고 기록!)' : ''}`);
  log(s, `${name}${d.challenge ? '(도전)' : ''} 보물방 정리! ${time}${best ? ' — 최고 기록' : ''}`, 'good', now);
}

/** FLATLINE: the run ends, a short lockout, and (from level 5) a small credit and XP loss. Items are kept. */
function lose(s: GameState, ctx: Ctx) {
  const c = s.combat!;
  const { now } = ctx;
  c.result = 'lose';
  s.stats.deaths++;
  const lost: string[] = [];
  if (s.level >= 5) {
    const credits = Math.floor(s.credits * 0.1);
    const xp = Math.min(s.xp, Math.floor(xpToNext(s.level) * 0.1));
    s.credits -= credits;
    s.xp -= xp;
    s.totalXp -= xp;
    lost.push(`¥${credits} 손실`, `경험치 -${xp}`);
  }
  s.flatlineUntil = now + 10_000;
  s.hp = round(calc(s, now).maxHp * 0.3);
  s.hpAt = s.flatlineUntil;
  s.dungeon = undefined;
  s.street = undefined;
  s.loc = 'town';
  c.rewards = ['FLATLINE — 10초 동안 행동할 수 없다', ...lost];
  log(s, `플랫라인. ${lost.join(', ') || '잃은 것 없음'}`, 'bad', now);
}

/** Closes the result screen. A fled enemy keeps its wounds. */
export function closeCombat(s: GameState) {
  const c = s.combat;
  if (!c) fail('전투 중이 아닙니다');
  if (!c.result) fail('전투가 아직 끝나지 않았습니다');
  if (c.result === 'fled') {
    const back = { ...c.foe, stunned: false };
    if (c.where === 'dungeon' && s.dungeon) {
      const ent = s.dungeon.rooms[s.dungeon.cur].ents.find((e) => e.id === c.entId);
      if (ent) ent.foe = back;
    }
    if (c.where === 'street' && s.street && c.streetIdx != null) s.street.foes[c.streetIdx] = back;
  }
  s.combat = undefined;
}

export function makeAllies(s: GameState, n: number, ctx: Ctx): Ally[] {
  const st = calc(s, ctx.now);
  const names = [...MERCS];
  return Array.from({ length: n }, () => {
    const name = names.splice(ctx.rng.int(0, names.length - 1), 1)[0];
    const hp = round(st.maxHp * 0.7);
    return { name, hp, maxHp: hp, atk: round(Math.max(st.dmg.primary, st.dmg.special * 0.8) * 0.75) };
  });
}

export type { CombatEvent };
