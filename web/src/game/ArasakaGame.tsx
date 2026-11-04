import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './arasaka.css';
import type { Action } from './actions.ts';
import { LocalBackend, type Snapshot } from './backend.ts';
import { buffActive, calc, GameError, hpNow, xpToNext } from './core.ts';
import { BUFFS, COMMS, JOBS, MAX_LEVEL, PLACE_NPC, STATIONS } from './data.ts';
import { Scene } from './ui/Scene.tsx';
import { readInput } from './input.ts';
import { BossKey } from './ui/BossKey.tsx';
import { BagView, CraftView, GearView, QuestsView } from './ui/CharViews.tsx';
import { CityMap, Forge, Gigs, Market, Pharmacy, PLACES, Rail, Raid, Records, Relay, Smith, StreetView, Terminal, type Place } from './ui/CityViews.tsx';
import { CombatView } from './ui/CombatView.tsx';
import { Bar, dur, fmt } from './ui/common.tsx';
import { DungeonView } from './ui/DungeonView.tsx';
import { ModalView } from './ui/Modals.tsx';

type View = 'here' | Place | 'gear' | 'bag' | 'craft' | 'quests';
interface Line { at: number; text: string; tone: string; who?: string }

const NAV: { id: View; label: string; glyph: string }[] = [
  { id: 'gear', label: '장비', glyph: '◧' },
  { id: 'bag', label: '가방', glyph: '▤' },
  { id: 'craft', label: '제작', glyph: '⚗' },
  { id: 'quests', label: '퀘스트', glyph: '◎' },
];

