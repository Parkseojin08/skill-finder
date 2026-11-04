// Everything outside dungeons: street fights, gear management, the printer, crafting, shops, the daily market,
// the terminal (keys and ICE cracking), AFK jobs, quests, overclock and the daily raid.

import { HEALS, JOB_DURATIONS, JOBS, RAID_BOSSES, RARITIES, STATIONS, WEAPON_SLOTS, type Rarity, type Slot } from './data.ts';
import {
  addStack, bagCount, bump, businessDay, cacheCode, fail, fillQuests, foeAtk, foeHp, fragCode, gainSkill, gainXp,
  giveItem, healCode, log, makeFoe, makeGear, makeModule, rarLabel, rarityIndex, rollRarity, round, sellPrice, spend,
  stack, takeStack,
  type Ctx, type Foe, type GameState, type Item, type Offer,
} from './core.ts';
import { makeAllies, startCombat } from './combat.ts';
import type { Rng } from './rng.ts';

function inTown(s: GameState, ctx: Ctx, what: string) {
  if (s.combat) fail('전투 중입니다');
  if (s.dungeon) fail(`던전 안에서는 ${what}할 수 없습니다`);
  if (s.flatlineUntil && ctx.now < s.flatlineUntil) fail('플랫라인 중입니다. 잠시 기다리세요');
}

// ───────────── street ─────────────

export function streetEnter(s: GameState, station: number, area: number, ctx: Ctx) {
  inTown(s, ctx, '이동');
  const a = STATIONS[station]?.areas[area];
  if (!a) fail('없는 지역입니다');
  if (station > s.unlocked) fail('아직 열리지 않은 구역입니다');
  s.street = { station, area, foes: Array.from({ length: 4 }, () => makeFoe(ctx.rng, station, ctx.rng.int(a.min, a.max), 'normal', 0.15)) };
  s.loc = 'street';
}

export function streetFight(s: GameState, idx: number, ctx: Ctx) {
  if (!s.street) fail('길거리에 있지 않습니다');
  if (s.combat) fail('이미 전투 중입니다');
  if (s.flatlineUntil && ctx.now < s.flatlineUntil) fail('플랫라인 중입니다');
  const foe = s.street.foes[idx];
  if (!foe) fail('없는 적입니다');
  startCombat(s, foe, 'street', ctx, { streetIdx: idx });
}

export function streetLeave(s: GameState) {
  if (s.combat) fail('전투 중입니다');
  s.street = undefined;
  if (s.loc === 'street') s.loc = 'town';
}

// ───────────── gear ─────────────

const item = (s: GameState, id: string) => s.items.find((i) => i.id === id) ?? fail('없는 아이템입니다');

export function equip(s: GameState, id: string) {
  if (s.combat) fail('전투 중에는 장비를 바꿀 수 없습니다');
  const it = item(s, id);
  if (it.kind !== 'gear' || !it.slot) fail('장비가 아닙니다');
  if (it.equipped) return;
  if (it.level > s.level) fail(`Lv.${it.level} 장비는 아직 쓸 수 없습니다`);
  for (const other of s.items) if (other.equipped && other.slot === it.slot) other.equipped = false;
  it.equipped = true;
}

export function unequip(s: GameState, id: string) {
  if (s.combat) fail('전투 중에는 장비를 바꿀 수 없습니다');
  const it = item(s, id);
  if (!it.equipped) return;
  if (bagCount(s) >= s.bagCap) fail('가방이 가득 찼습니다');
  it.equipped = false;
}

/** Removes an item, sending any fitted modules back to the bag. */
function removeItem(s: GameState, it: Item) {
  if (it.equipped) fail('장착 중인 장비입니다. 먼저 해제하세요');
  if (it.installedIn) fail('장비에 끼워진 모듈입니다. 먼저 빼세요');
  for (const m of s.items) if (m.installedIn === it.id) m.installedIn = undefined;
  s.items = s.items.filter((x) => x !== it);
}

export function sell(s: GameState, id: string, ctx: Ctx) {
  inTown(s, ctx, '판매');
  const it = item(s, id);
  removeItem(s, it);
  const price = sellPrice(it);
  s.credits += price;
  log(s, `${it.name} 판매: ¥${price}`, 'info', ctx.now);
}

