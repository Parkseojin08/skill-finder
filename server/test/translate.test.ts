import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { zstdCompressSync } from 'node:zlib';
import { MODEL_FILES, TranslateModels, type ModelFile } from '../src/translate/models.ts';
import { rawRequest, startTestServer } from './helpers.ts';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** A model file as Mozilla serves it (zstd), with the pins the app checks it against. */
function pinned(part: ModelFile['part'], name: string, text: string) {
  const raw = Buffer.from(text);
  const packed = zstdCompressSync(raw);
  return { file: { part, name, location: `ws/${name}.zst`, size: packed.length, sha256: sha(packed), unpackedSize: raw.length, unpackedSha256: sha(raw) }, packed };
}

/** A CDN that serves `bodies` by location and counts the calls. */
function cdn(bodies: Map<string, Uint8Array>) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    const body = [...bodies].find(([loc]) => url.endsWith(loc))?.[1];
    return body ? new Response(body) : new Response('missing', { status: 404 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

async function settled(m: TranslateModels) {
  for (let i = 0; i < 200 && m.status('ko').state === 'downloading'; i++) await new Promise((r) => setTimeout(r, 10));
  return m.status('ko');
}

describe('번역 모델 (Firefox 모델, 사용자 요청 2026-11-03)', () => {
  it('Mozilla에서 받은 파일의 SHA-256을 확인하고 풀어 두고, 엔진이 읽을 목록을 만든다. 이미 있으면 다시 받지 않는다', async () => {
    const model = pinned('model', 'model.enko.bin', 'MODEL'.repeat(200));
    const vocab = pinned('vocab', 'vocab.enko.spm', 'VOCAB');
    const { calls, fetchImpl } = cdn(new Map([[model.file.location, model.packed], [vocab.file.location, vocab.packed]]));
    const dir = mkdtempSync(join(tmpdir(), 'sf-tm-'));
    const m = new TranslateModels(dir, fetchImpl, { ko: [model.file, vocab.file], ja: [] });
    assert.deepEqual(m.status('ko'), { lang: 'ko', state: 'absent', received: 0, total: model.file.size + vocab.file.size, error: null });
    assert.deepEqual(m.registry(), {}, '받기 전에는 엔진에 알릴 모델이 없음');

    assert.equal(m.start('ko').state, 'downloading');
    assert.equal((await settled(m)).state, 'ready');
    assert.equal(readFileSync(join(dir, 'enko', 'model.enko.bin'), 'utf8'), 'MODEL'.repeat(200), '압축을 풀어 저장');
    assert.deepEqual(m.registry().enko?.model, {
      name: `/translate-models/enko/model.enko.bin?v=${model.file.unpackedSha256.slice(0, 16)}`,
      size: model.file.unpackedSize,
      expectedSha256Hash: model.file.unpackedSha256,
    });
    assert.equal(calls.length, 2);

    assert.equal(m.start('ko').state, 'ready');
    // a new instance (the app started again) finds the files by their mark
    assert.equal(new TranslateModels(dir, fetchImpl, { ko: [model.file, vocab.file], ja: [] }).status('ko').state, 'ready');
    assert.equal(calls.length, 2, '다시 받지 않음');

    // a file deleted by hand (or quarantined): not ready any more, and only that file is fetched again
    rmSync(join(dir, 'enko', 'vocab.enko.spm'));
    assert.equal(m.status('ko').state, 'absent');
    m.start('ko');
    assert.equal((await settled(m)).state, 'ready');
    assert.equal(calls.length, 3);
  });

  it('정해 둔 크기를 넘는 본문, 압축은 맞는데 푼 내용이 다른 파일은 받지 않는다. 연결 실패는 앱의 말로 남긴다', async () => {
    const model = pinned('model', 'model.enko.bin', 'MODEL');
    const cases: Array<[ModelFile, Uint8Array | null, RegExp]> = [
      [{ ...model.file, size: model.file.size - 1 }, model.packed, /크기가 맞지 않습니다/],
      [{ ...model.file, unpackedSha256: 'f'.repeat(64) }, model.packed, /압축을 푼 파일이 맞지 않습니다/],
      [model.file, null, /내려받지 못했습니다 \(연결 실패\)/],
    ];
    for (const [file, body, error] of cases) {
      const fetchImpl = (async () => {
        if (!body) throw new TypeError('fetch failed');
        return new Response(body);
      }) as typeof fetch;
      const m = new TranslateModels(mkdtempSync(join(tmpdir(), 'sf-tm-')), fetchImpl, { ko: [file], ja: [] });
      m.start('ko');
      const s = await settled(m);
      assert.equal(s.state, 'error');
      assert.match(s.error ?? '', error);
    }
  });

  it('일본어 모델은 입력·출력 어휘가 따로라 엔진 목록에 srcvocab·trgvocab으로 넣는다', () => {
    assert.deepEqual(MODEL_FILES.ja.map((f) => f.part).sort(), ['lex', 'model', 'srcvocab', 'trgvocab']);
    assert.deepEqual(MODEL_FILES.ko.map((f) => f.part).sort(), ['lex', 'model', 'vocab']);
  });

  it('해시가 다른 파일은 저장하지 않고 오류로 남기며, 다음에 누르면 다시 받는다', async () => {
    const model = pinned('model', 'model.enko.bin', 'MODEL');
    const bodies = new Map([[model.file.location, zstdCompressSync(Buffer.from('EVIL!'))]]);
    const { fetchImpl } = cdn(bodies);
    const dir = mkdtempSync(join(tmpdir(), 'sf-tm-'));
    const m = new TranslateModels(dir, fetchImpl, { ko: [{ ...model.file, size: 1000 }], ja: [] });
    m.start('ko');
    const s = await settled(m);
    assert.equal(s.state, 'error');
    assert.match(s.error ?? '', /SHA-256이 맞지 않습니다/);
    assert.ok(!existsSync(join(dir, 'enko', 'model.enko.bin')));
    assert.deepEqual(m.registry(), {});
    bodies.set(model.file.location, model.packed);
    m.start('ko');
    assert.equal((await settled(m)).state, 'ready');
  });

  it('API는 상태와 시작만 하고, 파일과 목록은 /api 밖에서 헤더 없이 읽는다', async () => {
    const srv = await startTestServer();
    try {
      const api = (method: string, path: string) =>
        rawRequest({ port: srv.port, method, path, headers: { 'X-Skill-Finder': '1', Origin: `http://127.0.0.1:${srv.port}` } });
      const ko = JSON.parse((await api('GET', '/api/translate/models/ko')).body);
      assert.equal(ko.state, 'absent');
      assert.equal(ko.total, MODEL_FILES.ko.reduce((n, f) => n + f.size, 0));
      assert.equal((await api('GET', '/api/translate/models/de')).status, 404);
      assert.equal((await api('POST', '/api/translate/models/de')).status, 404);
      const index = await rawRequest({ port: srv.port, path: '/translate-models/index.json' });
      assert.equal(index.status, 200);
      assert.deepEqual(JSON.parse(index.body), {});
      assert.equal((await rawRequest({ port: srv.port, path: '/translate-models/enko/nothing.bin' })).status, 404, '없는 파일은 페이지가 아니라 404');
      const page = await rawRequest({ port: srv.port, path: '/' });
      if (page.status === 200) {
        // WebAssembly may be compiled (the engine), eval may not
        const csp = String(page.headers['content-security-policy']);
        assert.match(csp, /script-src 'self' 'wasm-unsafe-eval';/);
        assert.doesNotMatch(csp, /'unsafe-eval'/);
      }
      writeFileSync(join(srv.ctx.config.dataDir, 'secret.txt'), 'TOKEN-123');
      for (const path of ['/translate-models/../secret.txt', '/translate-models/%2e%2e/secret.txt', '/translate-models/..%2fsecret.txt']) {
        assert.ok(!(await rawRequest({ port: srv.port, path })).body.includes('TOKEN-123'), `폴더 밖 파일은 내주지 않음: ${path}`);
      }
    } finally {
      await srv.close();
    }
  });
});
