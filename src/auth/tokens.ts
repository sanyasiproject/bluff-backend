import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 256-bit random bearer token; only its hash goes to the database */
export function newToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/** compares two secrets without leaking length or content through timing */
export function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}
