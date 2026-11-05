// What an install request must confirm (feature review P7): the page's confirm tick for high risk was enforced only
// on the screen. The server now refuses a high-risk install whose request does not say the tick was given, the same
// line of defence as the 409 for an unconfirmed overwrite.
import type { SkillRow, Store } from '../db/store.ts';
import type { InstallPlan } from './plan.ts';

/**
 * Whether installing `skill` this way installs something rated high: the skill itself, or, for a plugin (which
 * installs all of its skills), any skill of that plugin. The file and run-config checks the page also counts are
 * read from GitHub when the install tab opens and are not repeated here.
 */
export function installIsHighRisk(store: Store, skill: SkillRow, plan: InstallPlan): boolean {
  if (skill.risk_level === 'high') return true;
  if (plan.method !== 'plugin' || !plan.pluginId) return false;
  return store.listSkillsByPlugin(plan.pluginId).some((s) => s.risk_level === 'high');
}