export default function ArasakaGame({ onClose }: { onClose: () => void }) {
  const backend = useMemo(() => new LocalBackend(), []);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const snapRef = useRef<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null);
  const [view, setView] = useState<View>('here');
  const [boss, setBoss] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [comms, setComms] = useState<Line[]>([]);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const offset = -new Date(now).getTimezoneOffset();

  const showToast = useCallback((text: string) => {
    const id = Date.now();
    setToast({ id, text });
    setTimeout(() => setToast((t) => (t?.id === id ? null : t)), 2600);
  }, []);

  /** Sends actions in order; resolves false when the batch was refused (the reason is shown as a toast). */
  const send = useCallback((actions: Action[]): Promise<boolean> => {
    const run = async () => {
      const cur = snapRef.current;
      if (!cur) return false;
      setBusy(true);
      try {
        const next = await backend.send(cur.version, actions);
        snapRef.current = next;
        setSnap(next);
        return true;
      } catch (e) {
        if (e instanceof GameError) {
          showToast(e.message);
          if (e.message.startsWith('다른 창')) {
            const fresh = await backend.load();
            snapRef.current = fresh;
            setSnap(fresh);
          }
        } else {
          console.error(e);
          showToast('알 수 없는 오류가 났습니다');
        }
        return false;
      } finally {
        setBusy(false);
      }
    };
    const p = chain.current.then(run, run);
    chain.current = p;
    return p;
  }, [backend, showToast]);

  useEffect(() => {
    void backend.load().then((s) => {
      snapRef.current = s;
      setSnap(s);
      void send([{ t: 'sync' }]); // count the time spent away
    });
  }, [backend, send]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // NPC chatter: flavour only, never touches the game state
  useEffect(() => {
    const t = setInterval(() => {
      const c = COMMS[Math.floor(Math.random() * COMMS.length)];
      setComms((l) => [...l, { at: Date.now(), text: c.text, tone: 'comms', who: c.who }].slice(-12));
    }, 75_000);
    return () => clearInterval(t);
  }, []);

  const s = snap?.state;
  const loc = s?.loc;
  useEffect(() => { if (loc && loc !== 'town') setView('here'); }, [loc]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const input = readInput(e, 'menu');
      if (input === 'bossKey') { e.preventDefault(); setBoss((b) => !b); }
      if (input === 'close') {
        const cur = snapRef.current?.state;
        if (cur?.combat || cur?.modal) return;
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (boss) return <div className="ar-root"><BossKey onBack={() => setBoss(false)} /></div>;
  if (!s) return <div className="ar-root"><div className="ar ar--loading"><p>접속 중…</p></div></div>;

  const st = calc(s, now);
  const hp = hpNow(s, now);
  const flatlined = (s.flatlineUntil ?? 0) > now;
  const p = { s, send, busy, now, offset };
  const place = PLACES.find((x) => x.id === view);
  const claimable = s.quests.filter((q) => q.have >= q.need).length;
  const where = s.dungeon
    ? `${STATIONS[s.dungeon.station].dungeons[s.dungeon.idx].name}${s.dungeon.challenge ? ' (도전)' : ''}`
    : s.street ? `${STATIONS[s.street.station].name} · ${STATIONS[s.street.station].areas[s.street.area].name}` : '제로 플라자';
  const hereLabel = s.dungeon ? '던전' : s.street ? '길거리' : '도시';

  let screen: React.ReactNode;
  if (view === 'gear') screen = <GearView {...p} />;
  else if (view === 'bag') screen = <BagView {...p} />;
  else if (view === 'craft') screen = <CraftView {...p} />;
  else if (view === 'quests') screen = <QuestsView {...p} />;
  else if (s.dungeon) screen = <DungeonView s={s} send={send} busy={busy} />;
  else if (s.street) screen = <StreetView {...p} />;
  else if (view === 'here' || !place) screen = <CityMap s={s} now={now} offset={offset} go={setView} />;
  else {
    const Comp = { rail: Rail, forge: Forge, smith: Smith, pharm: Pharmacy, terminal: Terminal, gigs: Gigs, market: Market, raid: Raid, relay: Relay, records: Records }[place.id];
    const npc = PLACE_NPC[place.id];
    screen = (
      <>
        <button type="button" className="ar-crumb" onClick={() => setView('here')}>← 제로 플라자</button>
        <Scene key={place.id} title={place.name} tag={npc.tag} npc={npc.npc} lines={npc.lines} hue={npc.hue} glyph={place.glyph} />
        <Comp {...p} />
      </>
    );
  }

  const lines: Line[] = [...s.log.map((l) => ({ ...l })), ...comms].sort((a, b) => a.at - b.at).slice(-40);
  const job = s.job && JOBS.find((j) => j.id === s.job!.id);
  const buffs = buffActive(s, now);

  return (
    <div className="ar-root">
      <div className="ar">
        <header className="ar-top">
          <div className="ar-logo" aria-label="ARASAKA_IN">ARASAKA<b>_IN</b></div>
          <div className="ar-where"><small>위치</small>{where}</div>
          <div className="ar-vitals">
            <div className="ar-lv"><small>LV</small>{s.level}</div>
            <div className="ar-vital-bars">
              <Bar value={hp} max={st.maxHp} kind="hp" label="HP" compact />
              <Bar value={s.level >= MAX_LEVEL ? 1 : s.xp} max={s.level >= MAX_LEVEL ? 1 : xpToNext(s.level)} kind="xp" label="XP" compact />
            </div>
          </div>
          <div className="ar-money"><small>크레딧</small>¥{fmt(s.credits)}</div>
          <div className="ar-buffchips">
            {(s.overclockUntil ?? 0) > now && <span className="ar-chip ar-chip--hot" title="피해 +20%">오버클럭 {dur(s.overclockUntil! - now)}</span>}
            {buffs.map((b) => <span key={b.id} className="ar-chip">{BUFFS.find((x) => x.id === b.id)?.label} {dur(b.until - now)}</span>)}
          </div>
          <button type="button" className="ar-top-btn" onClick={() => setBoss(true)} title="위장 화면 (` 키)">⌨ 위장</button>
          <button type="button" className="ar-top-btn ar-top-close" onClick={onClose} title="닫기 (Esc)" aria-label="게임 닫기">✕</button>
        </header>

        <nav className="ar-nav" aria-label="게임 메뉴">
          <button type="button" className={view === 'here' || (place && !s.dungeon && !s.street) ? 'is-on' : ''} onClick={() => setView('here')}>
            <span aria-hidden>{s.dungeon ? 'Ψ' : s.street ? 'ж' : '⌂'}</span>{hereLabel}
          </button>
          {NAV.map((n) => (
            <button key={n.id} type="button" className={view === n.id ? 'is-on' : ''} onClick={() => setView(n.id)}>
              <span aria-hidden>{n.glyph}</span>{n.label}
              {n.id === 'quests' && claimable > 0 && <em>{claimable}</em>}
            </button>
          ))}
          <div className="ar-nav-foot">
            <kbd>`</kbd> 위장<br /><kbd>Esc</kbd> 닫기
          </div>
        </nav>

        <main className="ar-main">
          {screen}
          {s.combat && <CombatView s={s} send={send} busy={busy} now={now} />}
          {flatlined && !s.combat && (
            <div className="ar-flatline" role="alert">
              <h2>FLATLINE</h2>
              <p>신경 재부팅 중… {dur(s.flatlineUntil! - now)}</p>
            </div>
          )}
        </main>

        <aside className="ar-side">
          {job && s.job && (
            <div className="ar-card">
              <h3>일감 · {job.name}</h3>
              <Bar value={Math.min(now, s.job.endsAt) - s.job.startedAt} max={s.job.endsAt - s.job.startedAt} kind="time" label={now >= s.job.endsAt ? '완료' : dur(s.job.endsAt - now)} compact />
            </div>
          )}
          <div className="ar-card">
            <h3>퀘스트</h3>
            <ul className="ar-mini-quests">
              {s.quests.map((q) => <li key={q.id} className={q.have >= q.need ? 'is-done' : ''}><span>{({ kill: '처치', street: '길거리', dungeon: '던전', print: '인쇄', craft: '제작', crate: '상자', ice: 'ICE' })[q.kind]}</span><b>{q.have}/{q.need}</b></li>)}
            </ul>
          </div>
          <div className="ar-log" aria-live="polite">
            <h3>통신</h3>
            <ol>
              {lines.map((l, i) => (
                <li key={`${l.at}-${i}`} className={`tone-${l.tone}`}>
                  <time>{new Date(l.at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}</time>
                  {l.who && <b>{l.who}</b>}
                  {l.text}
                </li>
              ))}
            </ol>
          </div>
        </aside>

        <ModalView s={s} send={send} busy={busy} />
        {toast && <div className="ar-toast" role="status">{toast.text}</div>}
      </div>
    </div>
  );
}
