// Skill uses in one line of a Claude Code transcript (feature review F11, decision 14). The format is not published
// and may change; what is read was checked on this PC's transcripts (2026-11-09) and is pinned by the fixture in
// server/test/fixtures/usage/. Only a skill's name, the day, the folder (cwd) and an id to drop repeats leave here:
// never any text of the conversation.
//
//  - an assistant record whose message.content has a `tool_use` block named "Skill": input.skill (older: command),
//    "plugin:skill" for a plugin's skill
//  - a user record whose content is a slash command: the string starts with `<command-message>` or
//    `<command-name>`, and `<command-name>/name</command-name>` names it (Claude Code's own commands are left out)
//
// Each step is a scan or a slice of the line (D#4de9): no pattern can take longer than the line is long.

export type SkillUse = {
  /** Local day of the record, YYYY-MM-DD. */
  day: string;
  /** The folder Claude Code ran in (record cwd), '' when absent. */
  project: string;
  skill: string;
  /** The plugin of "plugin:skill", '' for a skill of its own. */
  plugin: string;
  /** tool_use id or record uuid: one use written twice (a resumed or forked session) is counted once per scan. */
  key: string | null;
};

/** Claude Code's own slash commands: not skills, so not counted (the 설치됨 table matches installed names anyway). */
const BUILTIN_COMMANDS = new Set(
  (
    'add-dir agents bashes btw bug clear compact config context cost doctor effort exit export fast feedback goal help hooks ide ' +
    'init install-github-app login logout loop mcp memory migrate-installer model output-style permissions plan plugin ' +
    'plugins pr-comments privacy-settings release-notes reload-plugins resume review rewind sandbox schedule ' +
    'security-review skills status statusline tasks terminal-setup theme todos upgrade usage vim'
  ).split(' '),
);

const MAX_NAME = 200;
/** A name part: letters, digits, `.`, `_`, `-`, spaces inside (no quotes, slashes or other text). */
const PART_RE = /^[a-z0-9][a-z0-9._ -]*$/;

/** "plugin:skill" or "skill" as stored (lower case), or null for anything that does not look like a skill name. */
export function splitSkillName(raw: unknown): { skill: string; plugin: string } | null {
  if (typeof raw !== 'string') return null;
  const name = raw.trim().replace(/^\//, '').toLowerCase();
  if (!name || name.length > MAX_NAME) return null;
  const colon = name.indexOf(':');
  const plugin = colon >= 0 ? name.slice(0, colon).trim() : '';
  const skill = (colon >= 0 ? name.slice(colon + 1) : name).trim();
  if (!PART_RE.test(skill) || (colon >= 0 && !PART_RE.test(plugin))) return null;
  return { skill, plugin };
}

/** Local calendar day of an ISO time, YYYY-MM-DD; null when it is not one. */
export function localDay(ts: unknown): string | null {
  if (typeof ts !== 'string' || ts.length > 40) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Cheap test on the raw bytes before any parsing: lines that can hold neither form are skipped as they are. */
export const SKILL_MARK = Buffer.from('"Skill"');
export const COMMAND_MARK = Buffer.from('<command-name>');
export function mayHoldUse(line: Buffer): boolean {
  return line.indexOf(SKILL_MARK) >= 0 || line.indexOf(COMMAND_MARK) >= 0;
}

type Rec = {
  type?: unknown;
  timestamp?: unknown;
  cwd?: unknown;
  uuid?: unknown;
  message?: { content?: unknown } | null;
};

/** The slash command a user record runs, from its leading command tags only (not a tag quoted in a message). */
function commandName(content: string): string | null {
  const head = content.slice(0, 2000).trimStart();
  if (!head.startsWith('<command-message>') && !head.startsWith('<command-name>')) return null;
  const open = head.indexOf('<command-name>');
  if (open < 0) return null;
  const from = open + '<command-name>'.length;
  const close = head.indexOf('</command-name>', from);
  if (close < 0 || close - from > MAX_NAME + 1) return null;
  return head.slice(from, close);
}

/** The skill uses in one transcript line (already decoded); [] for anything else, a broken line included. */
export function usesInLine(text: string): SkillUse[] {
  let rec: Rec;
  try {
    rec = JSON.parse(text) as Rec;
  } catch {
    return [];
  }
  if (!rec || typeof rec !== 'object') return [];
  const day = localDay(rec.timestamp);
  if (!day) return [];
  const project = typeof rec.cwd === 'string' && rec.cwd.length <= 1000 && !/[\0\r\n]/.test(rec.cwd) ? rec.cwd : '';
  const content = rec.message && typeof rec.message === 'object' ? rec.message.content : undefined;
  const out: SkillUse[] = [];
  if (rec.type === 'assistant' && Array.isArray(content)) {
    for (const block of content as Array<Record<string, unknown> | null>) {
      if (!block || typeof block !== 'object' || block.type !== 'tool_use' || block.name !== 'Skill') continue;
      const input = block.input && typeof block.input === 'object' ? (block.input as Record<string, unknown>) : {};
      const name = splitSkillName(typeof input.skill === 'string' ? input.skill : input.command);
      if (name) out.push({ day, project, ...name, key: typeof block.id === 'string' ? block.id.slice(0, 100) : null });
    }
  } else if (rec.type === 'user' && typeof content === 'string') {
    const name = splitSkillName(commandName(content));
    if (name && !(name.plugin === '' && BUILTIN_COMMANDS.has(name.skill))) {
      out.push({ day, project, ...name, key: typeof rec.uuid === 'string' ? rec.uuid.slice(0, 100) : null });
    }
  }
  return out;
}
