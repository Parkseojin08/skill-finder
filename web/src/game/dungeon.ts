// Dungeons: a map of rooms joined by doors. Each room is a 15×11 grid the player walks one cell at a time.
// Doors stay shut until every enemy in the room is down; the farthest room is the treasure room.

import { BUFFS, GIVER_LINES, GIVERS, LORE, STATIONS } from './data.ts';
import {
  addStack, bump, dropLoot, fail, fragCode, gainXp, log, makeFoe, round, takeStack, xpToNext,
  type Ctx, type Dir, type Dungeon, type Ent, type GameState, type GiverOffer, type Room,
} from './core.ts';
import type { Rng } from './rng.ts';
import { startCombat } from './combat.ts';

export const W = 15;
export const H = 11;
export const DIRS: Dir[] = ['n', 's', 'e', 'w'];
export const DELTA: Record<Dir, [number, number]> = { n: [0, -1], s: [0, 1], e: [1, 0], w: [-1, 0] };
const OPP: Record<Dir, Dir> = { n: 's', s: 'n', e: 'w', w: 'e' };
export const DOOR: Record<Dir, [number, number]> = { n: [7, 0], s: [7, 10], w: [0, 5], e: [14, 5] };
const INNER: Record<Dir, [number, number]> = { n: [7, 1], s: [7, 9], w: [1, 5], e: [13, 5] };
const CENTER: [number, number] = [7, 5];

const key = (x: number, y: number) => `${x},${y}`;

/** Cells reachable from the centre, treating '#' and the given blocked cells as walls. */
function reach(walls: string[], blocked: Set<string>): Set<string> {
  const seen = new Set([key(...CENTER)]);
  const queue: [number, number][] = [CENTER];
  while (queue.length) {
    const [x, y] = queue.shift()!;
    for (const d of DIRS) {
      const nx = x + DELTA[d][0];
      const ny = y + DELTA[d][1];
      const k = key(nx, ny);
      const c = walls[ny]?.[nx];
      if (!c || c === '#' || seen.has(k) || blocked.has(k)) continue;
      seen.add(k);
      if (c !== '+') queue.push([nx, ny]); // doors are reachable but lead nowhere inside the room
    }
  }
  return seen;
}

function makeWalls(r: Rng, doors: Partial<Record<Dir, number>>, obstacles: boolean): string[] {
  for (let attempt = 0; attempt < 30; attempt++) {
    const g: string[][] = Array.from({ length: H }, (_, y) => Array.from({ length: W }, (_, x) => (x === 0 || y === 0 || x === W - 1 || y === H - 1 ? '#' : '.')));
    for (const d of DIRS) if (doors[d] != null) g[DOOR[d][1]][DOOR[d][0]] = '+';
    if (obstacles && attempt < 25) {
      const n = r.int(3, 6);
      for (let i = 0; i < n; i++) {
        const horizontal = r.chance(0.5);
        const len = r.int(1, 3);
        const x0 = r.int(2, 12);
        const y0 = r.int(2, 8);
        for (let k = 0; k < len; k++) {
          const x = horizontal ? x0 + k : x0;
          const y = horizontal ? y0 : y0 + k;
          if (x < 2 || x > 12 || y < 2 || y > 8) continue;
          if (Math.abs(x - CENTER[0]) <= 1 && Math.abs(y - CENTER[1]) <= 1) continue;
          if (Object.values(INNER).some(([ix, iy]) => Math.abs(ix - x) + Math.abs(iy - y) <= 1)) continue;
          g[y][x] = '#';
        }
      }
    }
    const walls = g.map((row) => row.join(''));
    const seen = reach(walls, new Set());
    const open = walls.flatMap((row, y) => [...row].map((c, x) => (c === '.' || c === '+' ? key(x, y) : ''))).filter(Boolean);
    if (open.every((k) => seen.has(k))) return walls;
  }
  return makeWalls(r, doors, false);
}

/** Places entities so every door and every entity stays reachable (crates and NPCs block until used; enemies can be fought through). */
function placeEnts(r: Rng, walls: string[], specs: Omit<Ent, 'x' | 'y'>[]): Ent[] {
  const reserved = new Set([key(...CENTER), ...Object.values(INNER).map(([x, y]) => key(x, y))]);
  const floor = walls.flatMap((row, y) => [...row].map((c, x) => (c === '.' && !reserved.has(key(x, y)) ? [x, y] : null))).filter((v): v is number[] => !!v);
  for (let attempt = 0; attempt < 40; attempt++) {
    const pool = [...floor];
    const ents: Ent[] = specs.map((sp) => {
      const [x, y] = pool.splice(r.int(0, pool.length - 1), 1)[0];
      return { ...sp, x, y };
    });
    const blocked = new Set(ents.filter((e) => e.k !== 'foe').map((e) => key(e.x, e.y)));
    const seen = reach(walls, blocked);
    const doorsOk = DIRS.every((d) => walls[DOOR[d][1]][DOOR[d][0]] !== '+' || seen.has(key(...DOOR[d])));
    const entsOk = ents.every((e) => DIRS.some((d) => seen.has(key(e.x + DELTA[d][0], e.y + DELTA[d][1]))));
    if (doorsOk && entsOk) return ents;
  }
  return placeEnts(r, makeWalls(r, {}, false), specs); // unreachable in practice: an empty room always works
}

