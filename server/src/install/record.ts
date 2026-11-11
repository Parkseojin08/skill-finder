// What was seen when installing (feature review F7, with P7): the risk signals at that moment, the file or run-config
// check's summary, the warnings the user ticked, and whether the install was pinned to the commit checked. Written
// into the install_log row the same request has just added (store.logInstall), so the history can show them later.
import type { RiskFlag } from '../analyze/risk.ts';
import type { SkillRow, Store } from '../db/store.ts';
import type { Indexer, PluginRunConfig } from '../indexer.ts';
import type { GitHub } from '../sources/github.ts';
import type { InstallPlan } from './plan.ts';
import { needsTick, scanSkillFiles, type FileScan } from './scan.ts';

/**
 * What the install brings besides SKILL.md (project review F1): a skill folder's other text files checked at the
 * pinned commit, or what a plugin runs once installed. The install tab asks for it, and the install itself checks it
 * again (both cached for 30 minutes, so this is usually no new download).
 */
export async function runInstallScan(ctx: { store: Store; github: GitHub; indexer: Indexer }, skill: SkillRow, plan: InstallPlan): Promise<Exclude<InstallScanResult, { kind: 'failed' }>> {
  if (plan.method === 'skills-cli' && skill.repo && skill.ref && skill.dir_path != null) return { kind: 'files', pinned: !!plan.pinnedRef, scan: await scanSkillFiles(ctx.github, skill) };
  if (plan.method === 'plugin' && plan.pluginId && ctx.store.getPlugin(plan.pluginId)?.repo) return { kind: 'plugin', pluginId: plan.pluginId, config: await ctx.indexer.pluginRunConfig(plan.pluginId) };
  return { kind: 'none', reason: plan.method === 'plugin' ? '색인한 마켓플레이스에 없는 플러그인이라 실행 설정을 읽지 못했습니다' : '앱에서 설치하지 않는 스킬입니다' };
}

/**
 * The check found what needs the confirm tick, as the page's scanIsHigh judges it: a download-and-run line (or
 * another signal of risk.ts TICK_FLAGS, decision 9) in an installed file or a plugin's command, or a plugin command
 * or agent document rated high (decision 10).
 */
export function scanNeedsTick(scan: InstallScanResult | null): boolean {
  if (!scan) return false;
  if (scan.kind === 'failed') return true;
  if (scan.kind === 'files') return scan.scan.findings.some((f) => needsTick(f.flags));
  if (scan.kind === 'plugin') return scan.config.items.some((it) => needsTick(it.flags) || it.level === 'high');
  return false;
}

/** The check that ran before the install, as the request saw it. */
export type InstallScanResult =
  | { kind: 'files'; pinned: boolean; scan: FileScan }
  | { kind: 'plugin'; pluginId: string; config: PluginRunConfig }
  | { kind: 'none'; reason: string }
  | { kind: 'failed'; error: string };

/** The ticks the confirm dialog sent: high risk, a replaced folder, a check that could not run. */
export type InstallAcks = { high: boolean; overwrite: boolean; scanFailed: boolean };

export type ScanSummary =
  | { kind: 'files'; commit: string; checked: number; skipped: number; unlisted: number; findings: Array<{ path: string; flags: RiskFlag[] }> }
  | { kind: 'plugin'; commit: string; items: number; hooks: number; mcp: number; lsp: number; findings: Array<{ kind: string; source: string; flags: RiskFlag[] }> }
  | { kind: 'failed'; error: string };

export function scanSummary(scan: InstallScanResult | null): ScanSummary | null {
  if (!scan || scan.kind === 'none') return null;
  if (scan.kind === 'failed') return { kind: 'failed', error: scan.error.slice(0, 300) };
  if (scan.kind === 'files') {
    const s = scan.scan;
    return { kind: 'files', commit: s.commit, checked: s.checked, skipped: s.skipped.length, unlisted: s.unlisted, findings: s.findings.slice(0, 100) };
  }
  const c = scan.config;
  return {
    kind: 'plugin',
    commit: c.commit,
    items: c.items.length,
    hooks: c.table?.hooks.length ?? 0,
    mcp: c.table?.mcp.length ?? 0,
    lsp: c.table?.lsp.length ?? 0,
    findings: c.findings.slice(0, 100),
  };
}

/** The id of the row the last INSERT on this connection added (read right after store.logInstall, same tick). */
export function lastInsertedLogId(store: Store): number | null {
  const row = store.db.prepare('SELECT last_insert_rowid() AS id').get() as { id: number | bigint } | undefined;
  const id = row ? Number(row.id) : 0;
  return id > 0 ? id : null;
}

export function recordInstallCheck(store: Store, logId: number, rec: { flags: RiskFlag[]; scan: InstallScanResult | null; acks: InstallAcks; pinned: boolean }): void {
  const summary = scanSummary(rec.scan);
  store.db
    .prepare('UPDATE install_log SET flags_json = ?, scan_summary_json = ?, acks_json = ?, pinned = ? WHERE id = ?')
    .run(JSON.stringify(rec.flags), summary ? JSON.stringify(summary) : null, JSON.stringify(rec.acks), rec.pinned ? 1 : 0, logId);
}
