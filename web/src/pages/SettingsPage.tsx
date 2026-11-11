import { useEffect, useRef, useState } from 'react';
import { apiGet, apiSend } from '../api.ts';
import { searchLogChanged } from './SearchPage.tsx';
import { ConfirmDialog } from '../components/ConfirmDialog.tsx';
import { DiagnosticsButton } from '../components/Diagnostics.tsx';
import { FolderInput } from '../components/FolderInput.tsx';
import { HiddenReposSettings } from '../components/search/HiddenReposSettings.tsx';
import { LogViewer } from '../components/LogViewer.tsx';
import { TokenCheck, type TokenCheckHandle } from '../components/TokenCheck.tsx';
import type { Settings, SettingsResponse } from '../types.ts';
import { LANG, LANGS, setLang, t, type Lang } from '../i18n.ts';
import { tj } from '../i18nNodes.tsx';
import { formatAgo } from '../labels.ts';
import { fetchUsage, type UsageResponse } from '../components/UsageColumns.tsx';

/** The setting F11 added (server settings.ts); types.ts's Settings does not name it yet. */
type WithUsage = Settings & { usageScan?: boolean };

export function SettingsPage() {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [token, setToken] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const tokenCheck = useRef<TokenCheckHandle>(null);
  // F11: turning transcript reading on or off asks first (what is read and kept / whether to empty the counts)
  const [usageAsk, setUsageAsk] = useState<'on' | 'off' | null>(null);
  const [usageClear, setUsageClear] = useState(true);
  const [usageInfo, setUsageInfo] = useState<UsageResponse | null>(null);
  const refreshUsage = () => void fetchUsage('').then(setUsageInfo);
  useEffect(refreshUsage, []);

  /** Changes typed but not sent yet; kept over a save's answer so typing during a save is not lost. */
  const pending = useRef<Partial<Settings>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const apply = (r: SettingsResponse) => {
    setData(r);
    setDraft({ ...r.settings, ...pending.current });
  };

  useEffect(() => {
    apiGet<SettingsResponse>('/settings')
      .then(apply)
      .catch((e) => setMsg({ ok: false, text: String(e.message ?? e) }));
  }, []);

  const save = async (body: unknown, okText: string): Promise<boolean> => {
    try {
      const r = await apiSend<SettingsResponse>('PUT', '/settings', body);
      apply(r);
      searchLogChanged(r.settings.searchLog);
      setMsg({ ok: true, text: okText });
      return true;
    } catch (e) {
      setMsg({ ok: false, text: String((e as Error).message ?? e) });
      return false;
    }
  };

  // Every setting saves itself (project review 2026-11-02: changes left unsaved used to vanish without a word): a
  // switch or a choice at once, a number or a folder once typing stops, and whatever is left when leaving the page.
  const flush = () => {
    clearTimeout(timer.current);
    const patch = pending.current;
    pending.current = {};
    if (Object.keys(patch).length) void save({ settings: patch }, 'minStars' in patch ? t('저장했습니다 (검색 캐시를 비웠습니다)') : t('저장했습니다'));
  };
  /** `waitMs`: save after this pause in typing; null: only when the field is left or Enter is pressed. */
  const change = (patch: Partial<Settings>, waitMs: number | null = 0) => {
    setDraft((d) => (d ? { ...d, ...patch } : d));
    pending.current = { ...pending.current, ...patch };
    clearTimeout(timer.current);
    if (waitMs !== null) timer.current = setTimeout(flush, waitMs);
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => {
    // closing or reloading the tab: a plain request would be cut off, keepalive lets it finish
    const onHide = () => {
      const patch = pending.current;
      if (!Object.keys(patch).length) return;
      pending.current = {};
      void fetch('/api/settings', {
        method: 'PUT',
        keepalive: true,
        headers: { 'X-Skill-Finder': '1', 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: patch }),
      });
    };
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      flushRef.current();
    };
  }, []);

  if (!data || !draft) return <div className="page">{msg ? <p className="warn-box">{msg.text}</p> : <p className="muted">{t('불러오는 중…')}</p>}</div>;


  return (
    <div className="page settings">
      <h1>{t('설정')}</h1>
      <p className="muted small">{t('바꾸면 바로 저장됩니다. 숫자는 칸을 떠나거나 Enter를 누를 때, 폴더는 입력을 멈추면 저장됩니다.')}</p>
      <div role="status">{msg && <p className={msg.ok ? 'ok-box' : 'warn-box'}>{msg.text}</p>}</div>

      <section>
        {/* the language names stay in their own language, so anyone can find theirs */}
        <h2>{t('언어')} · Language · 言語</h2>
        <label className="field">
          <select value={LANG} onChange={(e) => setLang(e.target.value as Lang)} aria-label="Language">
            {LANGS.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
        <p className="muted small">{t('바꾸면 화면을 다시 불러옵니다. 이 브라우저에 기억됩니다.')}</p>
      </section>

      <section>
        <h2>{t('GitHub 토큰')}</h2>
        <p>
          {tj('상태: {0}', <b>{data.githubToken ? t('설정됨') : t('없음')}</b>)}
        </p>
        <p className="muted small">{t('공개 저장소 검색에는 권한 없는 fine-grained PAT면 충분합니다. 토큰이 없으면 GitHub 코드 검색을 건너뛰고, 저장소 파일 목록은 git으로 조회합니다.')}</p>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            const value = token.trim();
            save({ githubToken: value }, value ? t('토큰을 .env에 저장했습니다') : t('토큰을 지웠습니다')).then((ok) => {
              setToken('');
              // what GitHub says of the saved token: valid, its hourly quota, too broad (F22)
              if (ok && value) void tokenCheck.current?.check();
            });
          }}
        >
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={t('github_pat_… (비우고 저장하면 삭제)')}
            aria-label={t('GitHub 토큰')}
            autoComplete="off"
            spellCheck={false}
          />
          <button type="submit">{t('저장')}</button>
        </form>
        <TokenCheck ref={tokenCheck} hasToken={data.githubToken} />
      </section>

      <section>
        <h2>{t('검색 조건')}</h2>
        <label className="field min-stars">
          <span>{t('최소 GitHub 스타')}</span>
          <input
            type="number"
            min={0}
            step={500}
            value={draft.minStars}
            // saved when left or on Enter: typing "5000" used to save 5, 50, 500 on the way, each clearing the
            // search cache (review 2026-11-02)
            onChange={(e) => change({ minStars: Math.max(0, Math.floor(Number(e.target.value) || 0)) }, null)}
            onBlur={flush}
            onKeyDown={(e) => e.key === 'Enter' && flush()}
          />
        </label>
        <p className="muted small">{t('이 수보다 스타가 적거나 스타 수를 알 수 없는 저장소의 스킬은 검색 결과에서 숨깁니다. Anthropic 공식·파트너 스킬은 이 기준과 상관없이 보입니다. 0이면 제한하지 않습니다.')}</p>
      </section>

      <HiddenReposSettings />

      <section>
        <h2>{t('설치 기본값')}</h2>
        <div className="grid2">
          <label className="field">
            <span>{t('기본 설치 범위')}</span>
            <select value={draft.defaultScope} onChange={(e) => change({ defaultScope: e.target.value as 'user' | 'project' })}>
              <option value="user">{t('개인')}</option>
              <option value="project">{t('프로젝트')}</option>
            </select>
          </label>
          <div className="field">
            <span>{t('기본 프로젝트 폴더')}</span>
            <FolderInput value={draft.defaultProjectPath} onChange={(p) => change({ defaultProjectPath: p }, 800)} label={t('기본 프로젝트 폴더')} />
          </div>
        </div>
        <label className="chip">
          <input type="checkbox" checked={draft.telemetryDisabled} onChange={(e) => change({ telemetryDisabled: e.target.checked })} />
          {t('skills CLI 텔레메트리 끄기 (DISABLE_TELEMETRY=1). 끄지 않으면 skills.sh 순위 집계에 익명 정보가 전송됩니다.')}
        </label>
      </section>

      <section>
        <h2>{t('스킬 수집')}</h2>
        <label className="chip">
          <input type="checkbox" checked={draft.autoCollect} onChange={(e) => change({ autoCollect: e.target.checked })} />
          {t('커뮤니티 마켓플레이스 스킬을 백그라운드에서 자동으로 모으기')}
        </label>
        <p className="muted small">
          {t('지연 색인 마켓플레이스의 스킬 정보를 동기화 뒤에 조금씩 모읍니다. 검색하는 동안은 잠시 멈춰서 검색 속도에 영향을 주지 않습니다. 진행 상황은 마켓플레이스 화면에서 보고 멈출 수 있습니다.')}
        </p>
      </section>

      <section>
        <h2>{t('검색 기록')}</h2>
        <label className="chip">
          <input type="checkbox" checked={draft.searchLog} onChange={(e) => change({ searchLog: e.target.checked })} />
          {t('검색 기록 남기기')}
        </label>
        <p className="muted small">
          {t('검색어, 결과·숨긴 결과 수, 걸린 시간, 열어 본 결과의 순위를 이 PC에만 저장합니다(밖으로 보내지 않음). 검색 품질을 확인하는 데 쓰고, 90일이 지나면 지웁니다.')}
        </p>
        <div className="row">
          <span className="muted small">{t('저장된 기록 {0}개', data.searchLogCount.toLocaleString())}</span>
          <button
            type="button"
            className="ghost"
            disabled={data.searchLogCount === 0}
            onClick={() => setConfirmClear(true)}
          >
            {t('기록 지우기')}
          </button>
        </div>
        {confirmClear && (
          <ConfirmDialog
            title={t('검색 기록 지우기')}
            confirmLabel={t('지우기')}
            danger
            onCancel={() => setConfirmClear(false)}
            onConfirm={() => {
              setConfirmClear(false);
              apiSend<SettingsResponse>('DELETE', '/search-log')
                .then((r) => {
                  setData(r);
                  setMsg({ ok: true, text: t('검색 기록을 지웠습니다') });
                })
                .catch((e) => setMsg({ ok: false, text: String(e.message ?? e) }));
            }}
          >
            {t('저장된 검색 기록 {0}개를 모두 지웁니다. 되돌릴 수 없습니다.', data.searchLogCount.toLocaleString())}
          </ConfirmDialog>
        )}
      </section>

      <section>
        <h2>{t('스킬 사용 기록')}</h2>
        <label className="chip">
          <input
            type="checkbox"
            checked={(draft as WithUsage).usageScan === true}
            onChange={(e) => {
              setUsageClear(true);
              setUsageAsk(e.target.checked ? 'on' : 'off');
            }}
          />
          {t('대화 기록에서 스킬 사용 횟수 읽기')}
        </label>
        <p className="muted small">
          {t('설치됨 화면에 스킬마다 마지막으로 쓴 날과 최근 30일 사용 횟수를 보여 줍니다. 기본은 꺼짐이고, 켜면 이 PC의 Claude Code 대화 기록을 읽습니다.')}
        </p>
        {(draft as WithUsage).usageScan === true && usageInfo?.enabled && (
          <p className="muted small">
            {usageInfo.scannedAt ? t('읽은 기록 파일 {0}개 · 마지막으로 읽음 {1}', usageInfo.files.toLocaleString(), formatAgo(usageInfo.scannedAt)) : t('아직 읽지 않았습니다. 곧 백그라운드에서 읽습니다.')}
          </p>
        )}
        {usageAsk === 'on' && (
          <ConfirmDialog
            title={t('대화 기록에서 스킬 사용 횟수 읽기')}
            confirmLabel={t('켜기')}
            onCancel={() => setUsageAsk(null)}
            onConfirm={() => {
              setUsageAsk(null);
              void save({ settings: { usageScan: true } }, t('저장했습니다')).then((ok) => {
                if (!ok) return;
                // the first read now rather than at the next hourly run; the task may not be there yet
                void apiSend('POST', '/tasks/usage-scan/run').catch(() => {});
                // at once ("아직 읽지 않았습니다" shows right away), then again when the first read has had time
                refreshUsage();
                setTimeout(refreshUsage, 5000);
              });
            }}
          >
            <p>{t('이 PC의 Claude Code 대화 기록(~/.claude/projects 아래 *.jsonl, 하위 에이전트 기록 포함)을 읽어 스킬을 쓴 때를 셉니다.')}</p>
            <p>{t('저장하는 것은 스킬 이름, 날짜, 프로젝트 폴더, 횟수뿐입니다. 대화 본문과 명령 인자는 저장하지 않습니다.')}</p>
            <p>{t('읽은 내용은 이 PC 밖으로 보내지 않습니다.')}</p>
            <p className="muted small">{t('처음에는 기록 전체를 읽어 시간이 걸릴 수 있고, 그 뒤로는 1시간마다 새로 생긴 부분만 이어 읽습니다. 검색하는 동안은 쉽니다.')}</p>
          </ConfirmDialog>
        )}
        {usageAsk === 'off' && (
          <ConfirmDialog
            title={t('사용 횟수 읽기 끄기')}
            confirmLabel={t('끄기')}
            onCancel={() => setUsageAsk(null)}
            onConfirm={() => {
              setUsageAsk(null);
              const clear = usageClear;
              void save({ settings: { usageScan: false } }, t('저장했습니다')).then(async (ok) => {
                if (!ok || !clear) return refreshUsage();
                try {
                  await apiSend('DELETE', '/usage');
                  setMsg({ ok: true, text: t('사용 횟수 읽기를 끄고 저장된 기록을 지웠습니다') });
                } catch (e) {
                  setMsg({ ok: false, text: String((e as Error).message ?? e) });
                }
                refreshUsage();
              });
            }}
          >
            <p>{t('더 이상 대화 기록을 읽지 않습니다.')}</p>
            <label className="chip">
              <input type="checkbox" checked={usageClear} onChange={(e) => setUsageClear(e.target.checked)} />
              {t('저장된 사용 횟수도 지우기')}
            </label>
          </ConfirmDialog>
        )}
      </section>

      <section>
        <h2>{t('데이터 위치')}</h2>
        <p className="muted small">{t('스킬 색인·검색 기록과 GitHub 토큰은 이 PC의 아래 위치에만 저장됩니다. 새 버전으로 바꿔도 그대로 이어지고, 완전히 지우려면 이 폴더와 파일을 지우세요.')}</p>
        <dl className="kv">
          <dt>{t('색인·기록')}</dt>
          <dd className="mono">{data.dataDir}</dd>
          <dt>{t('토큰')}</dt>
          <dd className="mono">{data.envPath}</dd>
        </dl>
      </section>

      <section>
        <h2>{t('문제 알리기')}</h2>
        <p className="muted small">
          {t('버전·색인 개수·설정·최근 로그를 복사합니다. 토큰, 검색어, 사용자 폴더 이름은 넣지 않고 밖으로 보내지도 않습니다. 문제를 알릴 때 붙여 넣으세요. 로그 파일은 위 색인·기록 폴더의 logs 안에 있습니다.')}
        </p>
        <DiagnosticsButton />
        <LogViewer />
      </section>

      <section>
        <h2>{t('라이선스')}</h2>
        <p className="muted small">
          {tj(
            'Skill Finder는 {0}입니다. 화면에 들어 있는 오픈소스의 라이선스는 {1}에서 볼 수 있습니다.',
            <a href="/LICENSE.txt" target="_blank" rel="noopener noreferrer">
              {t('MIT 라이선스')}
            </a>,
            <a href="/THIRD-PARTY-LICENSES.txt" target="_blank" rel="noopener noreferrer">
              {t('오픈소스 라이선스 목록')}
            </a>,
          )}
        </p>
      </section>

    </div>
  );
}