export function scrap(s: GameState, id: string, ctx: Ctx) {
  inTown(s, ctx, '분해');
  const it = item(s, id);
  removeItem(s, it);
  const n = 1 + rarityIndex(it.rarity) * 2 + Math.floor(it.level / 10);
  addStack(s, 'scrap', n);
  gainSkill(s, 'printing', 3, ctx.now);
  log(s, `${it.name} 분해: 고철 ×${n}, 인쇄 경험 +3`, 'info', ctx.now);
}

export function modInstall(s: GameState, modId: string, gearId: string) {
  if (s.combat) fail('전투 중입니다');
  const m = item(s, modId);
  const g = item(s, gearId);
  if (m.kind !== 'module' || g.kind !== 'gear') fail('모듈을 장비에 끼워야 합니다');
  if (m.installedIn) fail('이미 끼워진 모듈입니다');
  if (m.level > g.level) fail(`모듈 레벨(${m.level})이 장비 레벨(${g.level})보다 높습니다`);
  if (s.items.filter((x) => x.installedIn === g.id).length >= g.modSlots) fail('빈 모듈 칸이 없습니다');
  m.installedIn = g.id;
}

export function modRemove(s: GameState, modId: string) {
  if (s.combat) fail('전투 중입니다');
  const m = item(s, modId);
  if (!m.installedIn) return;
  if (bagCount(s) >= s.bagCap) fail('가방이 가득 찼습니다');
  m.installedIn = undefined;
}

export function setHotbar(s: GameState, slot: number, tier: number | null) {
  if (slot < 0 || slot > 2) fail('없는 단축칸입니다');
  if (tier != null && !HEALS[tier]) fail('없는 회복제입니다');
  s.hotbar[slot] = tier;
}

// ───────────── nano forge (printing caches) ─────────────

export const PRINT_COST: Record<Rarity, number> = { trash: 1, common: 1.6, hq: 2.6, rare: 4.5, legendary: 8, epic: 14 };
const PRINT_XP: Record<Rarity, number> = { trash: 6, common: 10, hq: 18, rare: 32, legendary: 60, epic: 110 };
export const printLevel = (s: GameState) => Math.min(s.skills.printing.lv, s.level);
export const printCost = (s: GameState, r: Rarity) => round((10 + 4 * printLevel(s)) * PRINT_COST[r]);

export function print(s: GameState, kind: 'weapon' | 'armor', rarity: Rarity, ctx: Ctx) {
  inTown(s, ctx, '인쇄');
  if (!RARITIES.includes(rarity)) fail('없는 등급입니다');
  const code = cacheCode(kind, rarity);
  if (stack(s, code) < 1) fail('그 상자가 없습니다');
  if (bagCount(s) >= s.bagCap) fail('가방이 가득 찼습니다');
  spend(s, printCost(s, rarity));
  takeStack(s, code, 1, '상자');
  const slots: Slot[] = kind === 'weapon' ? WEAPON_SLOTS : ['helmet', 'upper', 'lower', 'boots'];
  const it = makeGear(ctx.rng, ctx.rng.pick(slots), printLevel(s), rarity, 'print', ctx.now);
  giveItem(s, it, ctx.now);
  gainSkill(s, 'printing', PRINT_XP[rarity], ctx.now);
  s.stats.itemsPrinted++;
  bump(s, 'print');
  log(s, `인쇄 완료: ${it.name} (Lv.${it.level} ${rarLabel(rarity)})`, 'loot', ctx.now);
}

// ───────────── crafting ─────────────

export type Recipe = 'heal' | 'cells' | 'antimatter' | 'module';
export const moduleCost = (s: GameState) => 25 * s.level;

