// Makes the update signing key once and prints its public half (user decision 2026-11-02: signed updates).
// The private key stays in %USERPROFILE%\.skill-finder-release\ (never in the repo, the zip or the site); `npm run
// package` signs meta.json with it, and the launcher and the app check that signature with the public key built
// into them. Lose the private key and installed apps can no longer take updates (reinstall from the page): back
// it up somewhere safe. Usage: node scripts/signing-key.mjs   (does nothing when the key exists)
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const KEY_PATH = process.env.SKILL_FINDER_SIGNING_KEY || join(homedir(), '.skill-finder-release', 'update-signing-key.pem');

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('signing-key.mjs')) {
  if (!existsSync(KEY_PATH)) {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 3072, publicExponent: 0x10001 });
    mkdirSync(dirname(KEY_PATH), { recursive: true });
    writeFileSync(KEY_PATH, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    console.log(`새 서명 키를 만들었습니다: ${KEY_PATH} (안전한 곳에 백업하세요)`);
  } else {
    console.log(`서명 키가 이미 있습니다: ${KEY_PATH}`);
  }
  const pub = createPublicKey(createPrivateKey(readFileSync(KEY_PATH)));
  const jwk = pub.export({ format: 'jwk' });
  const b64 = (s) => Buffer.from(s, 'base64url').toString('base64');
  console.log('\n공개 키 (server/src/release.ts UPDATE_PUBLIC_KEY):');
  console.log(pub.export({ type: 'spki', format: 'pem' }).trim());
  console.log('\n공개 키 (launcher/SkillFinder.cs UpdateKeyModulus / UpdateKeyExponent):');
  console.log(`modulus: ${b64(jwk.n)}`);
  console.log(`exponent: ${b64(jwk.e)}`);
}
