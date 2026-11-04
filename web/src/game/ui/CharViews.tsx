import { useState } from 'react';
import { BUFFS, HEALS, RARITIES, RARITY_LABEL, SLOT_LABEL, SLOTS, STATIONS, WEAPON_SLOTS } from '../data.ts';
import { bagCount, buffActive, calc, QUEST_LABEL, sellPrice, skillNeed, stack, type GameState, type Item } from '../core.ts';
import { moduleCost } from '../town.ts';
import { Bar, Btn, dur, fmt, itemStats, ItemName, Panel, Rar, STACK_LABEL, statText, type Send } from './common.tsx';

interface P { s: GameState; send: Send; busy: boolean; now: number }

const modsOf = (s: GameState, gear: Item) => s.items.filter((m) => m.installedIn === gear.id);

function ModChips({ s, gear, send, busy }: { s: GameState; gear: Item; send: Send; busy: boolean }) {
  const mods = modsOf(s, gear);
  return (
    <div className="ar-mods">
      {Array.from({ length: gear.modSlots }, (_, i) => {
        const m = mods[i];
        return m ? (
          <button key={m.id} type="button" className={`ar-mod rar-${m.rarity}`} disabled={busy} onClick={() => void send([{ t: 'mod.remove', mod: m.id }])} title="눌러서 빼기">
            {statText(m.stat!, m.main)} ✕
          </button>
        ) : <span key={i} className="ar-mod is-empty">빈 모듈 칸</span>;
      })}
    </div>
  );
}