export function craft(s: GameState, recipe: Recipe, tier: number, ctx: Ctx) {
  if (s.combat) fail('전투 중입니다');
  const ammo = s.skills.ammo.lv;
  if (recipe === 'heal') {
    const h = HEALS[tier] ?? fail('없는 회복제입니다');
    if (s.skills.medical.lv < h.med) fail(`의료 숙련도 ${h.med}이(가) 필요합니다`);
    takeStack(s, 'med', h.parts, '의료 부품');
    addStack(s, healCode(tier), 1);
    gainSkill(s, 'medical', 2 + 2 * tier, ctx.now);
  } else if (recipe === 'cells') {
    takeStack(s, 'ammoparts', 1, '탄약 부품');
    addStack(s, 'cells', 3 + Math.floor(ammo / 8));
    gainSkill(s, 'ammo', 1, ctx.now);
  } else if (recipe === 'antimatter') {
    if (stack(s, 'scrap') < 1) fail('고철이 부족합니다');
    takeStack(s, 'ammoparts', 3, '탄약 부품');
    takeStack(s, 'scrap', 1, '고철');
    addStack(s, 'antimatter', 1 + Math.floor(ammo / 15));
    gainSkill(s, 'ammo', 2, ctx.now);
  } else if (recipe === 'module') {
    if (bagCount(s) >= s.bagCap) fail('가방이 가득 찼습니다');
    if (stack(s, 'scrap') < 12) fail(`고철이 부족합니다 (${stack(s, 'scrap')}/12)`);
    spend(s, moduleCost(s));
    takeStack(s, 'scrap', 12, '고철');
    const m = makeModule(ctx.rng, s.level, rollRarity(ctx.rng, s.level, 0.2), 'craft', ctx.now);
    giveItem(s, m, ctx.now);
    log(s, `모듈 조립: ${m.name} (${rarLabel(m.rarity)})`, 'loot', ctx.now);
  } else {
    fail('없는 제작법입니다');
  }
  bump(s, 'craft');
}

// ───────────── shops ─────────────

export const cellPrice = (s: GameState) => round(10 * (3 + 0.1 * s.level));    // bundle of 10
export const antimatterPrice = (s: GameState) => round(3 * (18 + s.level));     // bundle of 3
export const PART_PRICE: Record<'med' | 'ammoparts', number> = { med: 15, ammoparts: 12 };
export const maxPharmTier = (s: GameState) => Math.min(HEALS.length - 1, s.unlocked + 1);

function gearOffer(r: Rng, s: GameState, rarity: Rarity, now: number, markup: number): Offer {
  const slot = r.pick(['primary', 'special', 'destructive', 'helmet', 'upper', 'lower', 'boots'] as Slot[]);
  const it = makeGear(r, slot, s.level, rarity, 'shop', now);
  return { id: it.id, kind: 'gear', item: it, price: round(sellPrice(it) * markup) };
}

/** The weaponsmith restocks every hour, and right away when you level up. */
export function ensureSmith(s: GameState, ctx: Ctx, force = false) {
  const hour = Math.floor(ctx.now / 3_600_000);
  if (!force && s.smith?.hour === hour && s.smith.level === s.level) return;
  const r = ctx.rng;
  const offers = Array.from({ length: 5 }, () => {
    const rar = rollRarity(r, s.level, 0.3, 'common');
    return gearOffer(r, s, rarityIndex(rar) > 3 ? 'rare' : rar, ctx.now, 3);
  });
  s.smith = { hour, level: s.level, offers };
}

export function smithBuy(s: GameState, id: string, ctx: Ctx) {
  inTown(s, ctx, '구매');
  buyOffer(s, s.smith?.offers, id, ctx);
}

export function smithRefresh(s: GameState, ctx: Ctx) {
  inTown(s, ctx, '구매');
  spend(s, 20 * s.level);
  ensureSmith(s, ctx, true);
}

export function smithAmmo(s: GameState, kind: 'cells' | 'antimatter', ctx: Ctx) {
  inTown(s, ctx, '구매');
  if (kind === 'cells') { spend(s, cellPrice(s)); addStack(s, 'cells', 10); }
  else { spend(s, antimatterPrice(s)); addStack(s, 'antimatter', 3); }
}

export function pharmBuy(s: GameState, tier: number, n: number, ctx: Ctx) {
  inTown(s, ctx, '구매');
  if (tier > maxPharmTier(s) || !HEALS[tier]) fail('아직 팔지 않는 약입니다');
  if (n < 1 || n > 20) fail('수량은 1~20입니다');
  spend(s, HEALS[tier].price * n);
  addStack(s, healCode(tier), n);
}

