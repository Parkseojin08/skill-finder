// Writes the prebuilt index a release ships (server/src/db/seed.ts): the default marketplaces' plugins, their
// skills and repo star counts from a local index, nothing personal. The package scripts run it.
//   node scripts/export-seed.mjs [<index.db>] <out.json.gz>     (index: data/skill-finder.db)
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeSeedFile } from '../server/src/db/seed.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const [db, out] = args.length >= 2 ? [resolve(args[0]), resolve(args[1])] : [join(ROOT, 'data', 'skill-finder.db'), args[0] && resolve(args[0])];
if (!out) {
  console.error('사용법: node scripts/export-seed.mjs [<index.db>] <out.json.gz>');
  process.exit(2);
}
if (!existsSync(db)) {
  console.error(`색인 파일이 없습니다: ${db}`);
  process.exit(1);
}
const r = writeSeedFile(db, out);
console.log(`미리 만든 색인: 플러그인 ${r.plugins}개, 스킬 ${r.skills}개, 저장소 ${r.repos}개, ${(r.bytes / 1024 / 1024).toFixed(1)}MB → ${out}`);
