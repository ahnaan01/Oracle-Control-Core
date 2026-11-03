import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
export const randomToken = () => randomBytes(32).toString('base64url');
export const hashToken = (value: string) => createHash('sha256').update(value).digest('hex');
export function equal(a: string, b: string) {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export async function hashPassword(password: string, salt = randomBytes(16).toString('hex')) {
  const hash = await new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 64,
    { N: 65536, maxmem: 128 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
  return `scrypt$${salt}$${hash.toString('hex')}`;
}
export async function verifyPassword(password: string, encoded: string | undefined) {
  const [, salt] = (encoded ?? 'scrypt$00000000000000000000000000000000$invalid').split('$');
  const actual = await hashPassword(password, salt);
  return encoded !== undefined && equal(actual, encoded);
}