export function pharmParts(s: GameState, code: 'med' | 'ammoparts', ctx: Ctx) {
  inTown(s, ctx, '구매');
  spend(s, PART_PRICE[code] * 5);
  addStack(s, code, 5);
}

function buyOffer(s: GameState, offers: Offer[] | undefined, id: string, ctx: Ctx) {
  const o = offers?.find((x) => x.id === id) ?? fail('없는 상품입니다');
  if (o.sold) fail('이미 팔린 상품입니다');
  if (o.kind === 'gear' && bagCount(s) >= s.bagCap) fail('가방이 가득 찼습니다');
  spend(s, o.price);
  o.sold = true;
  if (o.kind === 'gear') {
    s.items.push({ ...o.item, at: ctx.now });
    log(s, `구매: ${o.item.name} ¥${o.price}`, 'loot', ctx.now);
  } else {
    addStack(s, o.code, o.n);
    log(s, `구매: ${o.label} ¥${o.price}`, 'loot', ctx.now);
  }
}

// ───────────── black market: restocks at 09:00 local, at your level then ─────────────

export function ensureMarket(s: GameState, ctx: Ctx) {
  const day = businessDay(ctx.now, ctx.utcOffsetMin);
  if (s.market?.day === day) return;
  const r = ctx.rng;
  const L = s.level;
  const offers: Offer[] = Array.from({ length: 4 }, () => gearOffer(r, s, rollRarity(r, L, 0.6, 'hq'), ctx.now, 3));
  for (let i = 0; i < 2; i++) {
    const kind = r.chance(0.5) ? 'weapon' : 'armor';
    const rar = rollRarity(r, L, 0.8, 'hq');
    offers.push({ id: r.uuid(), kind: 'stack', code: cacheCode(kind, rar), n: 1, label: `${kind === 'weapon' ? '무기' : '방어구'} 상자(${rarLabel(rar)})`, price: round((10 + 4 * L) * PRINT_COST[rar] * 6) });
  }
  const t = maxPharmTier(s);
  offers.push({ id: r.uuid(), kind: 'stack', code: healCode(t), n: 5, label: `${HEALS[t].name} ×5 (20% 할인)`, price: round(HEALS[t].price * 5 * 0.8) });
  offers.push({ id: r.uuid(), kind: 'stack', code: 'cells', n: 30, label: '에너지 탄약 ×30 (30% 할인)', price: round(cellPrice(s) * 3 * 0.7) });
  offers.push({ id: r.uuid(), kind: 'stack', code: 'antimatter', n: 6, label: '반물질 ×6 (30% 할인)', price: round(antimatterPrice(s) * 2 * 0.7) });
  s.market = { day, level: L, offers };
}

export function marketBuy(s: GameState, id: string, ctx: Ctx) {
  inTown(s, ctx, '구매');
  ensureMarket(s, ctx);
  buyOffer(s, s.market?.offers, id, ctx);
}

// ───────────── terminal ─────────────

export const keyCost = (station: number) => 150 * (station + 1) ** 2;

export function forgeKey(s: GameState, station: number, ctx: Ctx) {
  inTown(s, ctx, '열쇠 합성');
  if (station !== s.unlocked || station >= STATIONS.length - 1) fail('지금 만들 수 있는 열쇠가 아닙니다');
  for (let i = 0; i < 3; i++) if (stack(s, fragCode(station, i)) < 1) fail(`${STATIONS[station].dungeons[i].name}의 조각이 없습니다`);
  spend(s, keyCost(station));
  for (let i = 0; i < 3; i++) addStack(s, fragCode(station, i), -1);
  s.unlocked++;
  log(s, `비밀 열쇠 완성. ${STATIONS[s.unlocked].name} 노선이 열렸다!`, 'good', ctx.now);
}

