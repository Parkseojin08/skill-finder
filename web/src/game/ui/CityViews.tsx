import { useState } from 'react';
import { ENEMY_MODS, HEALS, JOB_DURATIONS, JOBS, RARITIES, RARITY_LABEL, STATIONS } from '../data.ts';
import { cacheCode, calc, fragCode, hpNow, nextReset, skillNeed, stack, type GameState } from '../core.ts';
import {
  antimatterPrice, cellPrice, crewPrice, keyCost, maxPharmTier, overclockCost, PART_PRICE, printCost, printLevel, raidOpen,
} from '../town.ts';
import { Bar, Btn, dur, fmt, itemStats, ItemName, Panel, Rar, type Send } from './common.tsx';
import { Scene } from './Scene.tsx';
import { PLACE_NPC } from '../data.ts';

export type Place = 'rail' | 'forge' | 'smith' | 'pharm' | 'terminal' | 'gigs' | 'market' | 'raid' | 'relay' | 'records';

interface P { s: GameState; send: Send; busy: boolean; now: number; offset: number }

export const PLACES: { id: Place; name: string; glyph: string; desc: string }[] = [
  { id: 'rail', name: '마그레일 역', glyph: '⇶', desc: '구역 이동. 길거리 적과 던전' },
  { id: 'forge', name: '나노 포지', glyph: '⬢', desc: '상자를 장비로 인쇄' },
  { id: 'smith', name: '도크의 무기고', glyph: '⚒', desc: '장비·탄약 구매' },
  { id: 'pharm', name: '펄스 약국', glyph: '✚', desc: '회복제·부품 구매' },
  { id: 'terminal', name: '브루트포스 터미널', glyph: '⌘', desc: '열쇠 합성, ICE 크래킹' },
  { id: 'gigs', name: '긱 보드', glyph: '☰', desc: '자리를 비운 사이 일감' },
  { id: 'market', name: '블랙마켓', glyph: '◐', desc: '매일 09:00 재입고' },
  { id: 'raid', name: '레이드 브리핑', glyph: '☠', desc: '하루 한 번, 용병과 보스 사냥' },
  { id: 'relay', name: '오버클럭 송신탑', glyph: '⌁', desc: '30분 피해·일감 강화' },
  { id: 'records', name: '러너 기록', glyph: '≡', desc: '누적 기록과 최단 시간' },
];

