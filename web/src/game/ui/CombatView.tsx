import { useEffect, useRef, useState } from 'react';
import { ENEMY_MODS, HEALS } from '../data.ts';
import { calc, stack, type Combat, type CombatEvent, type GameState } from '../core.ts';
import { WEAPON_AMMO, type Weapon } from '../combat.ts';
import { readInput } from '../input.ts';
import { Bar, fmt, type Send } from './common.tsx';

const STEP_MS = 320;
const WEAPONS: { w: Weapon; label: string; key: string; note: string }[] = [
  { w: 'primary', label: 'PRIMARY', key: '1', note: '탄약 없음' },
  { w: 'special', label: 'SPECIAL', key: '2', note: '실드에 강함' },
  { w: 'destructive', label: 'DESTRUCT.', key: '3', note: '실드에 약함' },
];

interface Shown { foeHp: number; foeShield: number; hp: number; shield: number; allies: number[] }
interface Floater { id: number; target: 'player' | 'foe' | number; text: string; kind: 'dmg' | 'crit' | 'heal' | 'miss' }

const snapshot = (s: GameState, c: Combat): Shown => ({ foeHp: c.foe.hp, foeShield: c.foe.shield, hp: s.hp, shield: c.shield, allies: c.allies.map((a) => a.hp) });

