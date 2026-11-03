import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { zstdDecompress } from 'node:zlib';

// Translation of skill descriptions where the browser has no built-in translator (Firefox, Safari, Chromium
// without the API; user request 2026-11-03): Firefox's own English→Korean/Japanese models (Mozilla, MPL-2.0),
// run in the page by the Bergamot engine (@mkljczk/bergamot-translator). The server only fetches and checks the
// files and hands them to the page from this PC; descriptions are never sent anywhere.

export type ModelLang = 'ko' | 'ja';
export const MODEL_LANGS: readonly ModelLang[] = ['ko', 'ja'];

/** The part names Bergamot's registry uses; Japanese has separate source and target vocabularies. */
type Part = 'model' | 'lex' | 'vocab' | 'srcvocab' | 'trgvocab';
export type ModelFile = { part: Part; name: string; location: string; size: number; sha256: string; unpackedSize: number; unpackedSha256: string };

const CDN = 'https://firefox-settings-attachments.cdn.mozilla.net/';
/**
 * Pinned from Firefox's Remote Settings collection `translations-models-v2` (desktop records, version 3.0), the
 * versions tried with the engine. A newer model may need a newer engine, so they are changed together.
 */
export const MODEL_FILES: Record<ModelLang, ModelFile[]> = {
  ko: [
    { part: 'lex', name: 'lex.50.50.enko.s2t.bin', location: 'main-workspace/translations-models-v2/493336e3-8e7b-4223-86c5-e88846a85d46.zst', size: 2675843, sha256: '7216367b7f524c0ae1f39353e5c4622b230d1c2e47924182a5853418c1e69f64', unpackedSize: 6676356, unpackedSha256: '7734265822ce315c72334ad538e698ab3900ab8e8f04bd43768d0aecad6b6df7' },
    { part: 'model', name: 'model.enko.intgemm.alphas.bin', location: 'main-workspace/translations-models-v2/e4e7e781-bd8e-4dae-9f8e-d0c8a8a5b07b.zst', size: 44942689, sha256: 'ebe3a360c2a007e31df8595bc01a856376c195718ed3c0a27b336eb9b349d313', unpackedSize: 59504955, unpackedSha256: '1c310a79b61b8824b2eb26b045db043d92722f3e66ea06998f7c89f48da9f6bc' },
    { part: 'vocab', name: 'vocab.enko.spm', location: 'main-workspace/translations-models-v2/ac6a46cf-1cf0-4ea0-b1ad-9fa40d6f6513.zst', size: 595440, sha256: 'dc5b8d46f6dff08950bf36db741f52431a41466cf33f5a105d1c5154586559d2', unpackedSize: 1406926, unpackedSha256: '709bf0e425345e0e92ce41ed84348a1296a2107c92bdb6624404450ffecbd1f9' },
  ],
  ja: [
    { part: 'lex', name: 'lex.50.50.enja.s2t.bin', location: 'main-workspace/translations-models-v2/83e22dc9-40c4-4ac1-8c25-5d3877b5f628.zst', size: 1751977, sha256: '8954d5b63432366992b22ad2aaa11895e2643014835049fe677655540a705915', unpackedSize: 4128360, unpackedSha256: 'edfb7eb47b98a2689b804ab3614c31b24f1257aa54b1154da3d85e1ae8152d9f' },
    { part: 'trgvocab', name: 'trgvocab.enja.spm', location: 'main-workspace/translations-models-v2/e54d177c-1131-4fbf-90ea-6741a98d6675.zst', size: 361180, sha256: '5384abf34f0e1298f795bd14909a577272059041e60f91a5eb10500e35d0ee98', unpackedSize: 827144, unpackedSha256: '3b3d9f8f3a034d98d0a476f1794fa79c01e4e98a967ceb6777a66ba2d03ec1e1' },
    { part: 'srcvocab', name: 'srcvocab.enja.spm', location: 'main-workspace/translations-models-v2/d10e4482-b9ba-4565-ab44-5ba3cebcf94b.zst', size: 345747, sha256: 'dd1e93d625d9a8d8a42f75255343f302ea37527933eda1a490652b66a7408a64', unpackedSize: 796275, unpackedSha256: '970c98d174fc01e0339fbabbf45af36a4be3f26f819ec1a5ea1189f71e091889' },
    { part: 'model', name: 'model.enja.intgemm.alphas.bin', location: 'main-workspace/translations-models-v2/a01a5318-41c7-4266-8fe1-66c105d6d711.zst', size: 32431590, sha256: 'f92259b9904812350b71f440c3328f3e2e856f31c1a3ab6002756380dd908e00', unpackedSize: 43849787, unpackedSha256: '59ae659f9bb63e4f81f474fe3c03d3f4499434b5f9e779fab7c12a45f31fd562' },
  ],
};

/** The address the page reads the files from (outside /api: the engine's fetch sends no X-Skill-Finder header). */
export const MODEL_URL_PATH = '/translate-models';
const FILE_TIMEOUT_MS = 5 * 60 * 1000;

export type ModelStatus = { lang: ModelLang; state: 'absent' | 'downloading' | 'ready' | 'error'; received: number; total: number; error: string | null };

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const pairDir = (lang: ModelLang) => `en${lang}`;
/** Written last, so a half-finished download is never taken for a model. Its content names the pinned files. */
const READY = 'ready.json';

