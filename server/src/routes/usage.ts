// Skill use counts from the transcripts (feature review F11, decision 14): read by the 설치됨 table, emptied from the
// settings when the reading is turned off. The reading itself is the usage-scan task (usage/scan.ts).
import { Router } from 'express';
import type { AppContext } from '../context.ts';
import { isProjectDir } from '../install/validate.ts';
import { getSettings } from '../settings.ts';
import { usageSummary } from '../usage/summary.ts';
import { clearUsage } from '../usage/scan.ts';

export function usageRouter(ctx: AppContext): Router {
  const r = Router();
  const { store } = ctx;

  // per skill: last day used and uses in the last 30 days, everywhere and in `projectPath`; nothing while it is off
  r.get('/usage', (req, res) => {
    const projectPath = typeof req.query.projectPath === 'string' && req.query.projectPath.trim() ? req.query.projectPath.trim() : null;
    if (projectPath && !isProjectDir(projectPath)) {
      res.status(400).json({ error: '프로젝트 경로는 존재하는 디렉터리의 절대경로여야 합니다' });
      return;
    }
    const enabled = getSettings(store).usageScan;
    if (!enabled) {
      res.json({ enabled: false, scannedAt: null, files: 0, skills: [] });
      return;
    }
    res.json(usageSummary(store, true, projectPath));
  });

  // "기록 비우기": the counts and where each transcript was read up to
  r.delete('/usage', (_req, res) => {
    const { rows } = clearUsage(store);
    res.json({ ok: true, rows });
  });

  return r;
}