const ICE_COOLDOWN = 180_000;
export function iceStart(s: GameState, ctx: Ctx) {
  inTown(s, ctx, '해킹');
  if (s.modal) fail('다른 창이 열려 있습니다');
  if ((s.iceUntil ?? 0) > ctx.now) fail('ICE가 재정렬 중입니다. 잠시 뒤에 다시 시도하세요');
  s.iceUntil = ctx.now + ICE_COOLDOWN;
  s.modal = { kind: 'ice', code: Array.from({ length: 4 }, () => ctx.rng.int(0, 5)), guesses: [], max: 7 };
}

export function iceGuess(s: GameState, g: number[], ctx: Ctx) {
  const m = s.modal;
  if (m?.kind !== 'ice' || m.done) fail('진행 중인 해킹이 없습니다');
  if (g.length !== 4 || g.some((d) => !Number.isInteger(d) || d < 0 || d > 5)) fail('0~5 숫자 4개를 입력하세요');
  let exact = 0;
  const restCode: number[] = [];
  const restGuess: number[] = [];
  g.forEach((d, i) => (d === m.code[i] ? exact++ : (restCode.push(m.code[i]), restGuess.push(d))));
  let near = 0;
  for (const d of restGuess) {
    const j = restCode.indexOf(d);
    if (j >= 0) { near++; restCode.splice(j, 1); }
  }
  m.guesses.push({ g, exact, near });
  if (exact === 4) {
    m.done = 'won';
    const credits = 25 + 10 * s.level;
    s.credits += credits;
    addStack(s, 'ammoparts', 2);
    addStack(s, 'med', 1);
    s.stats.iceCracked++;
    bump(s, 'ice');
    let extra = '';
    if (ctx.rng.chance(0.15)) {
      const rar = rollRarity(ctx.rng, s.level, 0, 'common');
      const kind = ctx.rng.chance(0.5) ? 'weapon' : 'armor';
      addStack(s, cacheCode(kind, rar), 1);
      extra = `, ${kind === 'weapon' ? '무기' : '방어구'} 상자(${rarLabel(rar)})`;
    }
    log(s, `ICE 돌파! ¥${credits}, 탄약 부품 ×2, 의료 부품 ×1${extra}`, 'loot', ctx.now);
  } else if (m.guesses.length >= m.max) {
    m.done = 'lost';
    log(s, `ICE 크래킹 실패. 코드는 ${m.code.join('')}였다`, 'bad', ctx.now);
  }
}

export function closeModal(s: GameState) {
  const m = s.modal;
  if (!m) return;
  if (m.kind === 'sync') fail('상자 잠금을 풀거나 포기하세요');
  if (m.kind === 'giver') fail('수락하거나 거절하세요');
  s.modal = undefined;
}

// ───────────── AFK jobs ─────────────

export function jobStart(s: GameState, id: string, minutes: number, ctx: Ctx) {
  if (s.job) fail('이미 일감을 하고 있습니다');
  if (!JOBS.some((j) => j.id === id)) fail('없는 일감입니다');
  if (!JOB_DURATIONS.includes(minutes)) fail('없는 시간입니다');
  s.job = { id, startedAt: ctx.now, endsAt: ctx.now + minutes * 60_000 };
}

