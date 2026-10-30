import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SizedCache } from '../src/util/sizedCache.ts';

const tick = () => new Promise((r) => setImmediate(r));

describe('크기 상한 캐시 (성능 토론 1-3)', () => {
  it('개수가 아니라 크기 합으로 오래 안 쓴 것부터 버린다', async () => {
    const c = new SizedCache<number[]>({ maxSize: 10, ttlMs: 60_000, sizeOf: (v) => v.length });
    c.set('a', Promise.resolve([1, 2, 3, 4]));
    c.set('b', Promise.resolve([1, 2, 3, 4]));
    await tick();
    assert.ok(c.get('a')); // a is now the most recently used
    c.set('c', Promise.resolve([1, 2, 3, 4]));
    await tick();
    assert.ok(c.get('a'));
    assert.equal(c.get('b'), undefined, '가장 오래 안 쓴 b가 빠짐');
    assert.deepEqual(c.stats(), { count: 2, size: 8 });
  });

  it('혼자 상한보다 큰 최신 항목은 다음 항목이 올 때까지 남는다', async () => {
    const c = new SizedCache<number[]>({ maxSize: 5, ttlMs: 60_000, sizeOf: (v) => v.length });
    c.set('big', Promise.resolve(new Array(9).fill(0)));
    await tick();
    assert.ok(c.get('big'));
    c.set('small', Promise.resolve([1]));
    await tick();
    assert.equal(c.get('big'), undefined);
    assert.deepEqual(c.stats(), { count: 1, size: 1 });
  });

  it('만료와 실패한 약속은 빠진다', async () => {
    let now = 0;
    const c = new SizedCache<number[]>({ maxSize: 100, ttlMs: 1000, sizeOf: (v) => v.length, now: () => now });
    c.set('x', Promise.resolve([1]));
    c.set('bad', Promise.reject(new Error('no')));
    c.get('bad')?.catch(() => {});
    await tick();
    assert.equal(c.get('bad'), undefined);
    now = 1001;
    assert.equal(c.get('x'), undefined);
    assert.deepEqual(c.stats(), { count: 0, size: 0 });
  });
});