export function GearView({ s, send, busy, now }: P) {
  const st = calc(s, now);
  const worn = (slot: string) => s.items.find((i) => i.equipped && i.slot === slot);
  const stats: [string, string][] = [
    ['최대 체력', fmt(st.maxHp)], ['실드', fmt(st.maxShield)], ['방어', String(st.armor)], ['치명타', `${st.crit.toFixed(1)}%`],
    ['치명 피해', `${st.critDmg.toFixed(0)}%`], ['회피', `${st.evade.toFixed(1)}%`], ['도주', `${st.escape.toFixed(0)}%`],
    ['기절', `${st.stun.toFixed(1)}%`], ['재생/턴', fmt(st.regen)], ['피해 보너스', `${st.dmgPct.toFixed(0)}%`], ['받는 피해 감소', `${st.defPct}%`],
  ];
  return (
    <div className="ar-split">
      <Panel title="장비" sub="장비 레벨이 내 레벨보다 높으면 장착할 수 없다. 모듈은 가방에서 끼운다.">
        <div className="ar-doll">
          {SLOTS.map((slot) => {
            const it = worn(slot);
            return (
              <div key={slot} className={`ar-slot${it ? ` rar-edge-${it.rarity}` : ' is-empty'}`}>
                <span className="ar-slot-label">{SLOT_LABEL[slot]}</span>
                {it ? (
                  <>
                    <ItemName it={it} />
                    <small>{itemStats(it)}</small>
                    <ModChips s={s} gear={it} send={send} busy={busy} />
                    <Btn kind="ghost" disabled={busy || !!s.combat} onClick={() => void send([{ t: 'unequip', id: it.id }])}>해제</Btn>
                  </>
                ) : <span className="ar-dim">{WEAPON_SLOTS.includes(slot) ? (slot === 'primary' ? '맨손' : '없음 — 무기고나 포지에서') : '없음'}</span>}
              </div>
            );
          })}
        </div>
      </Panel>
      <div className="ar-stack">
        <Panel title="능력치">
          <div className="ar-weapon-line">
            <span>주무기 <b>{fmt(st.dmg.primary)}</b></span>
            <span>특수 <b>{fmt(st.dmg.special)}</b></span>
            <span>파괴 <b>{fmt(st.dmg.destructive)}</b></span>
          </div>
          <dl className="ar-stats">{stats.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
        </Panel>
        <Panel title="숙련도·버프">
          {(['printing', 'medical', 'ammo'] as const).map((k) => (
            <Bar key={k} value={s.skills[k].xp} max={skillNeed(s.skills[k].lv)} kind="xp" label={`${k === 'printing' ? '인쇄' : k === 'medical' ? '의료' : '탄약'} ${s.skills[k].lv}`} />
          ))}
          <ul className="ar-buffs">
            {(s.overclockUntil ?? 0) > now && <li>오버클럭 · {dur(s.overclockUntil! - now)}</li>}
            {buffActive(s, now).map((b) => <li key={b.id}>{BUFFS.find((x) => x.id === b.id)?.label} · {dur(b.until - now)}</li>)}
            {!buffActive(s, now).length && !((s.overclockUntil ?? 0) > now) && <li className="ar-dim">적용 중인 버프 없음</li>}
          </ul>
        </Panel>
        <Panel title="단축칸 (Q · W · E)" sub="던전·레이드 전투에서 쓸 회복제">
          <div className="ar-hotbar-set">
            {s.hotbar.map((tier, i) => (
              <label key={i}>
                <kbd>{'QWE'[i]}</kbd>
                <select value={tier ?? ''} disabled={busy} onChange={(e) => void send([{ t: 'hotbar', slot: i, tier: e.target.value === '' ? null : Number(e.target.value) }])}>
                  <option value="">비우기</option>
                  {HEALS.map((h, t) => <option key={h.name} value={t}>{h.name} ({stack(s, `heal:${t}`)})</option>)}
                </select>
              </label>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}

type Filter = 'all' | 'weapon' | 'armor' | 'module';

function ModuleFit({ s, m, send, busy }: { s: GameState; m: Item; send: Send; busy: boolean }) {
  const targets = s.items.filter((g) => g.kind === 'gear' && g.level >= m.level && modsOf(s, g).length < g.modSlots);
  const [gear, setGear] = useState('');
  if (!targets.length) return <small className="ar-dim">끼울 수 있는 장비 없음</small>;
  return (
    <span className="ar-btn-row">
      <select value={gear} onChange={(e) => setGear(e.target.value)} aria-label="모듈을 끼울 장비">
        <option value="">장비 선택</option>
        {targets.map((g) => <option key={g.id} value={g.id}>{g.equipped ? '[장착] ' : ''}{g.name} Lv.{g.level}</option>)}
      </select>
      <Btn disabled={busy || !gear} onClick={() => void send([{ t: 'mod.install', mod: m.id, gear }])}>끼우기</Btn>
    </span>
  );
}

export function BagView({ s, send, busy }: P) {
  const [filter, setFilter] = useState<Filter>('all');
  const inBag = s.items.filter((i) => !i.equipped && !i.installedIn);
  const shown = inBag
    .filter((i) => filter === 'all' || (filter === 'module' ? i.kind === 'module' : i.kind === 'gear' && (WEAPON_SLOTS.includes(i.slot!) ? filter === 'weapon' : filter === 'armor')))
    .sort((a, b) => b.level - a.level || RARITIES.indexOf(b.rarity) - RARITIES.indexOf(a.rarity));
  const inDungeon = !!s.dungeon;
  const stacks = Object.entries(s.stacks).sort(([a], [b]) => a.localeCompare(b));
  const label = (code: string) => {
    if (STACK_LABEL[code]) return STACK_LABEL[code];
    const [kind, a, b] = code.split(':');
    if (kind === 'heal') return HEALS[Number(a)].name;
    if (kind === 'cache') return <><Rar r={b as Item['rarity']}>{RARITY_LABEL[b as Item['rarity']]}</Rar> {a === 'weapon' ? '무기' : '방어구'} 상자</>;
    if (kind === 'frag') return `열쇠 조각 ${STATIONS[Number(a)].dungeons[Number(b)].fragment} (${STATIONS[Number(a)].name})`;
    return code;
  };
  return (
    <div className="ar-split">
      <Panel title={`가방 ${bagCount(s)}/${s.bagCap}`} sub={inDungeon ? '던전 안에서는 팔거나 분해할 수 없다.' : '가방이 가득 차면 새로 얻은 장비는 고철이 된다.'} aside={
        <div className="ar-seg" role="radiogroup" aria-label="분류">
          {(['all', 'weapon', 'armor', 'module'] as Filter[]).map((f) => <button key={f} type="button" role="radio" aria-checked={f === filter} className={f === filter ? 'is-on' : ''} onClick={() => setFilter(f)}>{{ all: '전체', weapon: '무기', armor: '방어구', module: '모듈' }[f]}</button>)}
        </div>
      }>
        {shown.length === 0 ? <p className="ar-dim">비어 있다.</p> : (
          <ul className="ar-list">
            {shown.map((it) => (
              <li key={it.id}>
                <div><ItemName it={it} /><small>{itemStats(it)}{it.kind === 'gear' ? ` · 모듈 칸 ${it.modSlots}` : ''}</small></div>
                <span className="ar-btn-row">
                  {it.kind === 'gear'
                    ? <Btn kind="primary" disabled={busy || it.level > s.level || !!s.combat} title={it.level > s.level ? `Lv.${it.level} 필요` : undefined} onClick={() => void send([{ t: 'equip', id: it.id }])}>장착</Btn>
                    : <ModuleFit s={s} m={it} send={send} busy={busy} />}
                  <Btn disabled={busy || inDungeon} onClick={() => void send([{ t: 'sell', id: it.id }])}>판매 ¥{fmt(sellPrice(it))}</Btn>
                  <Btn kind="ghost" disabled={busy || inDungeon} onClick={() => void send([{ t: 'scrap', id: it.id }])}>분해</Btn>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Panel title="소지품" sub="칸을 차지하지 않는다">
        <ul className="ar-stacks">
          <li><span>크레딧</span><b>¥{fmt(s.credits)}</b></li>
          {stacks.map(([code, n]) => <li key={code}><span>{label(code)}</span><b>{fmt(n)}</b></li>)}
        </ul>
      </Panel>
    </div>
  );
}

export function CraftView({ s, send, busy }: P) {
  const med = s.skills.medical;
  const ammo = s.skills.ammo;
  return (
    <div className="ar-split">
      <Panel title="의료 제작" sub="의료 부품으로 회복제를 만든다. 숙련도가 오르면 상위 약이 열린다.">
        <Bar value={med.xp} max={skillNeed(med.lv)} kind="xp" label={`의료 숙련 ${med.lv}`} />
        <ul className="ar-list">
          {HEALS.map((h, t) => (
            <li key={h.name} className={med.lv < h.med ? 'is-sold' : ''}>
              <div><b>{h.name}</b><small>체력 +{fmt(h.heal)} · 의료 부품 {h.parts} · 숙련 {h.med} 필요 · 보유 {stack(s, `heal:${t}`)}</small></div>
              <Btn disabled={busy || med.lv < h.med || stack(s, 'med') < h.parts} onClick={() => void send([{ t: 'craft', recipe: 'heal', tier: t }])}>제작</Btn>
            </li>
          ))}
        </ul>
        <p className="ar-hint">의료 부품 {stack(s, 'med')}개 보유</p>
      </Panel>
      <Panel title="탄약·모듈" sub="탄약 숙련도가 오르면 같은 재료로 더 많이 만든다.">
        <Bar value={ammo.xp} max={skillNeed(ammo.lv)} kind="xp" label={`탄약 숙련 ${ammo.lv}`} />
        <ul className="ar-list">
          <li><div><b>에너지 탄약 ×{3 + Math.floor(ammo.lv / 8)}</b><small>탄약 부품 1</small></div><Btn disabled={busy || stack(s, 'ammoparts') < 1} onClick={() => void send([{ t: 'craft', recipe: 'cells', tier: 0 }])}>제작</Btn></li>
          <li><div><b>반물질 ×{1 + Math.floor(ammo.lv / 15)}</b><small>탄약 부품 3 + 고철 1</small></div><Btn disabled={busy || stack(s, 'ammoparts') < 3 || stack(s, 'scrap') < 1} onClick={() => void send([{ t: 'craft', recipe: 'antimatter', tier: 0 }])}>제작</Btn></li>
          <li><div><b>모듈 조립 (Lv.{s.level})</b><small>고철 12 + ¥{fmt(moduleCost(s))} · 능력치 하나, 등급 무작위</small></div><Btn disabled={busy || stack(s, 'scrap') < 12 || s.credits < moduleCost(s)} onClick={() => void send([{ t: 'craft', recipe: 'module', tier: 0 }])}>조립</Btn></li>
        </ul>
        <p className="ar-hint">탄약 부품 {stack(s, 'ammoparts')} · 고철 {stack(s, 'scrap')}</p>
      </Panel>
    </div>
  );
}

export function QuestsView({ s, send, busy }: P) {
  return (
    <Panel title="퀘스트" sub="끝내면 바로 다음 의뢰가 들어온다.">
      <ul className="ar-quests">
        {s.quests.map((q) => {
          const done = q.have >= q.need;
          return (
            <li key={q.id} className={done ? 'is-done' : ''}>
              <div>
                <b>{QUEST_LABEL[q.kind]} {q.need}{q.kind === 'dungeon' || q.kind === 'ice' ? '회' : '개'}</b>
                <small>보상 ¥{fmt(q.credits)} · 경험치 {fmt(q.xp)}</small>
                <Bar value={q.have} max={q.need} kind="xp" compact />
              </div>
              <Btn kind="primary" disabled={busy || !done} onClick={() => void send([{ t: 'quest.claim', id: q.id }])}>보상 받기</Btn>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
