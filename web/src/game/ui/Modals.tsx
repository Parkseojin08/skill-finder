import { useEffect, useRef, useState } from 'react';
import { BUFFS } from '../data.ts';
import { stack, type Dir, type GameState, type Modal } from '../core.ts';
import { readInput } from '../input.ts';
import { Btn, STACK_LABEL, type Send } from './common.tsx';

const ARROW: Record<Dir, string> = { n: '↑', s: '↓', w: '←', e: '→' };

function Frame({ title, children, wide }: { title: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="ar-modal-back">
      <div className={`ar-modal${wide ? ' ar-modal--wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

function Giver({ m, s, send, busy }: { m: Extract<Modal, { kind: 'giver' }>; s: GameState; send: Send; busy: boolean }) {
  const buff = BUFFS.find((b) => b.id === m.buff)!;
  const label = m.want.code.startsWith('heal') ? '진통 패치' : STACK_LABEL[m.want.code];
  const have = stack(s, m.want.code);
  return (
    <Frame title="의뢰">
      <div className="ar-dialog">
        <p>{m.who}이(가) 당신을 보고 말을 건다. {m.line}</p>
        <p>"{label} {m.want.n}개만 구해 줘. 그러면 내 강화 주사를 놔 주지. <b className="ar-accent">{buff.label}</b>, {m.minutes}분짜리야."</p>
        <p className="ar-dim">가진 {label}: {have}개 · 효과: {buff.stat === 'dmg' ? '피해' : buff.stat === 'def' ? '받는 피해 감소' : '실드'} +{buff.pct}%</p>
      </div>
      <div className="ar-modal-actions">
        <Btn kind="primary" disabled={busy || have < m.want.n} onClick={() => void send([{ t: 'giver', accept: true }])}>수락하고 건넨다</Btn>
        <Btn kind="ghost" disabled={busy} onClick={() => void send([{ t: 'giver', accept: false }])}>나중에</Btn>
      </div>
    </Frame>
  );
}

/** Signal sync: enter the arrow sequence before the timer runs out. One wrong key fails the lock. */
function Sync({ m, send, busy }: { m: Extract<Modal, { kind: 'sync' }>; send: Send; busy: boolean }) {
  const [pos, setPos] = useState(0);
  const [failed, setFailed] = useState<string | null>(null);
  const [left, setLeft] = useState(m.limitMs);
  const start = useRef(performance.now());
  const sent = useRef(false);

  useEffect(() => {
    setPos(0);
    setFailed(null);
    setLeft(m.limitMs);
    start.current = performance.now();
    sent.current = false;
  }, [m.seq, m.limitMs]);

  useEffect(() => {
    if (failed || pos >= m.seq.length) return;
    const t = setInterval(() => {
      const rest = m.limitMs - (performance.now() - start.current);
      setLeft(rest);
      if (rest <= 0) setFailed('시간 초과');
    }, 50);
    return () => clearInterval(t);
  }, [failed, pos, m.limitMs, m.seq.length]);

  const press = (dir: Dir) => {
    if (failed || pos >= m.seq.length) return;
    if (dir !== m.seq[pos]) { setFailed('신호 불일치'); return; }
    const next = pos + 1;
    setPos(next);
    if (next === m.seq.length && !sent.current) {
      sent.current = true;
      void send([{ t: 'sync.submit', inputs: m.seq }]);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const input = readInput(e, 'sync');
      const dir: Dir | null = input === 'up' ? 'n' : input === 'down' ? 's' : input === 'left' ? 'w' : input === 'right' ? 'e' : null;
      if (!dir) return;
      e.preventDefault();
      press(dir);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const pct = Math.round((pos / m.seq.length) * 100);
  return (
    <Frame title="잠긴 상자">
      <div className="ar-sync">
        <div className="ar-decrypt-progress"><span>DECRYPTION PROGRESS</span><span>{pos} / {m.seq.length} · {pct}%</span></div>
        <div className="ar-decrypt-ticks"><i style={{ width: `${pct}%` }} /></div>
        <div className="ar-decrypt-head">
          <h3>DECRYPTION</h3>
          <p>신호를 순서대로 입력해 잠금 해제 · 틀리면 실패</p>
        </div>
        <div className="ar-decrypt-timer" aria-live="off"><b>{Math.max(0, Math.ceil(left / 1000))}</b><span>seconds</span></div>
        <div className="ar-sync-seq" aria-live="polite">
          {m.seq.map((d, i) => (
            <span key={i} className={i < pos ? 'is-done' : i === pos ? 'is-now' : i <= pos + 2 ? 'is-next' : 'is-later'}>{ARROW[d]}</span>
          ))}
        </div>
        <div className="ar-decrypt-banner"><span>이 신호를 입력 (방향키·WASD)</span><b>{pos < m.seq.length ? ARROW[m.seq[pos]] : '✓'}</b></div>
        <div className="ar-sync-pad">
          {(['n', 'w', 's', 'e'] as Dir[]).map((d) => (
            <button key={d} type="button" className={`ar-pad ar-pad--${d}`} onClick={() => press(d)} disabled={!!failed} aria-label={ARROW[d]}>{ARROW[d]}</button>
          ))}
        </div>
      </div>
      {failed && (
        <div className="ar-modal-actions">
          <p className="ar-bad">DECRYPTION FAILED — {failed}</p>
          <Btn kind="primary" disabled={busy} onClick={() => void send([{ t: 'sync.retry' }])}>다시 시도</Btn>
          <Btn kind="danger" disabled={busy} onClick={() => void send([{ t: 'sync.abandon' }])}>포기 (상자 파괴)</Btn>
        </div>
      )}
    </Frame>
  );
}

/** ICE cracking: guess a 4-digit code (digits 0–5) in 7 tries. ● right digit and place, ○ right digit only. */
function Ice({ m, send, busy }: { m: Extract<Modal, { kind: 'ice' }>; send: Send; busy: boolean }) {
  const [g, setG] = useState<number[]>([]);
  const submit = () => { if (g.length === 4 && !busy) { void send([{ t: 'ice.guess', g }]); setG([]); } };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (m.done) return;
      if (/^Digit[0-5]$/.test(e.code)) setG((x) => (x.length < 4 ? [...x, Number(e.code.slice(5))] : x));
      else if (e.code === 'Backspace') setG((x) => x.slice(0, -1));
      else if (e.code === 'Enter') submit();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  return (
    <Frame title="ICE 크래킹" wide>
      <p className="ar-dim">0~5 숫자 4개짜리 코드. {m.max}번 안에 맞히세요. <b>●</b> 자리·숫자 모두 맞음, <b>○</b> 숫자만 맞음.</p>
      <table className="ar-ice">
        <tbody>
          {Array.from({ length: m.max }, (_, i) => {
            const row = m.guesses[i];
            const cur = i === m.guesses.length && !m.done;
            const digits = row ? row.g : cur ? g : [];
            return (
              <tr key={i} className={cur ? 'is-now' : ''}>
                <th>{String(i + 1).padStart(2, '0')}</th>
                {[0, 1, 2, 3].map((k) => <td key={k}>{digits[k] ?? '·'}</td>)}
                <td className="ar-ice-fb">{row ? `${'●'.repeat(row.exact)}${'○'.repeat(row.near)}` : ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {m.done ? (
        <div className="ar-modal-actions">
          <p className={m.done === 'won' ? 'ar-good' : 'ar-bad'}>{m.done === 'won' ? 'ACCESS GRANTED' : `ACCESS DENIED — 코드 ${m.code.join('')}`}</p>
          <Btn kind="primary" disabled={busy} onClick={() => void send([{ t: 'modal.close' }])}>닫기</Btn>
        </div>
      ) : (
        <div className="ar-ice-pad">
          {[0, 1, 2, 3, 4, 5].map((d) => (
            <button key={d} type="button" className="ar-pad" disabled={g.length >= 4} onClick={() => setG((x) => [...x, d])}>{d}</button>
          ))}
          <button type="button" className="ar-pad" onClick={() => setG((x) => x.slice(0, -1))} aria-label="지우기">⌫</button>
          <Btn kind="primary" disabled={busy || g.length < 4} onClick={submit}>입력</Btn>
        </div>
      )}
    </Frame>
  );
}

export function ModalView({ s, send, busy }: { s: GameState; send: Send; busy: boolean }) {
  const m = s.modal;
  if (!m) return null;
  if (m.kind === 'giver') return <Giver m={m} s={s} send={send} busy={busy} />;
  if (m.kind === 'sync') return <Sync m={m} send={send} busy={busy} />;
  if (m.kind === 'ice') return <Ice m={m} send={send} busy={busy} />;
  const title = m.kind === 'lore' ? '기록' : m.title;
  const lines = m.kind === 'lore' ? [m.text] : m.lines;
  return (
    <Frame title={title}>
      {lines.map((l, i) => <p key={i} className="ar-dialog">{l}</p>)}
      <div className="ar-modal-actions">
        <Btn kind="primary" disabled={busy} onClick={() => void send([{ t: 'modal.close' }])}>닫기</Btn>
      </div>
    </Frame>
  );
}
