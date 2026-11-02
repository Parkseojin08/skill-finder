// Signed releases (user decision 2026-11-02). meta.json on the download page carries two RSA-SHA256 signatures
// made with a key that stays on the publisher's PC: one over the version, size and SHA-256 of the zip (the
// launcher refuses an update without it), one over the version's change notes (the app shows only signed notes).
// The packaging script signs with these same messages; the launcher (SkillFinder.cs) builds the first one too.
import { createPublicKey, createSign, createVerify, type KeyLike } from 'node:crypto';

/** The public half of the update key (scripts/signing-key.mjs prints it). */
export const UPDATE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEA50og4Fe91nQ3nmlDU7re
kr9MMNwiBVLBCM+7vTkq+mD0wJerPGWTcoOhgGL6iv8TQxLSv2bEBBgdQUdePolH
0y93To9hM+HrVCQMhUBPmXDcfanWzFAH2XkoXJsR+oPdoESHaiFUNq34/2CzVktB
4/7OPqMkJd3mUEQmq3w5HehPn4CFnPiKNM5tMG54aC9xhaFQhMqINWDFDhy/Jawa
zHxMn5hBnlQNFZl8k9P1BzC2LbeDX9CYvqiXTs6uldBAXFbQqJ6vA0YkGsQlzvDD
k/rim028c+/JRoI4j5BlRFoGZRkh7JM5+btW6+vkZBrC1hEkjB9e5eEAs5RGHWiD
/IuYk06BSLFom4OsJAgN1t4eQ1hEB7gJu4rwt+RDE3NA5lkjpM+aGBEtwYC4l0P7
rkRMwcZ/RKWtiFwORX55RAe+U0QqklUAS3S3L1gEP/eUBueWCCHA9Nn7EXr34avh
hrmNQN0G+G7gvFiX5M48Rne1QAB125U5bSX6lqCxmIsdAgMBAAE=
-----END PUBLIC KEY-----`;

export type ReleaseMeta = { version: string; bytes: number; sha256: string; notes?: string[] };

/** What the release signature covers; the launcher builds the same text. */
export const releaseMessage = (m: Pick<ReleaseMeta, 'version' | 'bytes' | 'sha256'>) => `skill-finder-update v1\n${m.version}\n${m.bytes}\n${m.sha256}`;
/** What the notes signature covers: one line per note (line breaks inside a note become spaces). */
export const notesMessage = (version: string, notes: string[]) => `skill-finder-notes v1\n${version}\n${notes.map((n) => n.replace(/\s+/g, ' ').trim()).join('\n')}`;

export function signText(text: string, privateKey: KeyLike): string {
  return createSign('sha256').update(text).sign(privateKey, 'base64');
}

export function verifyText(text: string, signature: unknown, publicKey: KeyLike = UPDATE_PUBLIC_KEY): boolean {
  if (typeof signature !== 'string' || !/^[A-Za-z0-9+/]{100,1000}={0,2}$/.test(signature)) return false;
  try {
    return createVerify('sha256').update(text).verify(typeof publicKey === 'string' ? createPublicKey(publicKey) : publicKey, signature, 'base64');
  } catch {
    return false;
  }
}

/** The notes of a meta.json, when they are signed; anything else is not shown. */
export function signedNotes(meta: Record<string, unknown>, version: string, publicKey?: KeyLike): string[] {
  const notes = meta.notes;
  if (!Array.isArray(notes) || notes.length > 30 || !notes.every((n) => typeof n === 'string' && n.length <= 300)) return [];
  return verifyText(notesMessage(version, notes as string[]), meta.notesSignature, publicKey) ? (notes as string[]) : [];
}
