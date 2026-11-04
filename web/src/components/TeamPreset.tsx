import { useRef, useState } from 'react';
import { apiSend } from '../api.ts';
import { fileStem, saveFile } from '../lib/exportList.ts';
import { parsePreset, PRESET_MAX, presetFrom, presetSize } from '../lib/preset.ts';
import type { InstalledResponse, RepoResult } from '../types.ts';
import { RepoInstallDialog } from './RepoInstallDialog.tsx';
import { serverText, t } from '../i18n.ts';

type Resolved = { skills: RepoResult['skills']; missing: Array<{ name: string; reason: string }> };

/**
 * 팀 프리셋 (user decision 2026-11-02): save the installed skills as a file to share with a team, and install a
 * teammate's file. Importing looks every entry up in this PC's index and installs through the bulk-install dialog
 * (commands, file checks, risk ticks), so the file itself never decides what runs.
 */
export function TeamPreset({ data, projectPath, onInstalled }: { data: InstalledResponse | null; projectPath: string; onInstalled: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preset, setPreset] = useState<{ name: string; resolved: Resolved } | null>(null);
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
      const resolved = await apiSend<Resolved>('POST', '/presets/resolve', { items });
      // past the 200 an import takes: said with what was not found
      if (skipped) resolved.missing.push({ name: t('{0}개 더', skipped), reason: t('프리셋은 한 번에 {0}개까지 가져옵니다', PRESET_MAX) });
      if (!resolved.skills.length) throw new Error(t('이 PC에서 설치할 수 있는 스킬을 찾지 못했습니다 ({0}개 없음). 색인을 모은 뒤 다시 해 보세요.', resolved.missing.length));
      setPreset({ name, resolved });
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
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
      {preset && (
        <RepoInstallDialog
          repo={{ repo: preset.name, url: '', description: null, stars: null, topics: [], skills: preset.resolved.skills }}
          open
          defaultProjectPath={projectPath.trim() || undefined}
          title={t('프리셋 "{0}" 설치', preset.name)}
          note={
            preset.resolved.missing.length > 0 && (
              <div className="warn-box small">
                <p>{t('이 PC의 색인에서 찾지 못해 빠진 것 {0}개:', preset.resolved.missing.length)}</p>
                <ul>
                  {preset.resolved.missing.slice(0, 20).map((m, i) => (
                    <li key={i}>
                      <span className="mono">{m.name}</span> — {serverText(m.reason)}
                    </li>
                  ))}
                </ul>
              </div>
            )
          }
          onOpenChange={(o) => {
            if (o) return;
            setPreset(null);
            onInstalled();
          }}
        />
      )}
    </section>
  );
}
