import { createHmac, timingSafeEqual } from 'node:crypto';
interface Claims { sub: string; sid: string; env: 'sandbox' | 'live'; exp: number }
const secret = () => {
  const value = process.env.CREDITS_SESSION_SECRET || '';
  if (value.length < 32) throw Object.assign(new Error('Credit session signing unavailable'), { statusCode: 503 });
  return value;
};
export function signSession(claims: Claims): string {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `credits-${body}.${createHmac('sha256', secret()).update(body).digest('base64url')}`;
}
export function verifySession(token: string, owner: string, environment: string): Claims {
  const invalid = () => Object.assign(new Error('Invalid credit session'), { statusCode: 401 });
  if (!token.startsWith('credits-') || token.length > 2048) throw invalid();
  const [body, signature, ...extra] = token.slice(8).split('.');
  const expected = createHmac('sha256', secret()).update(body).digest();
  const received = Buffer.from(signature || '', 'base64url');
  if (extra.length || received.length !== expected.length || !timingSafeEqual(expected, received)) throw invalid();
  let claims: Claims;
  try { claims = JSON.parse(Buffer.from(body, 'base64url').toString()); } catch { throw invalid(); }
  if (!claims || claims.sub !== owner || claims.env !== environment || !Number.isSafeInteger(claims.exp) || claims.exp <= Math.floor(Date.now() / 1000) || typeof claims.sid !== 'string' || !claims.sid || claims.sid.length > 128) throw invalid();
  return claims;
}
