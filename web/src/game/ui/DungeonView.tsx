import { useCallback, useEffect, useRef, useState } from 'react';
import { HEALS, STATIONS } from '../data.ts';
import { calc, stack, type Dir, type Dungeon, type GameState, type Room } from '../core.ts';
import { DELTA, H, liveFoes, pathTo, W } from '../dungeon.ts';
import { readInput } from '../input.ts';
import { Btn, fmt, type Send } from './common.tsx';

// quiet map palette: flat dark gray, gray '#' walls, muted icons, red only for locked doors and bosses
const C = {
  bg: '#17181a', grid: '#1f2022', wall: '#3d4143', wallHi: '#53585a', floor: '#2a2c2e', text: '#9aa3a2',
  accent: '#e5484d', red: '#e5484d', open: '#c4cbca', crate: '#b9a46a', elite: '#c98a5a', cyan: '#7f9ba6', violet: '#8a7bbf', green: '#6fae84', dim: '#454b4c',
};
const GLYPH_FONT = '"Cascadia Mono", "JetBrains Mono", Consolas, monospace';

function draw(ctx: CanvasRenderingContext2D, d: Dungeon, cell: number, t: number, player: { x: number; y: number }, hover: [number, number] | null, path: [number, number][], flash: number, hpRatio: number) {
  const room = d.rooms[d.cur];
  const locked = liveFoes(room).length > 0;
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W * cell, H * cell);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = room.walls[y][x];
      const cx = x * cell + cell / 2;
      const cy = y * cell + cell / 2;
      if (c === '#') {
        ctx.fillStyle = C.bg;
        ctx.fillRect(x * cell, y * cell, cell, cell);
        ctx.fillStyle = x === 0 || y === 0 || x === W - 1 || y === H - 1 ? C.wall : C.wallHi;
        ctx.font = `${cell * 0.55}px ${GLYPH_FONT}`;
        ctx.fillText('#', cx, cy + 1);
      } else if (c === '+') {
        ctx.fillStyle = locked ? C.red : C.open;
        ctx.globalAlpha = locked ? 0.8 : 0.6;
        const vertical = x === 0 || x === W - 1;
        const w = vertical ? cell * 0.28 : cell * 0.8;
        const h = vertical ? cell * 0.8 : cell * 0.28;
        ctx.fillRect(cx - w / 2, cy - h / 2, w, h);
        ctx.globalAlpha = 1;
      } else {
        ctx.fillStyle = C.floor;
        ctx.fillRect(cx - 1, cy - 1, 2, 2);
      }
    }
  }

  // hover path preview
  ctx.fillStyle = 'rgba(196, 203, 202, 0.25)';
  for (const [x, y] of path) ctx.fillRect(x * cell + cell / 2 - 3, y * cell + cell / 2 - 3, 6, 6);
  if (hover) {
    ctx.strokeStyle = 'rgba(196, 203, 202, 0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(hover[0] * cell + 1.5, hover[1] * cell + 1.5, cell - 3, cell - 3);
  }

  for (const e of room.ents) {
    if (e.done && e.k !== 'lore') continue;
    const cx = e.x * cell + cell / 2;
    let cy = e.y * cell + cell / 2;
    let glyph = '?';
    let color = C.text;
    let size = 0.62;
    if (e.k === 'foe') {
      const f = e.foe!;
      glyph = f.rank === 'boss' ? 'Ψ' : f.rank === 'elite' ? 'Ж' : 'ж';
      color = f.rank === 'boss' ? C.red : f.rank === 'elite' ? C.elite : C.text;
      size = f.rank === 'normal' ? 0.62 : 0.78;
      if (f.mods.length) {
        ctx.fillStyle = 'rgba(229, 72, 77, 0.08)';
        ctx.beginPath();
        ctx.arc(cx, cy, cell * 0.42, 0, Math.PI * 2);
        ctx.fill();
      }
      if (f.hp < f.maxHp) {
        ctx.fillStyle = '#3a1218';
        ctx.fillRect(e.x * cell + 4, e.y * cell + cell - 5, cell - 8, 3);
        ctx.fillStyle = '#b8323f';
        ctx.fillRect(e.x * cell + 4, e.y * cell + cell - 5, (cell - 8) * (f.hp / f.maxHp), 3);
      }
    } else if (e.k === 'crate') { glyph = '▣'; color = locked ? C.dim : C.crate; }
    else if (e.k === 'frag') { glyph = '◈'; color = locked ? C.dim : C.cyan; size = 0.7; }
    else if (e.k === 'quest') { glyph = '?'; color = C.green; size = 0.7; }
    else if (e.k === 'lore') { glyph = '!'; color = e.done ? C.dim : C.violet; }
    ctx.fillStyle = color;
    ctx.font = `bold ${cell * size}px ${GLYPH_FONT}`;
    ctx.fillText(glyph, cx, cy + 1);
  }

  // player
  const px = player.x * cell + cell / 2;
  const py = player.y * cell + cell / 2;
  ctx.fillStyle = '#d3d8d7';
  ctx.font = `bold ${cell * 0.7}px ${GLYPH_FONT}`;
  ctx.fillText('@', px, py + 1);
  // small name tag and health line above the player, as on the original's map
  const barW = cell * 1.6;
  ctx.fillStyle = '#6a7171';
  ctx.font = `${Math.max(9, cell * 0.28)}px ${GLYPH_FONT}`;
  ctx.fillText('RUNNER', px, py - cell * 0.78);
  ctx.fillStyle = '#3c0b16';
  ctx.fillRect(px - barW / 2, py - cell * 0.55, barW, 2);
  ctx.fillStyle = '#b8323f';
  ctx.fillRect(px - barW / 2, py - cell * 0.55, barW * hpRatio, 2);

  if (flash > 0) {
    ctx.fillStyle = `rgba(196, 203, 202, ${flash * 0.06})`;
    ctx.fillRect(0, 0, W * cell, H * cell);
  }
}

