import type { RiskLevel } from '../analyze/risk.ts';
import type { SkillRow } from '../db/store.ts';
import type { Lookup } from '../search/result.ts';
import { planInstall, type InstallMethod, type InstallScope } from './plan.ts';

/** One skill as the bulk-install dialog lists it (a same-name repo's card, a team preset). */
export type InstallSummary = {
  id: string;
  name: string;
  riskLevel: RiskLevel;
  riskFlags: string[];
  method: InstallMethod;
  installable: boolean;
  scopes: InstallScope[];
};

export function installSummary(s: SkillRow, lookup: Lookup, name = s.name): InstallSummary {
  const plugin = lookup.plugin(s.plugin_id);
  const plan = planInstall(s, plugin, lookup.marketplace(plugin?.marketplace));
  return {
    id: s.id,
    name,
    riskLevel: (s.risk_level as RiskLevel) ?? 'low',
    riskFlags: s.risk_json ? (JSON.parse(s.risk_json) as string[]) : [],
    method: plan.method,
    installable: plan.method !== 'manual-only' && !plan.disabled,
    scopes: plan.scopes,
  };
}
