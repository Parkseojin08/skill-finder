// The 설치됨 screen's check chips (F8) and the 자동 실행·권한 tab's comparison and snippets (F10).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseToml } from '../../server/src/agentConfig/toml.ts';
import { compareMcp, mcpSnippet, presentAgents, VALUE_PLACEHOLDER, type AgentConfigResponse, type RunRow } from '../src/lib/agentConfigView.ts';
import { installedChecks, originChanged, shownPairs, type CheckRow, type InstalledCheckResponse } from '../src/lib/installedCheck.ts';

function row(name: string, over: Partial<CheckRow> = {}): CheckRow {
  return { path: `/s/${name}`, name, scope: 'user', risk: { level: 'low' }, installedRisk: null, skillId: `gh:o/r:${name}`, tokens: { perTurn: 10 }, ...over };
}
const keys = (rows: CheckRow[], check: InstalledCheckResponse | null = null) => Object.fromEntries(installedChecks(rows, check).map((c) => [c.key, [...c.paths].sort()]));

describe('점검 칩 (installedCheck.ts)', () => {
  it('위험 오름·두 범위·꺼진 플러그인·색인에 없음·컨텍스트 상위 5', () => {
    const rows = [
      row('a', { installedRisk: 'low', risk: { level: 'medium' } }),
      row('b', { installedRisk: 'medium', risk: { level: 'medium' } }),
      row('dup', { path: '/u/dup' }),
      row('dup', { path: '/p/dup', scope: 'project' }),
      row('off', { plugin: { enabled: false }, tokens: { perTurn: 999 } }),
      row('raw', { skillId: null }),
      row('codex', { agents: [{ id: 'codex' }], tokens: { perTurn: 500 } }),
      ...['t1', 't2', 't3', 't4', 't5', 't6'].map((n, i) => row(n, { tokens: { perTurn: 100 + i } })),
    ];
    const k = keys(rows);
    assert.deepEqual(k.riskUp, ['/s/a']);
    assert.deepEqual(k.twoScopes, ['/p/dup', '/u/dup']);
    assert.deepEqual(k.pluginOff, ['/s/off']);
    assert.deepEqual(k.unindexed, ['/s/raw']);
    // what Claude Code loads: not an off plugin's, not another agent's folder
    assert.deepEqual(k.topContext, ['/s/t2', '/s/t3', '/s/t4', '/s/t5', '/s/t6']);
    assert.equal(k.originChanged, undefined);
    assert.equal(k.sameContent, undefined);
  });

  it('원본 바뀜은 변경 추적 필드(drift)가 있을 때만', () => {
    assert.equal(originChanged('changed'), null);
    assert.equal(originChanged(undefined), null);
    assert.equal(originChanged({ change: 'upstream' }), true);
    assert.equal(originChanged({ change: 'local', upstreamToo: false }), false);
    assert.equal(originChanged({ change: 'local', upstreamToo: true }), true);
    assert.equal(keys([row('a')]).originChanged, undefined);
    assert.deepEqual(keys([row('a', { drift: { change: 'upstream' } }), row('b', { drift: { change: 'latest' } })]).originChanged, ['/s/a']);
  });

  it('같은 내용 중복과 겹치는 쌍은 이 화면에 있는 행만', () => {
    const side = (n: string) => ({ path: `/s/${n}`, name: n, description: '', tokens: [] });
    const check: InstalledCheckResponse = {
      duplicates: [
        { hash: 'h', paths: ['/s/a', '/s/b'] },
        { hash: 'g', paths: ['/s/c', '/elsewhere/c'] },
      ],
      pairs: [
        { a: side('a'), b: side('c'), score: 0.7, shared: [] },
        { a: side('a'), b: { ...side('x'), path: '/gone/x' }, score: 0.9, shared: [] },
      ],
      compared: 3,
      skipped: 0,
    };
    const rows = [row('a'), row('b'), row('c')];
    const chips = installedChecks(rows, check);
    assert.deepEqual([...chips.find((c) => c.key === 'sameContent')!.paths].sort(), ['/s/a', '/s/b']);
    const overlap = chips.find((c) => c.key === 'overlap')!;
    assert.equal(overlap.count, 1);
    assert.equal(shownPairs(rows, check).length, 1);
  });
});