export function CityMap({ s, now, offset, go }: Omit<P, 'send' | 'busy'> & { go: (p: Place) => void }) {
  const badge: Partial<Record<Place, string>> = {
    rail: STATIONS[s.unlocked].name,
    gigs: s.job ? (now >= s.job.endsAt ? '정산 가능' : `${dur(s.job.endsAt - now)} 남음`) : '대기 중',
    market: `재입고 ${dur(nextReset(now, offset) - now)}`,
    raid: raidOpen(s, { now, utcOffsetMin: offset }) ? '오늘 가능' : '내일 09:00',
    terminal: (s.iceUntil ?? 0) > now ? `ICE ${dur(s.iceUntil! - now)}` : 'ICE 가능',
    relay: (s.overclockUntil ?? 0) > now ? `가동 ${dur(s.overclockUntil! - now)}` : '꺼짐',
    forge: `숙련 ${s.skills.printing.lv}`,
  };
  const max = calc(s, now).maxHp;
  return (
    <div className="ar-city">
      <Scene title="Zero Plaza · 제로 플라자" tag={PLACE_NPC.city.tag} lines={PLACE_NPC.city.lines} hue={PLACE_NPC.city.hue}>
        <p className="ar-dim">도시에서는 체력이 빠르게 회복된다 ({fmt(hpNow(s, now))}/{fmt(max)}).</p>
      </Scene>
      <h3 className="ar-section">// 시설</h3>
      <div className="ar-places">
        {PLACES.map((p) => (
          <button key={p.id} type="button" className={`ar-place ar-place--${p.id}`} onClick={() => go(p.id)}>
            <span className="ar-place-glyph" aria-hidden>{p.glyph}</span>
            <span className="ar-place-name">{p.name}</span>
            <span className="ar-place-desc">{p.desc}</span>
            {badge[p.id] && <em className="ar-place-badge">{badge[p.id]}</em>}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Rail({ s, send, busy }: P) {
  const [sel, setSel] = useState(s.unlocked);
  const st = STATIONS[sel];
  const locked = sel > s.unlocked;
  return (
    <Panel title="노선 안내" sub="하이퍼루프 노선. 열쇠를 만들면 다음 구역이 열린다.">
      <div className="ar-tabs" role="tablist">
        {STATIONS.map((x, i) => (
          <button key={x.name} type="button" role="tab" aria-selected={i === sel} className={i === sel ? 'is-on' : ''} onClick={() => setSel(i)}>
            <span>{x.glyph}</span> {x.name} {i > s.unlocked && '🔒'}
          </button>
        ))}
      </div>
      <p className="ar-blurb">{st.blurb} <span className="ar-dim">권장 Lv.{st.areas[0].min}–{st.areas[2].max}</span></p>
      {locked ? (
        <p className="ar-bad">잠긴 노선. {STATIONS[sel - 1].name}의 열쇠 조각 3개를 터미널에서 합치세요.</p>
      ) : (
        <div className="ar-cols">
          <div>
            <h3>길거리</h3>
            <ul className="ar-list">
              {st.areas.map((a, i) => (
                <li key={a.name}>
                  <div><b>{a.name}</b><small>적 Lv.{a.min}–{a.max} · 회복 불가, 도주 100%</small></div>
                  <Btn disabled={busy} onClick={() => void send([{ t: 'street.enter', station: sel, area: i }])}>이동</Btn>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h3>던전</h3>
            <ul className="ar-list">
              {st.dungeons.map((d, i) => {
                const rec = s.records.filter((r) => r.station === sel && r.dungeon === i);
                const have = stack(s, fragCode(sel, i)) > 0;
                return (
                  <li key={d.name}>
                    <div>
                      <b>{d.name}</b>
                      <small>Lv.{d.level} (도전 {d.level + 2}) · 조각 {d.fragment} {have ? '보유' : '없음'}{rec.length ? ` · 최고 ${dur(Math.min(...rec.map((r) => r.bestMs ?? Infinity)))}` : ''}</small>
                    </div>
                    <span className="ar-btn-row">
                      <Btn disabled={busy || s.level < d.level - 6} title={s.level < d.level - 6 ? `Lv.${d.level - 6} 이상` : undefined} onClick={() => void send([{ t: 'dungeon.enter', station: sel, dungeon: i, challenge: false }])}>일반</Btn>
                      <Btn kind="danger" disabled={busy || s.level < d.level - 4} onClick={() => void send([{ t: 'dungeon.enter', station: sel, dungeon: i, challenge: true }])}>도전</Btn>
                    </span>
                  </li>
                );
              })}
            </ul>
            <p className="ar-hint">도전 던전: 적이 더 많고 보스가 있다. 전리품 등급이 오른다.</p>
          </div>
        </div>
      )}
    </Panel>
  );
}

export function StreetView({ s, send, busy, now }: P) {
  const st = s.street!;
  const area = STATIONS[st.station].areas[st.area];
  const max = calc(s, now).maxHp;
  return (
    <>
    <Scene title={area.name} tag={`${STATIONS[st.station].name} · Lv.${area.min}–${area.max}`} lines={PLACE_NPC.street.lines} hue={(PLACE_NPC.street.hue + st.station * 40 + st.area * 12) % 360} glyph={STATIONS[st.station].glyph} />
    <Panel
      title="근처의 적"
      sub="골라서 싸운다. 도주는 항상 성공한다."
      aside={<Btn kind="ghost" disabled={busy} onClick={() => void send([{ t: 'street.leave' }])}>도시로 돌아가기</Btn>}
    >
      <Bar value={hpNow(s, now)} max={max} kind="hp" label="내 체력" />
      <p className="ar-hint">길거리에서는 체력이 천천히 찬다. 도시로 가면 빨리 찬다.</p>
      <ul className="ar-foes">
        {st.foes.map((f, i) => (
          <li key={i} className={f.mods.length ? 'has-mods' : ''}>
            <span className="ar-foe-glyph" aria-hidden>ж</span>
            <div>
              <b>{f.mods.map((m) => ENEMY_MODS[m].label).join(' ')} {f.name}</b>
              <small>Lv.{f.level} · 체력 {fmt(f.hp)}{f.maxShield ? ` · 실드 ${fmt(f.shield)}` : ''}{f.mods.map((m) => ` · ${ENEMY_MODS[m].hint}`).join('')}</small>
            </div>
            <Btn kind="primary" disabled={busy || hpNow(s, now) <= 0} onClick={() => void send([{ t: 'street.fight', idx: i }])}>공격</Btn>
          </li>
        ))}
      </ul>
    </Panel>
    </>
  );
}

export function Forge({ s, send, busy }: P) {
  const sk = s.skills.printing;
  const lvl = printLevel(s);
  const rows = (['weapon', 'armor'] as const).map((kind) => ({ kind, caches: RARITIES.map((r) => ({ r, n: stack(s, cacheCode(kind, r)) })) }));
  return (
    <Panel title="인쇄 대기열" sub={`상자를 장비로 인쇄한다. 인쇄된 장비 레벨 = min(인쇄 숙련도, 내 레벨) = Lv.${lvl}`}>
      <Bar value={sk.xp} max={skillNeed(sk.lv)} kind="xp" label={`인쇄 숙련 ${sk.lv}`} />
      <p className="ar-hint">폐품 상자를 찍고 분해하면 숙련도가 빨리 오른다. 장비 분해: 가방에서.</p>
      <table className="ar-table">
        <thead><tr><th>상자</th>{RARITIES.map((r) => <th key={r}><Rar r={r}>{RARITY_LABEL[r]}</Rar></th>)}</tr></thead>
        <tbody>
          {rows.map(({ kind, caches }) => (
            <tr key={kind}>
              <th>{kind === 'weapon' ? '무기' : '방어구'}</th>
              {caches.map(({ r, n }) => (
                <td key={r}>
                  <div className="ar-cache">
                    <b>×{n}</b>
                    <Btn disabled={busy || n === 0 || s.credits < printCost(s, r)} onClick={() => void send([{ t: 'print', kind, rarity: r }])}>¥{fmt(printCost(s, r))}</Btn>
                  </div>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}

export function Smith({ s, send, busy, now }: P) {
  const offers = s.smith?.offers ?? [];
  const nextHour = (Math.floor(now / 3_600_000) + 1) * 3_600_000;
  return (
    <Panel title="진열대" sub={`"레벨 맞춰서 갖다 놨어. 한 시간마다 물건 바뀐다." — 다음 입고 ${dur(nextHour - now)}`} aside={<Btn kind="ghost" disabled={busy} onClick={() => void send([{ t: 'smith.refresh' }])}>바로 재입고 ¥{fmt(20 * s.level)}</Btn>}>
      <ul className="ar-list">
        {offers.map((o) => o.kind === 'gear' && (
          <li key={o.id} className={o.sold ? 'is-sold' : ''}>
            <div><ItemName it={o.item} /><small>{itemStats(o.item)} · 모듈 칸 {o.item.modSlots}</small></div>
            <Btn kind="primary" disabled={busy || !!o.sold || s.credits < o.price} onClick={() => void send([{ t: 'smith.buy', id: o.id }])}>{o.sold ? '판매됨' : `¥${fmt(o.price)}`}</Btn>
          </li>
        ))}
      </ul>
      <h3>탄약</h3>
      <ul className="ar-list">
        <li><div><b>에너지 탄약 ×10</b><small>특수무기용 · 보유 {stack(s, 'cells')}</small></div><Btn disabled={busy || s.credits < cellPrice(s)} onClick={() => void send([{ t: 'smith.ammo', kind: 'cells' }])}>¥{fmt(cellPrice(s))}</Btn></li>
        <li><div><b>반물질 ×3</b><small>파괴무기용 · 보유 {stack(s, 'antimatter')}</small></div><Btn disabled={busy || s.credits < antimatterPrice(s)} onClick={() => void send([{ t: 'smith.ammo', kind: 'antimatter' }])}>¥{fmt(antimatterPrice(s))}</Btn></li>
      </ul>
    </Panel>
  );
}

export function Pharmacy({ s, send, busy }: P) {
  const top = maxPharmTier(s);
  return (
    <Panel title="약품 진열대" sub="새 구역이 열릴수록 더 좋은 약을 들여온다. 직접 만들면 더 싸다(제작).">
      <ul className="ar-list">
        {HEALS.map((h, t) => (
          <li key={h.name} className={t > top ? 'is-sold' : ''}>
            <div><b>{h.name}</b><small>체력 +{fmt(h.heal)} · 보유 {stack(s, `heal:${t}`)}{t > top ? ' · 아직 입고 전' : ''}</small></div>
            <span className="ar-btn-row">
              <Btn disabled={busy || t > top || s.credits < h.price} onClick={() => void send([{ t: 'pharm.buy', tier: t, n: 1 }])}>×1 ¥{fmt(h.price)}</Btn>
              <Btn disabled={busy || t > top || s.credits < h.price * 5} onClick={() => void send([{ t: 'pharm.buy', tier: t, n: 5 }])}>×5 ¥{fmt(h.price * 5)}</Btn>
            </span>
          </li>
        ))}
        {(['med', 'ammoparts'] as const).map((code) => (
          <li key={code}>
            <div><b>{code === 'med' ? '의료 부품' : '탄약 부품'} ×5</b><small>제작 재료 · 보유 {stack(s, code)}</small></div>
            <Btn disabled={busy || s.credits < PART_PRICE[code] * 5} onClick={() => void send([{ t: 'pharm.parts', code }])}>¥{fmt(PART_PRICE[code] * 5)}</Btn>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

export function Terminal({ s, send, busy, now }: P) {
  const st = s.unlocked;
  const canForge = st < STATIONS.length - 1;
  const cool = (s.iceUntil ?? 0) - now;
  return (
    <Panel title="단말 접속" sub="열쇠 조각을 합쳐 다음 노선을 연다. 남는 시간엔 ICE를 깬다.">
      <div className="ar-cols">
        <div className="ar-card">
          <h3>비밀 열쇠</h3>
          {canForge ? (
            <>
              <p>{STATIONS[st].name} → <b className="ar-accent">{STATIONS[st + 1].name}</b></p>
              <ul className="ar-frags">
                {STATIONS[st].dungeons.map((d, i) => (
                  <li key={d.name} className={stack(s, fragCode(st, i)) ? 'is-have' : ''}><b>{d.fragment}</b><small>{d.name}</small></li>
                ))}
              </ul>
              <Btn kind="primary" disabled={busy || [0, 1, 2].some((i) => !stack(s, fragCode(st, i))) || s.credits < keyCost(st)} onClick={() => void send([{ t: 'key.forge', station: st }])}>
                합성 ¥{fmt(keyCost(st))}
              </Btn>
            </>
          ) : <p>모든 노선이 열렸다.</p>}
        </div>
        <div className="ar-card">
          <h3>ICE 크래킹</h3>
          <p>4자리 코드를 7번 안에 맞히면 크레딧과 부품. 3분마다 한 판.</p>
          <Btn kind="primary" disabled={busy || cool > 0} onClick={() => void send([{ t: 'ice.start' }])}>{cool > 0 ? `재정렬 ${dur(cool)}` : '접속'}</Btn>
        </div>
      </div>
    </Panel>
  );
}

export function Gigs({ s, send, busy, now }: P) {
  const [mins, setMins] = useState(60);
  const job = s.job;
  if (job) {
    const def = JOBS.find((j) => j.id === job.id)!;
    const done = now >= job.endsAt;
    return (
      <Panel title="일감" sub="게임을 닫아 둬도 시간은 흐른다.">
        <div className="ar-card">
          <h3>{def.name}</h3>
          <p>{def.desc}</p>
          <Bar value={Math.min(now, job.endsAt) - job.startedAt} max={job.endsAt - job.startedAt} kind="time" label={done ? '완료' : `${dur(job.endsAt - now)} 남음`} />
          <Btn kind={done ? 'primary' : 'ghost'} disabled={busy} onClick={() => void send([{ t: 'job.claim' }])}>{done ? '정산' : '지금까지만 정산하고 그만두기'}</Btn>
        </div>
      </Panel>
    );
  }
  return (
    <Panel title="일감" sub={`한 번에 하나. 오버클럭 중에 정산하면 ×1.5.`} aside={
      <div className="ar-seg" role="radiogroup" aria-label="시간">
        {JOB_DURATIONS.map((m) => <button key={m} type="button" role="radio" aria-checked={m === mins} className={m === mins ? 'is-on' : ''} onClick={() => setMins(m)}>{m >= 60 ? `${m / 60}시간` : `${m}분`}</button>)}
      </div>
    }>
      <ul className="ar-list">
        {JOBS.map((j) => (
          <li key={j.id}>
            <div><b>{j.name}</b><small>{j.desc}</small></div>
            <Btn kind="primary" disabled={busy} onClick={() => void send([{ t: 'job.start', id: j.id, minutes: mins }])}>시작</Btn>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

export function Market({ s, send, busy, now, offset }: P) {
  const m = s.market;
  return (
    <Panel title="오늘의 물건" sub={`매일 09:00(내 시간대) 재입고. 그때 내 레벨에 맞춘 물건. 품목마다 하나뿐. 다음 재입고 ${dur(nextReset(now, offset) - now)}`}>
      {!m ? <p>문이 닫혀 있다.</p> : (
        <ul className="ar-list">
          {m.offers.map((o) => (
            <li key={o.id} className={o.sold ? 'is-sold' : ''}>
              {o.kind === 'gear'
                ? <div><ItemName it={o.item} /><small>{itemStats(o.item)} · 모듈 칸 {o.item.modSlots}</small></div>
                : <div><b>{o.label}</b><small>오늘 한정</small></div>}
              <Btn kind="primary" disabled={busy || !!o.sold || s.credits < o.price} onClick={() => void send([{ t: 'market.buy', id: o.id }])}>{o.sold ? '판매됨' : `¥${fmt(o.price)}`}</Btn>
            </li>
          ))}
        </ul>
      )}
      <p className="ar-hint">Lv.{m?.level ?? s.level} 기준 재고. 레벨이 올라도 다음 09:00까지 그대로.</p>
    </Panel>
  );
}

export function Raid({ s, send, busy, now, offset }: P) {
  const open = raidOpen(s, { now, utcOffsetMin: offset });
  const odds = ['혼자: 거의 불가능', '1명: 반반보다 낮음', '2명: 대체로 승리'];
  return (
    <Panel title="출격 편성" sub="원래는 여럿이 잡는 보스. 대신 용병을 고용한다. 하루 한 번(09:00 초기화).">
      {!open ? <p className="ar-dim">오늘의 레이드는 끝났다. 다음: {dur(nextReset(now, offset) - now)} 뒤.</p> : (
        <ul className="ar-list">
          {[0, 1, 2].map((n) => (
            <li key={n}>
              <div><b>용병 {n}명</b><small>{odds[n]} · 용병은 내 턴 뒤에 공격하고, 보스는 무작위로 한 명을 노린다</small></div>
              <Btn kind={n === 2 ? 'primary' : 'normal'} disabled={busy || s.credits < n * crewPrice(s)} onClick={() => void send([{ t: 'raid.start', crew: n }])}>{n ? `¥${fmt(n * crewPrice(s))}` : '무료'} 출격</Btn>
            </li>
          ))}
        </ul>
      )}
      <p className="ar-hint">승리: ¥{fmt(120 * s.level)}, 큰 경험치, 고급 이상 상자 2개, 희귀 이상 장비. 레이드에서는 회복제를 쓸 수 있다.</p>
    </Panel>
  );
}

export function Relay({ s, send, busy, now }: P) {
  const on = (s.overclockUntil ?? 0) > now;
  return (
    <Panel title="출력 제어" sub="원작의 서버 전체 버프를 혼자 쓰는 방식으로 바꿨다.">
      <p>30분 동안 피해 +20%, 그 사이 정산한 일감 보상 ×1.5. 켜져 있을 때 사면 30분 연장.</p>
      {on && <p className="ar-good">가동 중 · {dur(s.overclockUntil! - now)} 남음</p>}
      <Btn kind="primary" disabled={busy || s.credits < overclockCost(s)} onClick={() => void send([{ t: 'overclock' }])}>가동 ¥{fmt(overclockCost(s))}</Btn>
    </Panel>
  );
}

export function Records({ s }: P) {
  const t = s.stats;
  const rows: [string, number][] = [
    ['처치', t.kills], ['보스 처치', t.bossKills], ['플랫라인', t.deaths], ['던전 정리', t.dungeonClears], ['도전 던전 정리', t.challengeClears],
    ['레이드 승리', t.raidWins], ['레이드 시도', t.raidAttempts], ['연 상자', t.cratesOpened], ['인쇄', t.itemsPrinted], ['ICE 돌파', t.iceCracked],
  ];
  return (
    <Panel title="러너 기록" sub="온라인 랭킹이 열리면 이 기록이 서버 기록이 된다.">
      <div className="ar-cols">
        <dl className="ar-stats">
          <div><dt>누적 경험치</dt><dd>{fmt(s.totalXp)}</dd></div>
          {rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{fmt(v)}</dd></div>)}
        </dl>
        <div>
          <h3>던전 최단 기록</h3>
          {s.records.length === 0 ? <p className="ar-dim">아직 정리한 던전이 없다.</p> : (
            <ul className="ar-list">
              {[...s.records].sort((a, b) => a.station - b.station || a.dungeon - b.dungeon).map((r) => (
                <li key={`${r.station}-${r.dungeon}-${r.challenge}`}>
                  <div><b>{STATIONS[r.station].dungeons[r.dungeon].name}{r.challenge ? ' (도전)' : ''}</b><small>{r.clears}회 정리</small></div>
                  <b>{r.bestMs ? dur(r.bestMs) : '—'}</b>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Panel>
  );
}