export function genDungeon(r: Rng, station: number, idx: number, challenge: boolean, now: number): Dungeon {
  const def = STATIONS[station].dungeons[idx];
  const level = def.level + (challenge ? 2 : 0);
  const target = r.int(6, 8) + (challenge ? 2 : 0);

  const shells: { gx: number; gy: number; doors: Partial<Record<Dir, number>> }[] = [{ gx: 0, gy: 0, doors: {} }];
  const at = new Map([[key(0, 0), 0]]);
  for (let guard = 0; shells.length < target && guard < 500; guard++) {
    const a = r.int(0, shells.length - 1);
    const d = r.pick(DIRS);
    const gx = shells[a].gx + DELTA[d][0];
    const gy = shells[a].gy + DELTA[d][1];
    if (at.has(key(gx, gy))) continue;
    const b = shells.push({ gx, gy, doors: {} }) - 1;
    at.set(key(gx, gy), b);
    shells[a].doors[d] = b;
    shells[b].doors[OPP[d]] = a;
  }
  shells.forEach((sh, i) => {
    for (const d of DIRS) {
      const j = at.get(key(sh.gx + DELTA[d][0], sh.gy + DELTA[d][1]));
      if (j != null && sh.doors[d] == null && r.chance(0.15)) { sh.doors[d] = j; shells[j].doors[OPP[d]] = i; }
    }
  });

  const dist = shells.map(() => -1);
  dist[0] = 0;
  const queue = [0];
  while (queue.length) {
    const i = queue.shift()!;
    for (const j of Object.values(shells[i].doors)) if (j != null && dist[j] < 0) { dist[j] = dist[i] + 1; queue.push(j); }
  }
  const treasure = dist.indexOf(Math.max(...dist));
  const middle = shells.map((_, i) => i).filter((i) => i !== 0 && i !== treasure);
  const questRoom = r.pick(middle);
  const loreRooms = new Set([r.pick(middle), r.pick(middle), 0]);
  const modChance = 0.2 + (challenge ? 0.15 : 0);

  const rooms: Room[] = shells.map((sh, i) => {
    const kind: Room['kind'] = i === 0 ? 'start' : i === treasure ? 'treasure' : 'normal';
    const specs: Omit<Ent, 'x' | 'y'>[] = [];
    const id = (k: string) => `${i}-${k}-${specs.length}`;
    const foe = (rank: 'normal' | 'elite' | 'boss', lvl: number) =>
      specs.push({ id: id('f'), k: 'foe', foe: makeFoe(r, station, Math.max(1, lvl), rank, modChance) });
    if (kind === 'normal') {
      // fewer enemies than the co-op original: one runner has to get through on their own heals
      const n = r.int(challenge ? 2 : 1, 3);
      for (let k = 0; k < n; k++) foe('normal', level + r.int(-1, 1));
      if (r.chance(0.55)) specs.push({ id: id('c'), k: 'crate' });
    }
    if (kind === 'treasure') {
      for (let k = 0; k < 3; k++) foe('normal', level + r.int(0, 1));
      foe(challenge ? 'boss' : 'elite', level + 2);
      specs.push({ id: id('c'), k: 'crate' }, { id: id('c'), k: 'crate' }, { id: id('g'), k: 'frag' });
    }
    if (i === questRoom) specs.push({ id: id('q'), k: 'quest' });
    if (loreRooms.has(i)) specs.push({ id: id('l'), k: 'lore', lore: r.int(0, LORE.length - 1) });
    const walls = makeWalls(r, sh.doors, kind !== 'start');
    return { gx: sh.gx, gy: sh.gy, doors: sh.doors, kind, visited: i === 0, walls, ents: placeEnts(r, walls, specs) };
  });

  return { station, idx, challenge, level, rooms, cur: 0, x: CENTER[0], y: CENTER[1], startedAt: now, cleared: false, loot: { credits: 0, xp: 0, items: 0 } };
}

export const liveFoes = (room: Room) => room.ents.filter((e) => e.k === 'foe' && !e.done);
/** Used-up entities (dead enemies, opened crates, read lore) can be walked over. */
const blocking = (room: Room, x: number, y: number) => room.ents.some((e) => e.x === x && e.y === y && !e.done);