/** Collects the job. Stopping early pays for the time actually worked. */
export function jobClaim(s: GameState, ctx: Ctx) {
  const job = s.job ?? fail('하고 있는 일감이 없습니다');
  const m = (Math.min(ctx.now, job.endsAt) - job.startedAt) / 60_000;
  s.job = undefined;
  if (m < 1) { log(s, '일감을 취소했다', 'info', ctx.now); return; }
  const boost = (s.overclockUntil ?? 0) > ctx.now ? 1.5 : 1;
  const k = m * boost;
  const L = s.level;
  const got: string[] = [];
  const add = (code: string, n: number, label: string) => { if (n > 0) { addStack(s, code, n); got.push(`${label} ×${n}`); } };
  switch (job.id) {
    case 'print': gainSkill(s, 'printing', round(0.8 * k), ctx.now); got.push(`인쇄 경험 +${round(0.8 * k)}`); break;
    case 'med': gainSkill(s, 'medical', round(0.5 * k), ctx.now); got.push(`의료 경험 +${round(0.5 * k)}`); add('med', Math.floor(0.15 * k), '의료 부품'); break;
    case 'ammo': gainSkill(s, 'ammo', round(0.5 * k), ctx.now); got.push(`탄약 경험 +${round(0.5 * k)}`); add('ammoparts', Math.floor(0.25 * k), '탄약 부품'); break;
    case 'scav': {
      add('scrap', Math.floor(0.3 * k), '고철');
      add('med', Math.floor(0.05 * k), '의료 부품');
      add('ammoparts', Math.floor(0.08 * k), '탄약 부품');
      for (let i = 0; i < Math.floor(k / 30); i++) {
        const rar = rollRarity(ctx.rng, L, 0, 'trash');
        const kind = ctx.rng.chance(0.5) ? 'weapon' : 'armor';
        add(cacheCode(kind, rarityIndex(rar) > 1 ? 'common' : rar), 1, `${kind === 'weapon' ? '무기' : '방어구'} 상자`);
      }
      break;
    }
    case 'guard': {
      const credits = round((1 + 0.5 * L) * k);
      const xp = round((0.4 + 0.25 * L) * k);
      s.credits += credits;
      gainXp(s, xp, ctx.now);
      got.push(`¥${credits}`, `경험치 +${xp}`);
      break;
    }
  }
  log(s, `일감 정산 (${Math.floor(m)}분${boost > 1 ? ', 오버클럭 ×1.5' : ''}): ${got.join(', ') || '없음'}`, 'loot', ctx.now);
}

// ───────────── quests, overclock, raid ─────────────

export function questClaim(s: GameState, id: number, ctx: Ctx) {
  const q = s.quests.find((x) => x.id === id) ?? fail('없는 퀘스트입니다');
  if (q.have < q.need) fail('아직 끝나지 않은 퀘스트입니다');
  s.quests = s.quests.filter((x) => x !== q);
  s.credits += q.credits;
  gainXp(s, q.xp, ctx.now);
  log(s, `퀘스트 보상: ¥${q.credits}, 경험치 +${q.xp}`, 'good', ctx.now);
  fillQuests(s, ctx.rng);
}

export const overclockCost = (s: GameState) => 100 * s.level;
export function overclock(s: GameState, ctx: Ctx) {
  spend(s, overclockCost(s));
  s.overclockUntil = Math.max(ctx.now, s.overclockUntil ?? 0) + 30 * 60_000;
  log(s, '오버클럭 가동: 30분간 피해 +20%, 일감 보상 ×1.5', 'good', ctx.now);
}

export const crewPrice = (s: GameState) => 40 * s.level;
/** Raid boss size relative to a normal enemy of your level. Tuned so going alone rarely works and a full crew usually does. */
export const RAID = { hp: 16, atk: 1.6, shield: 0.35 };
export const raidOpen = (s: GameState, ctx: Pick<Ctx, 'now' | 'utcOffsetMin'>) => s.raidDay !== businessDay(ctx.now, ctx.utcOffsetMin);

export function raidStart(s: GameState, crew: number, ctx: Ctx) {
  inTown(s, ctx, '레이드');
  if (!raidOpen(s, ctx)) fail('오늘 레이드는 끝났습니다. 내일 09:00에 다시 열립니다');
  if (!Number.isInteger(crew) || crew < 0 || crew > 2) fail('용병은 0~2명입니다');
  spend(s, crew * crewPrice(s));
  s.raidDay = businessDay(ctx.now, ctx.utcOffsetMin);
  s.stats.raidAttempts++;
  const r = ctx.rng;
  const L = s.level;
  const base = makeFoe(r, Math.min(s.unlocked, STATIONS.length - 1), L, 'boss', 0);
  const hp = round(foeHp(L) * RAID.hp * r.between(0.9, 1.1));
  const shield = round(hp * RAID.shield);
  const boss: Foe = { ...base, name: r.pick(RAID_BOSSES), hp, maxHp: hp, shield, maxShield: shield, atk: round(foeAtk(L) * RAID.atk * 10) / 10 };
  startCombat(s, boss, 'raid', ctx, { allies: makeAllies(s, crew, ctx) });
  log(s, `레이드 시작: ${boss.name}. 용병 ${crew}명`, 'info', ctx.now);
}