function Minimap({ d }: { d: Dungeon }) {
  const gx = d.rooms.map((r) => r.gx);
  const gy = d.rooms.map((r) => r.gy);
  const minX = Math.min(...gx);
  const minY = Math.min(...gy);
  const cols = Math.max(...gx) - minX + 1;
  const rows = Math.max(...gy) - minY + 1;
  const known = (r: Room, i: number) => r.visited || Object.values(r.doors).some((j) => j != null && d.rooms[j].visited) || i === d.cur;
  const size = Math.min(26, Math.floor(200 / Math.max(cols, rows)));
  return (
    <div className="ar-minimap" style={{ width: cols * size * 1.5, height: rows * size * 1.5 }} aria-label="미니맵">
      {d.rooms.map((r, i) => {
        if (!known(r, i)) return null;
        const left = (r.gx - minX) * size * 1.5;
        const top = (r.gy - minY) * size * 1.5;
        const cls = ['ar-mm-room', r.visited ? 'is-visited' : '', i === d.cur ? 'is-here' : '', r.visited && r.kind === 'treasure' ? 'is-treasure' : '', r.visited && !liveFoes(r).length ? 'is-clear' : ''].join(' ');
        return (
          <span key={i} className={cls} style={{ left, top, width: size, height: size }} title={r.kind === 'treasure' && r.visited ? '보물방' : undefined}>
            {r.doors.e != null && <i className="ar-mm-link ar-mm-link--h" style={{ left: size, width: size * 0.5, top: size / 2 - 1 }} />}
            {r.doors.s != null && <i className="ar-mm-link ar-mm-link--v" style={{ top: size, height: size * 0.5, left: size / 2 - 1 }} />}
            {r.visited && r.kind === 'treasure' ? '★' : !r.visited ? '?' : ''}
          </span>
        );
      })}
    </div>
  );
}