const src = (agent: RunRow['source']['agent']) => ({ agent, file: `/${agent}.json`, line: 1, scope: 'user' as const });
function server(name: string, agent: RunRow['source']['agent'], over: Partial<RunRow> = {}): RunRow {
  return {
    kind: 'mcp',
    name,
    matcher: null,
    hookType: null,
    transport: 'stdio',
    program: 'npx',
    args: ['-y', 'pkg@1.0.0', '--dir', 'C:\\a "b"'],
    command: null,
    host: null,
    envKeys: ['API_KEY'],
    headerKeys: [],
    flags: [],
    unpinned: null,
    state: 'on',
    source: src(agent),
    ...over,
  };
}

describe('에이전트 비교와 조각 복사 (agentConfigView.ts)', () => {
  const cfg: AgentConfigResponse = {
    projectPath: null,
    files: [
      { agent: 'claude', path: '/c', scope: 'user', state: 'read' },
      { agent: 'codex', path: '/x', scope: 'user', state: 'read' },
      { agent: 'cursor', path: '/y', scope: 'user', state: 'missing' },
    ],
    run: [server('github', 'claude'), server('GitHub', 'codex'), server('fetch', 'claude'), { ...server('h', 'claude'), kind: 'hook' }],
    permissions: [],
    components: [],
    plugins: [],
    truncated: false,
  };
  it('설정 파일이 있는 에이전트끼리 이름으로 맞춘다 (대소문자 무시)', () => {
    assert.deepEqual(presentAgents(cfg), ['claude', 'codex']);
    assert.deepEqual(
      compareMcp(cfg).map((r) => [r.name, r.missing]),
      [
        ['fetch', ['codex']],
        ['github', []],
      ],
    );
  });
  it('Codex TOML 조각은 TOML로 읽히고, 값은 채울 자리로 남는다', () => {
    const text = mcpSnippet(server('my server', 'claude'), 'codex');
    const parsed = parseToml(text).data as { mcp_servers: Record<string, { command: string; args: string[]; env: Record<string, string> }> };
    const s = parsed.mcp_servers['my server'];
    assert.equal(s.command, 'npx');
    assert.deepEqual(s.args, ['-y', 'pkg@1.0.0', '--dir', 'C:\\a "b"']);
    assert.deepEqual(s.env, { API_KEY: VALUE_PLACEHOLDER });
  });
  it('JSON 조각: Claude·Cursor·Gemini, 원격 서버는 호스트만', () => {
    const claude = JSON.parse(mcpSnippet(server('s', 'codex'), 'claude'));
    assert.deepEqual(claude.mcpServers.s, { type: 'stdio', command: 'npx', args: ['-y', 'pkg@1.0.0', '--dir', 'C:\\a "b"'], env: { API_KEY: VALUE_PLACEHOLDER } });
    const remote = server('r', 'claude', { transport: 'http', program: null, args: [], host: 'mcp.example.com', envKeys: [], headerKeys: ['Authorization'] });
    assert.deepEqual(JSON.parse(mcpSnippet(remote, 'gemini')).mcpServers.r, { httpUrl: 'https://mcp.example.com/…', headers: { Authorization: VALUE_PLACEHOLDER } });
    assert.deepEqual(JSON.parse(mcpSnippet(remote, 'cursor')).mcpServers.r, { url: 'https://mcp.example.com/…', headers: { Authorization: VALUE_PLACEHOLDER } });
    assert.match(mcpSnippet(remote, 'codex'), /url = "https:\/\/mcp\.example\.com\/…"[\s\S]*http_headers/);
  });
});