/** Shortest walk for click-to-move (UI only). The last step may be a door or an entity to bump into. */
export function pathTo(room: Room, from: [number, number], to: [number, number]): Dir[] | null {
  const goal = key(...to);
  const prev = new Map<string, [string, Dir]>([[key(...from), ['', 'n']]]);
  const queue: [number, number][] = [from];
  while (queue.length) {
    const [x, y] = queue.shift()!;
    if (key(x, y) === goal) break;
    for (const d of DIRS) {
      const nx = x + DELTA[d][0];
      const ny = y + DELTA[d][1];
      const k = key(nx, ny);
      const c = room.walls[ny]?.[nx];
      if (!c || c === '#' || prev.has(k)) continue;
      const isGoal = k === goal;
      if (!isGoal && (c === '+' || blocking(room, nx, ny))) continue;
      prev.set(k, [key(x, y), d]);
      queue.push([nx, ny]);
    }
  }
  if (!prev.has(goal)) return null;
  const steps: Dir[] = [];
  for (let k = goal; k !== key(...from);) {
    const [p, d] = prev.get(k)!;
    steps.unshift(d);
    k = p;
  }
  return steps;
}

function giverOffer(r: Rng, level: number): GiverOffer {
  const wants = [
    { code: 'med', n: r.int(2, 5) }, { code: 'ammoparts', n: r.int(2, 5) }, { code: 'scrap', n: r.int(3, 6) },
    { code: 'cells', n: r.int(8, 20) }, { code: 'heal:0', n: r.int(2, 4) },
  ];
  const tier = level < 15 ? 1 : level < 35 ? 2 : 3;
  const family = r.pick(['over', 'plate', 'ward']);
  return { who: r.pick(GIVERS), line: r.pick(GIVER_LINES), want: r.pick(wants), buff: `${family}${tier}`, minutes: r.int(20, 45) };
}

const SYNC_LEN = 14;
const SYNC_MS = 10_000;
export function newSync(r: Rng, entId: string, now: number) {
  return { kind: 'sync' as const, entId, seq: Array.from({ length: SYNC_LEN }, () => r.pick(DIRS)), startedAt: now, limitMs: SYNC_MS };
}

function openCrate(s: GameState, ent: Ent, ctx: Ctx, bonus: boolean) {
  const d = s.dungeon!;
  const before = s.credits;
  const got = dropLoot(s, ctx.rng, d.level, 'normal', 'crate', d.challenge, ctx.now);
  if (bonus) { addStack(s, 'cells', 3); got.push('동기화 보너스: 에너지 탄약 ×3'); }
  d.loot.credits += s.credits - before;
  ent.done = true;
  s.stats.cratesOpened++;
  bump(s, 'crate');
  log(s, `상자: ${got.join(', ')}`, 'loot', ctx.now);
}

export function enterDungeon(s: GameState, station: number, idx: number, challenge: boolean, ctx: Ctx) {
  const def = STATIONS[station]?.dungeons[idx];
  if (!def) fail('없는 던전입니다');
  if (station > s.unlocked) fail('아직 열리지 않은 구역입니다. 터미널에서 열쇠를 만드세요');
  if (s.dungeon || s.combat) fail('이미 다른 곳에 있습니다');
  const level = def.level + (challenge ? 2 : 0);
  if (s.level < level - 6) fail(`레벨이 너무 낮습니다 (Lv.${level - 6} 이상)`);
  s.street = undefined;
  s.dungeon = genDungeon(ctx.rng, station, idx, challenge, ctx.now);
  s.loc = 'dungeon';
  log(s, `${def.name}${challenge ? '(도전)' : ''}에 접속했다. 방 ${s.dungeon.rooms.length}개`, 'info', ctx.now);
}

export function leaveDungeon(s: GameState, ctx: Ctx) {
  const d = s.dungeon;
  if (!d) fail('던전에 있지 않습니다');
  if (s.combat || s.modal) fail('지금은 나갈 수 없습니다');
  s.dungeon = undefined;
  s.loc = 'town';
  log(s, `던전에서 나왔다. 이번 진입: 경험치 +${d.loot.xp}, ¥${d.loot.credits}`, 'info', ctx.now);
}