export class TranslateModels {
  private readonly dir: string;
  private readonly fetchImpl: typeof fetch;
  private readonly files: Record<ModelLang, ModelFile[]>;
  private readonly running = new Map<ModelLang, ModelStatus>();

  /** `dir`: where the unpacked files live (`<dataDir>/translate-models`), served as {@link MODEL_URL_PATH}. `files`: tests. */
  constructor(dir: string, fetchImpl: typeof fetch = (...a) => fetch(...a), files = MODEL_FILES) {
    this.dir = dir;
    this.fetchImpl = fetchImpl;
    this.files = files;
  }

  get root(): string {
    return this.dir;
  }

  private readyMark(lang: ModelLang): string {
    return JSON.stringify(this.files[lang].map((f) => f.unpackedSha256));
  }

  /** The mark, and every file still there at its size (one deleted by hand or quarantined means download again). */
  private ready(lang: ModelLang): boolean {
    try {
      const dir = join(this.dir, pairDir(lang));
      return readFileSync(join(dir, READY), 'utf8') === this.readyMark(lang) && this.files[lang].every((f) => statSync(join(dir, f.name)).size === f.unpackedSize);
    } catch {
      return false;
    }
  }

  status(lang: ModelLang): ModelStatus {
    const run = this.running.get(lang);
    if (run && run.state !== 'ready') return { ...run };
    const total = this.files[lang].reduce((n, f) => n + f.size, 0);
    return this.ready(lang) ? { lang, state: 'ready', received: total, total, error: null } : { lang, state: 'absent', received: 0, total, error: null };
  }

  /** Starts the download unless it is there or under way; the returned status is polled with {@link status}. */
  start(lang: ModelLang): ModelStatus {
    const now = this.status(lang);
    if (now.state === 'ready' || now.state === 'downloading') return now;
    const run: ModelStatus = { lang, state: 'downloading', received: 0, total: now.total, error: null };
    this.running.set(lang, run);
    this.download(lang, run).then(
      () => (run.state = 'ready'),
      (err: unknown) => {
        run.state = 'error';
        run.error = String((err as Error)?.message ?? err).slice(0, 300);
        console.warn('[translate]', run.error);
      },
    );
    return { ...run };
  }

  private async download(lang: ModelLang, run: ModelStatus): Promise<void> {
    const dir = join(this.dir, pairDir(lang));
    await mkdir(dir, { recursive: true });
    await rm(join(dir, READY), { force: true });
    for (const f of this.files[lang]) {
      const target = join(dir, f.name);
      if (existsSync(target) && sha256(readFileSync(target)) === f.unpackedSha256) {
        run.received += f.size;
        continue;
      }
      // network failures and the time limit in the app's words (they used to show as English runtime messages)
      const failed = (err: unknown) => new Error(`${f.name}: 내려받지 못했습니다 (${(err as Error)?.name === 'TimeoutError' ? '시간 초과' : '연결 실패'})`);
      const res = await this.fetchImpl(CDN + f.location, { signal: AbortSignal.timeout(FILE_TIMEOUT_MS) }).catch((err) => {
        throw failed(err);
      });
      if (!res.ok || !res.body) throw new Error(`${f.name}: 내려받지 못했습니다 (${res.status})`);
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for await (const chunk of res.body) {
          size += chunk.byteLength;
          if (size > f.size) throw new Error(`${f.name}: 크기가 맞지 않습니다`);
          chunks.push(chunk);
          run.received += chunk.byteLength;
        }
      } catch (err) {
        throw size > f.size ? err : failed(err);
      }
      const packed = Buffer.concat(chunks);
      if (sha256(packed) !== f.sha256) throw new Error(`${f.name}: SHA-256이 맞지 않습니다`);
      const unpacked = await promisify(zstdDecompress)(packed);
      if (unpacked.length !== f.unpackedSize || sha256(unpacked) !== f.unpackedSha256) throw new Error(`${f.name}: 압축을 푼 파일이 맞지 않습니다`);
      await writeFile(`${target}.part`, unpacked);
      await rename(`${target}.part`, target);
    }
    await writeFile(join(dir, READY), this.readyMark(lang));
  }

  /**
   * The engine's model registry for the languages that are ready: per pair, its files with their addresses and
   * SHA-256 (the engine checks them again with subresource integrity). The address carries the file's hash, so a
   * browser that kept an older model (cached for good) asks for the new one when the pins change.
   */
  registry(): Record<string, Partial<Record<Part, { name: string; size: number; expectedSha256Hash: string }>>> {
    const out: ReturnType<TranslateModels['registry']> = {};
    for (const lang of MODEL_LANGS) {
      if (!this.ready(lang)) continue;
      out[pairDir(lang)] = Object.fromEntries(
        this.files[lang].map((f) => [
          f.part,
          { name: `${MODEL_URL_PATH}/${pairDir(lang)}/${f.name}?v=${f.unpackedSha256.slice(0, 16)}`, size: f.unpackedSize, expectedSha256Hash: f.unpackedSha256 },
        ]),
      );
    }
    return out;
  }
}
