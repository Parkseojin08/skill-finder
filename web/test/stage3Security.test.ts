// Stage 3 bundle A: the web's words for the risk signals match the server's rules (B5), and the sets both sides
// keep (confirm tick, Claude-only flags) are the same.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { riskLevel, SKILL_RULES, TICK_FLAGS as SERVER_TICK, type RiskFlag } from '../../server/src/analyze/risk.ts';
import { CLAUDE_ONLY_FLAGS as SERVER_CLAUDE_ONLY } from '../../server/src/lint/lint.ts';
import { RISK_FLAGS } from '../src/labels.ts';
import { B5_RISK_FLAGS, CLAUDE_ONLY_FLAGS, TICK_FLAGS } from '../src/lib/security.ts';

const PLUGIN_FLAGS: RiskFlag[] = ['pluginHooks', 'pluginMcp', 'pluginBin', 'pluginMonitors', 'commandSource'];

describe('위험 신호 표: 서버와 웹이 같은 규칙 (B5)', () => {
  const words = { ...B5_RISK_FLAGS, ...RISK_FLAGS };
  const flags = [...SKILL_RULES.map((r) => r.flag), ...PLUGIN_FLAGS];

  it('서버의 모든 신호에 이름과 설명이 있다', () => {
    const missing = flags.filter((f) => !words[f]?.label || !words[f]?.meaning);
    assert.deepEqual(missing, []);
  });

  it('웹의 "정보" 표시는 서버가 등급을 올리지 않는 신호와 같다', () => {
    for (const f of flags) assert.equal(!!words[f]?.info, riskLevel([f]) === 'low', f);
  });

  it('확인 체크 신호와 Claude Code 전용 신호 목록이 같다', () => {
    assert.deepEqual([...TICK_FLAGS].sort(), [...SERVER_TICK].sort());
    assert.deepEqual([...CLAUDE_ONLY_FLAGS].sort(), [...SERVER_CLAUDE_ONLY].sort());
  });
});