/** One step. Blocked steps are not errors (a batch of steps simply stops having effect), so it never throws. */
export function move(s: GameState, dir: Dir, ctx: Ctx) {
  const d = s.dungeon;
  if (!d || s.combat || s.modal || s.loc !== 'dungeon') return;
  const room = d.rooms[d.cur];
  const nx = d.x + DELTA[dir][0];
  const ny = d.y + DELTA[dir][1];
  const c = room.walls[ny]?.[nx];
  if (!c || c === '#') return;

  if (c === '+') {
    const door = DIRS.find((k) => DOOR[k][0] === nx && DOOR[k][1] === ny)!;
    if (liveFoes(room).length) { log(s, '적이 남아 있어 문이 잠겨 있다', 'bad', ctx.now); return; }
    const next = room.doors[door]!;
    d.cur = next;
    [d.x, d.y] = INNER[OPP[door]];
    const tr = d.rooms[next];
    if (!tr.visited) {
      tr.visited = true;
      if (tr.kind === 'treasure') log(s, '보물방이다. 강한 기척이 느껴진다', 'bad', ctx.now);
    }
    return;
  }

  const ent = room.ents.find((e) => e.x === nx && e.y === ny && !e.done);
  if (ent) {
    if (ent.k === 'foe') { startCombat(s, ent.foe!, 'dungeon', ctx, { entId: ent.id }); return; }
    if (ent.k === 'crate' || ent.k === 'frag') {
      if (liveFoes(room).length) { log(s, '적부터 처리해야 열 수 있다', 'bad', ctx.now); return; }
      if (ent.k === 'frag') {
        addStack(s, fragCode(d.station, d.idx), 1);
        ent.done = true;
        log(s, `열쇠 조각 ${STATIONS[d.station].dungeons[d.idx].fragment}을(를) 얻었다`, 'loot', ctx.now);
      } else if (ctx.rng.chance(0.25)) {
        s.modal = newSync(ctx.rng, ent.id, ctx.now);
        return;
      } else {
        openCrate(s, ent, ctx, false);
      }
    } else if (ent.k === 'quest') {
      ent.offer ??= giverOffer(ctx.rng, d.level);
      s.modal = { kind: 'giver', entId: ent.id, ...ent.offer };
      return;
    } else if (ent.k === 'lore') {
      ent.done = true;
      s.modal = { kind: 'lore', text: LORE[ent.lore ?? 0] };
      return;
    }
  }
  d.x = nx;
  d.y = ny;
}

const findEnt = (s: GameState, id: string) => s.dungeon?.rooms[s.dungeon.cur].ents.find((e) => e.id === id);

export function syncSubmit(s: GameState, inputs: Dir[], ctx: Ctx) {
  const m = s.modal;
  if (m?.kind !== 'sync') fail('진행 중인 동기화가 없습니다');
  const ent = findEnt(s, m.entId);
  if (!ent) fail('상자를 찾을 수 없습니다');
  const inTime = ctx.now - m.startedAt <= m.limitMs + 3000; // allowance for network delay
  if (!inTime || inputs.length !== m.seq.length || inputs.some((v, i) => v !== m.seq[i])) fail('동기화 실패 — 다시 시도하거나 포기하세요');
  s.modal = undefined;
  openCrate(s, ent, ctx, true);
}

export function syncRetry(s: GameState, ctx: Ctx) {
  const m = s.modal;
  if (m?.kind !== 'sync') fail('진행 중인 동기화가 없습니다');
  s.modal = newSync(ctx.rng, m.entId, ctx.now);
}

export function syncAbandon(s: GameState, ctx: Ctx) {
  const m = s.modal;
  if (m?.kind !== 'sync') fail('진행 중인 동기화가 없습니다');
  const ent = findEnt(s, m.entId);
  if (ent) ent.done = true;
  s.modal = undefined;
  log(s, '잠금 해제에 실패해 상자가 자폭했다', 'bad', ctx.now);
}

export function giverAnswer(s: GameState, accept: boolean, ctx: Ctx) {
  const m = s.modal;
  if (m?.kind !== 'giver') fail('대화 중이 아닙니다');
  if (!accept) { s.modal = undefined; return; }
  const label = m.want.code.startsWith('heal') ? '진통 패치' : m.want.code === 'med' ? '의료 부품' : m.want.code === 'ammoparts' ? '탄약 부품' : m.want.code === 'scrap' ? '고철' : '에너지 탄약';
  takeStack(s, m.want.code, m.want.n, label);
  const def = BUFFS.find((b) => b.id === m.buff)!;
  s.buffs = s.buffs.filter((b) => b.id !== m.buff);
  s.buffs.push({ id: m.buff, until: ctx.now + m.minutes * 60_000 });
  const ent = findEnt(s, m.entId);
  if (ent) ent.done = true;
  s.modal = undefined;
  const xp = round(xpToNext(s.level) * 0.03);
  gainXp(s, xp, ctx.now);
  log(s, `${m.who}에게 ${label} ${m.want.n}개를 건넸다. ${def.label} ${m.minutes}분, 경험치 +${xp}`, 'good', ctx.now);
}