export function CombatView({ s, send, busy, now }: { s: GameState; send: Send; busy: boolean; now: number }) {
  const c = s.combat!;
  const st = calc(s, now);
  const [shown, setShown] = useState<Shown>(() => snapshot(s, c));
  const [lines, setLines] = useState<string[]>(() => c.events.map((e) => e.text));
  const [playing, setPlaying] = useState(false);
  const [floaters, setFloaters] = useState<Floater[]>([]);
  const [shake, setShake] = useState<'player' | 'foe' | null>(null);
  const lastTurn = useRef(c.turn);
  const floaterId = useRef(0);
  const latest = useRef({ s, c });
  latest.current = { s, c };

  // play back the events of each new turn (keyed on the turn only, so unrelated re-renders never cut it short)
  useEffect(() => {
    const { s: cur, c: fight } = latest.current;
    if (fight.turn === lastTurn.current) return;
    lastTurn.current = fight.turn;
    const events = fight.events;
    const final = snapshot(cur, fight);
    let i = 0;
    setPlaying(true);
    const apply = (e: CombatEvent) => {
      setLines((l) => [...l, e.text].slice(-7));
      if (e.target == null) return;
      setShown((p) => {
        const n = { ...p, allies: [...p.allies] };
        if (e.target === 'foe') { n.foeHp = e.hp ?? n.foeHp; n.foeShield = e.shield ?? n.foeShield; }
        else if (e.target === 'player') { n.hp = e.hp ?? n.hp; n.shield = e.shield ?? n.shield; }
        else if (typeof e.target === 'number') n.allies[e.target] = e.hp ?? n.allies[e.target];
        return n;
      });
      if (e.dmg || e.heal || e.miss) {
        const id = ++floaterId.current;
        const kind: Floater['kind'] = e.miss ? 'miss' : e.heal ? 'heal' : e.crit ? 'crit' : 'dmg';
        const text = e.miss ? 'MISS' : e.heal ? `+${fmt(e.heal)}` : `-${fmt(e.dmg!)}`;
        setFloaters((f) => [...f, { id, target: e.target!, text, kind }]);
        setTimeout(() => setFloaters((f) => f.filter((x) => x.id !== id)), 900);
        if (e.dmg && (e.target === 'player' || e.target === 'foe')) {
          setShake(e.target);
          setTimeout(() => setShake(null), 220);
        }
      }
    };
    const timer = setInterval(() => {
      if (i < events.length) apply(events[i++]);
      if (i >= events.length) {
        clearInterval(timer);
        setTimeout(() => { setShown(final); setPlaying(false); }, 120);
      }
    }, STEP_MS);
    if (events.length) apply(events[i++]);
    return () => clearInterval(timer);
  }, [c.turn]);

  const over = !!c.result && !playing;
  const canAct = !busy && !playing && !c.result;
  const act = (a: Parameters<Send>[0][number]) => { if (canAct) void send([a]); };
  const fire = (w: Weapon) => act({ t: 'attack', w });
  const useItem = (slot: number) => act({ t: 'useItem', slot });
  const flee = () => act({ t: 'escape' });
  const close = () => { if (over && !busy) void send([{ t: 'combat.close' }]); };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const input = readInput(e, 'combat');
      if (!input) return;
      const map: Record<string, () => void> = {
        weapon1: () => fire('primary'), weapon2: () => fire('special'), weapon3: () => fire('destructive'),
        item1: () => useItem(0), item2: () => useItem(1), item3: () => useItem(2), escape: flee, confirm: close,
      };
      const fn = map[input];
      if (fn) { e.preventDefault(); fn(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const f = c.foe;
  const escapeChance = c.where === 'street' ? 100 : Math.round(st.escape);
  const floatersFor = (t: Floater['target']) => floaters.filter((x) => x.target === t).map((x) => <b key={x.id} className={`ar-float ar-float--${x.kind}`}>{x.text}</b>);
  const whereLabel = c.where === 'street' ? '길거리 전투' : c.where === 'raid' ? '레이드' : '던전 전투';

  return (
    <div className="ar-combat" role="dialog" aria-label={`${f.name}과의 전투`}>
      <div className="ar-combat-top">
        <button type="button" className="ar-escape" onClick={flee} disabled={!canAct} title="도주 (X)">
          <kbd>X</kbd> 도주 {escapeChance}%
        </button>
        <span className="ar-dim">{whereLabel} · {c.turn}턴</span>
      </div>

      <div className={`ar-fighter ar-fighter--foe${shake === 'foe' ? ' is-hit' : ''}${f.rank !== 'normal' ? ` is-${f.rank}` : ''}`}>
        <div className="ar-fighter-name">
          <h2>Lv.{f.level} {f.mods.map((m) => ENEMY_MODS[m].label).join(' ')} {f.name}</h2>
          {f.rank !== 'normal' && <em className="ar-tag ar-tag--red">{f.rank === 'boss' ? 'BOSS' : '정예'}</em>}
          {f.mods.map((m) => <em key={m} className="ar-tag" title={ENEMY_MODS[m].hint}>{ENEMY_MODS[m].label}: {ENEMY_MODS[m].hint}</em>)}
        </div>
        <Bar value={shown.foeHp} max={f.maxHp} kind="hp" label="체력" />
        {f.maxShield > 0 && <Bar value={shown.foeShield} max={f.maxShield} kind="shield" label="실드" />}
        <div className="ar-floats">{floatersFor('foe')}</div>
      </div>

      {c.allies.length > 0 && (
        <div className="ar-allies">
          {c.allies.map((a, i) => (
            <div key={a.name} className={`ar-ally${shown.allies[i] <= 0 ? ' is-down' : ''}`}>
              <span>{a.name}</span>
              <Bar value={shown.allies[i] ?? a.hp} max={a.maxHp} kind="ally" compact />
              <div className="ar-floats">{floatersFor(i)}</div>
            </div>
          ))}
        </div>
      )}

      <div className={`ar-fighter ar-fighter--me${shake === 'player' ? ' is-hit' : ''}`}>
        <div className="ar-fighter-name"><h2>러너</h2></div>
        <Bar value={shown.hp} max={st.maxHp} kind="hp" label="체력" />
        {c.maxShield > 0 && <Bar value={shown.shield} max={c.maxShield} kind="shield" label="실드" />}
        <div className="ar-floats">{floatersFor('player')}</div>
      </div>

      <ol className="ar-combat-log" aria-live="polite">
        {lines.slice(-6).map((l, i) => <li key={`${c.turn}-${i}-${l}`}>{l}</li>)}
      </ol>

      {over ? (
        <div className={`ar-result ar-result--${c.result}`}>
          <h2>{c.result === 'win' ? 'TARGET DOWN' : c.result === 'lose' ? 'FLATLINE' : 'DISENGAGED'}</h2>
          <ul>{c.rewards.map((r, i) => <li key={i}>{r}</li>)}</ul>
          <button type="button" className="ar-btn ar-btn--primary" onClick={close} disabled={busy} autoFocus><kbd>Enter</kbd> 계속</button>
        </div>
      ) : (
        <>
          <div className="ar-items">
            {s.hotbar.map((tier, i) => {
              const n = tier == null ? 0 : stack(s, `heal:${tier}`);
              const off = c.where === 'street' || tier == null || n === 0;
              return (
                <button key={i} type="button" className="ar-item-slot" disabled={!canAct || off} onClick={() => useItem(i)} title={c.where === 'street' ? '길거리 전투에서는 아이템을 쓸 수 없다' : undefined}>
                  <kbd>{'QWE'[i]}</kbd>
                  <span>{tier == null ? '빈 칸' : HEALS[tier].name}</span>
                  {tier != null && <small>+{fmt(HEALS[tier].heal)} · [{n}]</small>}
                </button>
              );
            })}
          </div>
          <div className="ar-weapons">
            {WEAPONS.map(({ w, label, key, note }) => {
              const ammo = WEAPON_AMMO[w];
              const left = ammo ? stack(s, ammo.code) : null;
              const dmg = st.dmg[w];
              const off = dmg <= 0 || (left != null && left <= 0);
              return (
                <button key={w} type="button" className={`ar-weapon ar-weapon--${w}`} disabled={!canAct || off} onClick={() => fire(w)}>
                  <span className="ar-weapon-tab">{label}</span>
                  <kbd>{key}</kbd>
                  <span className="ar-weapon-dmg">{dmg > 0 ? `DMG ${fmt(dmg)}` : '장착 안 함'}</span>
                  <span className="ar-weapon-ammo">{left == null ? '∞' : fmt(left)}</span>
                  <small>{ammo ? `${ammo.label} · ${note}` : note}</small>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
