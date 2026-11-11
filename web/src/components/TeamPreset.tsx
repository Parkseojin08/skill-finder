import { useRef, useState, type ReactNode } from 'react';
import { apiGet, apiSend } from '../api.ts';
import { fileStem, saveFile } from '../lib/exportList.ts';
import { parsePreset, PRESET_MAX, presetFrom, presetSize, type PresetItem } from '../lib/preset.ts';
import type { StandardSnippet } from '../lib/projects.ts';
import type { InstalledResponse, RepoResult } from '../types.ts';
import { CopyButton } from './CopyButton.tsx';
import { RepoInstallDialog } from './RepoInstallDialog.tsx';
import { serverText, t } from '../i18n.ts';
import '../projects.css';

export type ResolvedPreset = { skills: RepoResult['skills']; missing: Array<{ name: string; reason: string }> };

/** Looks preset entries up in this PC's index (/presets/resolve); `skipped`: entries past what one import takes. */
export async function resolvePreset(items: PresetItem[], skipped = 0): Promise<ResolvedPreset> {
  const resolved = await apiSend<ResolvedPreset>('POST', '/presets/resolve', { items: items.slice(0, PRESET_MAX) });
  const over = skipped + Math.max(0, items.length - PRESET_MAX);
  // past the 200 an import takes: said with what was not found
  if (over) resolved.missing.push({ name: t('{0}개 더', over), reason: t('프리셋은 한 번에 {0}개까지 가져옵니다', PRESET_MAX) });
  return resolved;
}

/**
 * The team preset's install dialog: the bulk-install dialog (commands, file checks, risk ticks) over the entries the
 * index found, with what it could not find above the list. The project standard (F12) opens the same one for what
 * is missing (decision 20).
 */
