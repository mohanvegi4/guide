import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * Encryption at rest for the one secret we must be able to read back: each
 * app's visitor-signing secret (HS256 needs the raw key to verify). AES-256-GCM
 * with a key from SECRETS_KEY (32 bytes, hex or base64), stored as
 *   enc:v1:<iv>:<tag>:<ciphertext>   (base64 parts)
 * A value without the prefix is legacy plaintext and is read as-is, so a
 * deployment can turn encryption on and re-encrypt existing rows with
 * `npm run encrypt-secrets` at its own pace. Production refuses to start
 * without SECRETS_KEY (src/production.ts).
 */
const PREFIX = 'enc:v1:';
const ALGORITHM = 'aes-256-gcm';

export function parseSecretsKey(raw: string | undefined): Buffer | null {
  if (!raw) return null;
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  const b64 = Buffer.from(raw, 'base64');
  if (b64.length === 32) return b64;
  throw new Error('SECRETS_KEY must be 32 bytes: 64 hex characters (openssl rand -hex 32) or base64.');
}

let cached: Buffer | null | undefined;

/** The process-wide key, read once; null when encryption is off (development). */
export function getSecretsKey(env: NodeJS.ProcessEnv = process.env): Buffer | null {
  if (cached === undefined) cached = parseSecretsKey(env.SECRETS_KEY);
  return cached;
}

/** @internal tests only */
export function resetSecretsKeyForTests(): void {
  cached = undefined;
}

export function isEncrypted(stored: string): boolean {
  return stored.startsWith(PREFIX);
}

/** Encrypts for storage; without a key (development) the value is stored as-is. */
export function encryptSecret(plain: string, key: Buffer | null): string {
  if (!key) return plain;
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + [iv, tag, ciphertext].map((b) => b.toString('base64')).join(':');
}

/**
 * Reads a stored value back. Throws on a missing key, a wrong key or a
 * tampered value — callers decide whether that's fatal (scripts) or
 * "no secret" (the agent, which then fails closed).
 */
export function decryptSecret(stored: string, key: Buffer | null): string {
  if (!isEncrypted(stored)) return stored;
  if (!key) throw new Error('A stored secret is encrypted but SECRETS_KEY is not set.');
  const [iv, tag, ciphertext] = stored
    .slice(PREFIX.length)
    .split(':')
    .map((p) => Buffer.from(p, 'base64'));
  if (!iv || !tag || !ciphertext) throw new Error('Malformed encrypted secret.');
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
