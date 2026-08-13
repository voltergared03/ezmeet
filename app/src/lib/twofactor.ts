import crypto from 'node:crypto';
import { authSecretOrDev } from './secret';

/**
 * Two-factor helpers: encrypt the TOTP secret at rest (AES-256-GCM),
 * generate/verify single-use backup codes, and sign/verify the
 * short-lived "2FA passed" cookie. All keys derive from AUTH_SECRET.
 */

const SECRET = authSecretOrDev();

export const TWOFA_COOKIE = 'eam_2fa';
const SESSION_TTL_SEC = 12 * 60 * 60; // re-prompt after 12h / on a new device

// scrypt is a deliberately slow KDF — ~75 ms per derivation on the prod host — and
// scryptSync BLOCKS the event loop for every millisecond of it. The key depends only on
// (AUTH_SECRET, purpose), both fixed for the life of the process, so derive each one once.
// Uncached, every signed inbound webhook paid 75 ms of blocking CPU just to decrypt the
// shared secret, which capped the whole server at ~13 requests/second: a burst of ClickUp
// deliveries on 2026-08-13 stalled behind it until ClickUp timed the deliveries out and
// suspended the webhook.
const keyCache = new Map<string, Buffer>();

function keyFor(purpose: string): Buffer {
  let key = keyCache.get(purpose);
  if (!key) {
    key = crypto.scryptSync(SECRET, `eam-2fa-${purpose}`, 32);
    keyCache.set(purpose, key);
  }
  return key;
}

// Cookie HMAC key — derived with SHA-256 (NOT scrypt) so the Edge middleware
// (Web Crypto, which has no scrypt) can reproduce the exact same key.
// Keep in sync with lib/twofactor-edge.ts.
function cookieKey(): Buffer {
  return crypto.createHash('sha256').update(`${SECRET}|eam-2fa-cookie-v1`).digest();
}

/* ── TOTP secret encryption at rest (AES-256-GCM) ───────────────── */

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFor('enc'), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${ct.toString('base64url')}`;
}

export function decryptSecret(enc: string | null | undefined): string {
  if (!enc) return '';
  try {
    const [v, ivB, tagB, ctB] = enc.split('.');
    if (v !== 'v1' || !ivB || !tagB || !ctB) return '';
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyFor('enc'), Buffer.from(ivB, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(ctB, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

/* ── Backup codes ───────────────────────────────────────────────── */

const BACKUP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O/1/I

export function hashBackupCode(code: string): string {
  const norm = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return crypto.createHmac('sha256', keyFor('backup')).update(norm).digest('hex');
}

export function generateBackupCodes(count = 10): { plain: string[]; hashed: string[] } {
  const plain: string[] = [];
  const hashed: string[] = [];
  for (let i = 0; i < count; i++) {
    const rnd = crypto.randomBytes(8);
    let code = '';
    for (let j = 0; j < 8; j++) code += BACKUP_ALPHABET[rnd[j] % BACKUP_ALPHABET.length];
    const formatted = `${code.slice(0, 4)}-${code.slice(4)}`;
    plain.push(formatted);
    hashed.push(hashBackupCode(formatted));
  }
  return { plain, hashed };
}

/** Returns the index of a matching (still-unused) backup code, or -1. */
export function matchBackupCode(hashes: string[] | null | undefined, code: string): number {
  if (!Array.isArray(hashes) || hashes.length === 0) return -1;
  const target = hashBackupCode(code);
  for (let i = 0; i < hashes.length; i++) {
    const h = hashes[i];
    if (typeof h === 'string' && h.length === target.length &&
        crypto.timingSafeEqual(Buffer.from(h), Buffer.from(target))) {
      return i;
    }
  }
  return -1;
}

/* ── "2FA passed" cookie (HMAC, bound to userId, time-limited) ───── */

export function makeTwoFactorCookie(userId: string, ttlSec = SESSION_TTL_SEC): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const sig = crypto.createHmac('sha256', cookieKey()).update(`${userId}.${exp}`).digest('base64url');
  return `${exp}.${sig}`;
}

export function verifyTwoFactorCookie(value: string | undefined, userId: string): boolean {
  if (!value) return false;
  const [expS, sig] = value.split('.');
  const exp = parseInt(expS, 10);
  if (!exp || !sig) return false;
  if (exp < Math.floor(Date.now() / 1000)) return false;
  const expected = crypto.createHmac('sha256', cookieKey()).update(`${userId}.${exp}`).digest('base64url');
  if (expected.length !== sig.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
}

export const TWOFA_COOKIE_OPTS = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax' as const,
  path: '/',
  maxAge: SESSION_TTL_SEC,
};