export function PresetInstallDialog({
  name,
  resolved,
  projectPath,
  title,
  extraNote,
  onClose,
}: {
  name: string;
  resolved: ResolvedPreset;
  projectPath: string;
  title?: string;
  extraNote?: ReactNode;
  onClose: () => void;
}) {
  return (
    <RepoInstallDialog
      repo={{ repo: name, url: '', description: null, stars: null, topics: [], skills: resolved.skills }}
      open
      defaultProjectPath={projectPath.trim() || undefined}
      title={title ?? t('프리셋 "{0}" 설치', name)}
      note={
        (resolved.missing.length > 0 || extraNote) && (
          <>
            {extraNote}
            {resolved.missing.length > 0 && (
              <div className="warn-box small">
                <p>{t('이 PC의 색인에서 찾지 못해 빠진 것 {0}개:', resolved.missing.length)}</p>
                <ul>
                  {resolved.missing.slice(0, 20).map((m, i) => (
                    <li key={i}>
                      <span className="mono">{m.name}</span> — {serverText(m.reason)}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )
      }
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    />
  );
}

/**
 * 팀 프리셋 (user decision 2026-11-02): save the installed skills as a file to share with a team, and install a
 * teammate's file. Importing looks every entry up in this PC's index and installs through the bulk-install dialog
 * (commands, file checks, risk ticks), so the file itself never decides what runs. F12 adds the same list as the
 * project's standard files (skills-lock.json, .claude/settings.json) to copy into a repository.
 */
export function TeamPreset({ data, projectPath, onInstalled }: { data: InstalledResponse | null; projectPath: string; onInstalled: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preset, setPreset] = useState<{ name: string; resolved: ResolvedPreset } | null>(null);
  const [snippet, setSnippet] = useState<StandardSnippet | null>(null);
  const [snippetBusy, setSnippetBusy] = useState(false);
  const size = data ? presetSize(data) : 0;
  const defaultName = projectPath.trim().split(/[\\/]/).filter(Boolean).pop() ?? t('내 스킬');

  const exportPreset = () => {
    if (!data) return;
    const p = presetFrom(data, defaultName);
    saveFile(`skill-finder-preset-${fileStem(p.name)}.json`, `${JSON.stringify(p, null, 2)}\n`, 'application/json');
  };

  const importFile = async (file: File) => {
    setError(null);
    setBusy(true);
    try {
      const { name, items, skipped } = parsePreset(await file.text());
      const resolved = await resolvePreset(items, skipped);
      if (!resolved.skills.length) throw new Error(t('이 PC에서 설치할 수 있는 스킬을 찾지 못했습니다 ({0}개 없음). 색인을 모은 뒤 다시 해 보세요.', resolved.missing.length));
      setPreset({ name, resolved });
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const loadSnippet = async () => {
    if (snippet) return setSnippet(null);
    setError(null);
    setSnippetBusy(true);
    try {
      setSnippet(await apiGet<StandardSnippet>('/presets/snippet', { projectPath: projectPath.trim() || undefined }));
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setSnippetBusy(false);
    }
  };

  return (
    <section className="team-preset" aria-labelledby="team-preset-title">
      <h2 id="team-preset-title">{t('팀 프리셋')}</h2>
      <p className="muted small">
        {t('지금 목록의 스킬을 파일로 저장해 팀원에게 주면, 팀원은 "가져오기"로 같은 스킬을 확인 창을 거쳐 설치합니다. 파일에는 프리셋 이름(폴더 이름)·만든 시각과 스킬 이름·색인 id만 들어가고, 200개까지 담습니다.')}
      </p>
      <div className="examples">
        <button type="button" className="ghost" onClick={exportPreset} disabled={!size} title={size ? undefined : t('색인에 있는 설치된 스킬이 없습니다')}>
          {t('프리셋 내보내기{0}', size ? t(' ({0}개)', size) : '')}
        </button>
        <button type="button" className="ghost" onClick={() => fileRef.current?.click()} disabled={busy}>
          {busy ? t('찾는 중…') : t('프리셋 가져오기')}
        </button>
        <button type="button" className="ghost" onClick={() => void loadSnippet()} disabled={snippetBusy} aria-expanded={!!snippet}>
          {snippetBusy ? t('만드는 중…') : snippet ? t('조각 닫기') : t('skills-lock.json·settings.json 조각')}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void importFile(f);
          }}
        />
      </div>
      {error && (
        <p className="warn-box" role="alert">
          {error}
        </p>
      )}
      {snippet && (
        <div className="standard-snippet">
          <p className="muted small">
            {t('프로젝트 저장소에 넣으면 "프로젝트 표준"이 됩니다. skills-lock.json은 skills CLI 형식(computedHash는 지금 설치본으로 계산)이고, settings.json 조각은 .claude/settings.json에 합쳐 넣습니다. 팀원은 설치됨 화면의 "프로젝트 표준"에서 빠진 것을 설치합니다.')}
          </p>
          <div className="standard-snippet-head">
            <strong className="mono small">skills-lock.json</strong>
            <span className="muted small">{t('스킬 {0}개', snippet.skills)}</span>
            <CopyButton text={snippet.lock} label={t('복사')} className="ghost small" />
          </div>
          <pre className="standard-snippet-code">{snippet.lock}</pre>
          <div className="standard-snippet-head">
            <strong className="mono small">.claude/settings.json</strong>
            <span className="muted small">{t('플러그인 {0}개', snippet.plugins)}</span>
            <CopyButton text={snippet.settings} label={t('복사')} className="ghost small" />
          </div>
          <pre className="standard-snippet-code">{snippet.settings}</pre>
          {(snippet.skippedSkills > 0 || snippet.localMarkets.length > 0) && (
            <p className="muted small">
              {snippet.skippedSkills > 0 && t('색인에 있는 GitHub 스킬이 아니라 뺀 것 {0}개(직접 만든 스킬, 플러그인 안 스킬 등).', snippet.skippedSkills)}{' '}
              {snippet.localMarkets.length > 0 && t('이 PC의 폴더에서 추가한 마켓은 넣지 않았습니다: {0}', snippet.localMarkets.join(', '))}
            </p>
          )}
        </div>
      )}
      {preset && (
        <PresetInstallDialog
          name={preset.name}
          resolved={preset.resolved}
          projectPath={projectPath}
          onClose={() => {
            setPreset(null);
            onInstalled();
          }}
        />
      )}
    </section>
  );
}
