// The layer order is set by the first `@layer` the bundle meets. index.css declares `theme, base, app, …`; when a
// component's `@layer app` stylesheet came first (imported through App.tsx), `app` became the weakest layer and
// Tailwind's reset undid the whole app's styling (2026-11-05). main.tsx must import the stylesheets before anything.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('main.tsx는 다른 모듈보다 index.css·styles.css를 먼저 불러온다', () => {
  const src = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');
  const imports = [...src.matchAll(/^import\s+(?:[^'"]*\s+from\s+)?['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  assert.deepEqual(imports.slice(0, 2), ['./index.css', './styles.css']);
});

test('index.css가 레이어 순서를 맨 처음에 선언한다', () => {
  const src = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
  const first = src.match(/@layer[^;{]*[;{]/)?.[0] ?? '';
  assert.match(first, /@layer theme, base, app, components, utilities;/);
});
