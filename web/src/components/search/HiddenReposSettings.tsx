import { useState } from 'react';
import { t } from '../../i18n.ts';
import { removeOwnerPref, saveOwnerPref, useOwnerPrefs, type OwnerPref } from '../../lib/ownerPrefs.ts';
import './owner-prefs.css';

const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const OWNER = /^[A-Za-z0-9-]{1,39}$/;

/**
 * The settings page's list of hidden repositories and trusted owners (F20, feature review 2026-11-04; user decision
 * 18). Stored on this PC's server; each row can be taken back, and a repo (`owner/repo`) or a whole owner can be
 * added by name. Its own `<section>`, to be placed among the settings page's.
 */
export function HiddenReposSettings() {
  const prefs = useOwnerPrefs();
  const [name, setName] = useState('');
  const [pref, setPref] = useState<'hide' | 'trust'>('hide');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const hidden = prefs.list.filter((p) => p.pref === 'hide');
  const trusted = prefs.list.filter((p) => p.pref === 'trust');

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setMsg(t('바꾸지 못했습니다: {0}', (e as Error).message));
    } finally {
      setBusy(false);
    }
  };
  const add = () => {
    const key = name.trim().replace(/^https:\/\/github\.com\//i, '').replace(/\/+$/, '');
    const kind = REPO.test(key) && !key.includes('..') ? 'repo' : OWNER.test(key) ? 'owner' : null;
    if (!kind) return setMsg(t('owner/repo나 제작자 이름을 넣으세요 (예: someone/skills, someone).'));
    void run(async () => {
      await saveOwnerPref(key, kind, pref);
      setName('');
    });
  };
  const row = (p: OwnerPref) => (
    <li key={p.key}>
      <span className="mono">{p.key}</span>
      <span className="muted small">{p.kind === 'owner' ? t('제작자 전체') : t('저장소')}</span>
      <button type="button" className="linkish small" disabled={busy} onClick={() => void run(() => removeOwnerPref(p.key))}>
        {p.pref === 'hide' ? t('숨김 해제') : t('믿기 해제')}
      </button>
    </li>
  );

  return (
    <section>
      <h2>{t('숨긴 저장소·믿는 제작자')}</h2>
      <p className="muted small">
        {t('숨긴 저장소의 스킬은 검색·README 추천·둘러보기에서 빠집니다. 결과 위의 "숨긴 저장소 N개 · 보기"로 한 번만 볼 수 있습니다. 믿는 제작자는 사이드 필터로만 쓰고 정렬·위험 등급은 바꾸지 않습니다.')}
      </p>
      <h3 className="small">{t('숨긴 저장소 {0}개', hidden.length)}</h3>
      {hidden.length ? <ul className="owner-prefs-list">{hidden.map(row)}</ul> : <p className="muted small">{t('숨긴 저장소가 없습니다. 결과 카드의 … 메뉴에서 숨길 수 있습니다.')}</p>}
      <h3 className="small">{t('믿는 제작자 {0}명', trusted.length)}</h3>
      {trusted.length ? <ul className="owner-prefs-list">{trusted.map(row)}</ul> : <p className="muted small">{t('믿는 제작자가 없습니다.')}</p>}
      <form
        className="owner-prefs-add"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('owner/repo 또는 제작자 이름')} aria-label={t('숨기거나 믿을 저장소·제작자')} maxLength={160} />
        <select value={pref} onChange={(e) => setPref(e.target.value as 'hide' | 'trust')} aria-label={t('무엇을 할지')}>
          <option value="hide">{t('숨기기')}</option>
          <option value="trust">{t('믿기')}</option>
        </select>
        <button type="submit" className="ghost" disabled={busy || !name.trim()}>
          {t('더하기')}
        </button>
      </form>
      {msg && (
        <p className="warn-text small" role="status">
          {msg}
        </p>
      )}
    </section>
  );
}