export function DungeonView({ s, send, busy }: { s: GameState; send: Send; busy: boolean }) {
  const d = s.dungeon!;
  const room = d.rooms[d.cur];
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [cell, setCell] = useState(40);
  const wrapRef = useRef<HTMLDivElement>(null);
  const anim = useRef({ from: { x: d.x, y: d.y }, to: { x: d.x, y: d.y }, at: 0, room: d.cur, flash: 0, foes: liveFoes(room).length });
  const hoverRef = useRef<[number, number] | null>(null);
  const [path, setPath] = useState<[number, number][]>([]);
  const walking = useRef(0);
  const active = !s.combat && !s.modal;
  const hpRatio = Math.max(0, Math.min(1, s.hp / calc(s, s.hpAt).maxHp));

  // keep the tween target in sync with the state
  useEffect(() => {
    const a = anim.current;
    const now = performance.now();
    if (a.room !== d.cur) {
      a.from = { x: d.x, y: d.y };
      a.flash = 0;
    } else {
      const t = Math.min(1, (now - a.at) / 90);
      a.from = { x: a.from.x + (a.to.x - a.from.x) * t, y: a.from.y + (a.to.y - a.from.y) * t };
    }
    a.to = { x: d.x, y: d.y };
    a.at = now;
    a.room = d.cur;
    const foes = liveFoes(d.rooms[d.cur]).length;
    if (a.foes > 0 && foes === 0) a.flash = 1; // room cleared
    a.foes = foes;
  }, [d.x, d.y, d.cur, d]);

  // size the canvas to its box
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setCell(Math.max(22, Math.min(46, Math.floor(el.clientWidth / W)))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // render loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * cell * dpr;
    canvas.height = H * cell * dpr;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    let raf = 0;
    let last = performance.now();
    const loop = (t: number) => {
      const a = anim.current;
      const k = Math.min(1, (t - a.at) / 90);
      const pos = { x: a.from.x + (a.to.x - a.from.x) * k, y: a.from.y + (a.to.y - a.from.y) * k };
      a.flash = Math.max(0, a.flash - (t - last) / 600);
      last = t;
      draw(ctx, d, cell, t, pos, hoverRef.current, path, a.flash, hpRatio);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [d, cell, path, hpRatio]);

  const step = useCallback((dir: Dir) => send([{ t: 'move', dir }]), [send]);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const input = readInput(e, 'dungeon');
      const dir: Dir | null = input === 'up' ? 'n' : input === 'down' ? 's' : input === 'left' ? 'w' : input === 'right' ? 'e' : null;
      if (!dir) return;
      e.preventDefault();
      walking.current++; // a key press cancels a click-walk in progress
      if (!busy) void step(dir);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, busy, step]);

  const cellAt = (e: React.MouseEvent<HTMLCanvasElement>): [number, number] => {
    const r = e.currentTarget.getBoundingClientRect();
    return [Math.floor(((e.clientX - r.left) / r.width) * W), Math.floor(((e.clientY - r.top) / r.height) * H)];
  };

  const onMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const c = cellAt(e);
    const prev = hoverRef.current;
    if (prev && prev[0] === c[0] && prev[1] === c[1]) return;
    hoverRef.current = c;
    const p = active ? pathTo(room, [d.x, d.y], c) : null;
    const pts: [number, number][] = [];
    let x = d.x;
    let y = d.y;
    for (const dir of (p ?? []).slice(0, -1)) {
      x += DELTA[dir][0];
      y += DELTA[dir][1];
      pts.push([x, y]);
    }
    setPath(pts);
  };

  const onClick = async (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!active) return;
    const p = pathTo(room, [d.x, d.y], cellAt(e));
    if (!p?.length) return;
    const id = ++walking.current;
    setPath([]);
    for (const dir of p) {
      if (walking.current !== id) return;
      const ok = await step(dir);
      if (!ok) return;
      await new Promise((r) => setTimeout(r, 70));
    }
  };

  const def = STATIONS[d.station].dungeons[d.idx];
  const visited = d.rooms.filter((r) => r.visited).length;
  const foes = liveFoes(room).length;
  return (
    <div className="ar-dungeon">
      <div className="ar-dungeon-map">
        <header className="ar-dungeon-head">
          <div>
            <h2>{def.name}{d.challenge && <em className="ar-tag ar-tag--red">도전</em>}</h2>
            <p>Lv.{d.level} · {STATIONS[d.station].name} · 방 {visited}/{d.rooms.length}{room.kind === 'treasure' && <em className="ar-tag">보물방</em>}{d.cleared && <em className="ar-tag ar-tag--green">정리 완료</em>}</p>
          </div>
          <p className={foes ? 'ar-room-state is-locked' : 'ar-room-state'}>{foes ? `적 ${foes} · 문 잠김` : '문 열림'}</p>
        </header>
        <div className="ar-canvas-wrap" ref={wrapRef}>
          <canvas
            ref={canvasRef}
            style={{ width: W * cell, height: H * cell }}
            onMouseMove={onMove}
            onMouseLeave={() => { hoverRef.current = null; setPath([]); }}
            onClick={(e) => void onClick(e)}
            aria-label="던전 방. 방향키나 WASD로 움직이고, 칸을 눌러 그 칸으로 걸어갈 수 있다"
          />
        </div>
        <ul className="ar-legend">
          <li><b className="g-me">@</b> 나</li>
          <li><b className="g-foe">ж</b> 적</li>
          <li><b className="g-elite">Ж</b> 정예</li>
          <li><b className="g-boss">Ψ</b> 보스</li>
          <li><b className="g-crate">▣</b> 상자</li>
          <li><b className="g-frag">◈</b> 열쇠 조각</li>
          <li><b className="g-quest">?</b> 의뢰인</li>
          <li><b className="g-lore">!</b> 기록</li>
          <li className="ar-legend-keys"><kbd>WASD</kbd>/<kbd>방향키</kbd> 이동 · 칸 클릭 = 걸어가기 · 적에게 부딪히면 전투</li>
        </ul>
      </div>
      <aside className="ar-dungeon-side">
        <div className="ar-card">
          <h3>지도</h3>
          <Minimap d={d} />
        </div>
        <div className="ar-card">
          <h3>단축칸</h3>
          <ul className="ar-hotbar-list">
            {s.hotbar.map((tier, i) => (
              <li key={i}>
                <kbd>{'QWE'[i]}</kbd>
                {tier == null ? <span className="ar-dim">비어 있음</span> : <span>{HEALS[tier].name} <b>×{stack(s, `heal:${tier}`)}</b></span>}
              </li>
            ))}
          </ul>
          <p className="ar-hint">회복은 던전 전투 중에만. 체력은 던전에서 저절로 차지 않는다.</p>
        </div>
        <div className="ar-card">
          <h3>이번 진입</h3>
          <p>경험치 +{fmt(d.loot.xp)} · ¥{fmt(d.loot.credits)}</p>
          <p className="ar-dim">탄약 {stack(s, 'cells')} · 반물질 {stack(s, 'antimatter')}</p>
        </div>
        <Btn kind="danger" disabled={busy} onClick={() => void send([{ t: 'dungeon.leave' }])}>던전 나가기</Btn>
      </aside>
    </div>
  );
}
