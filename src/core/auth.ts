import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { channel, identifier, serviceId } from './model';
export interface Config { dataDir: string; origin: string; adminUser: string; adminPassword: string; deviceKey: string; webhookSecret: string; githubToken?: string; localAdminAuthDisabled?: boolean }
export function config(development = false): Config {
  const required = (name: string) => { const value = process.env[name]; if (!value || value.startsWith('REPLACE_')) throw new Error(`Missing ${name}`); return value; };
  const c = { dataDir: required('DATA_DIR'), origin: required('APP_ORIGIN'), adminUser: required('ADMIN_USER'), adminPassword: required('ADMIN_PASSWORD'), deviceKey: required('DEVICE_SIGNING_KEY'), webhookSecret: required('GITHUB_WEBHOOK_SECRET'), githubToken: process.env.GITHUB_TOKEN };
  const localAdminAuthDisabled = process.env.LOCAL_ADMIN_AUTH_DISABLED === '1';
  if (localAdminAuthDisabled && (!development || process.env.NODE_ENV === 'production' || !['http://localhost:3022', 'http://127.0.0.1:3022'].includes(c.origin))) throw new Error('Authentication bypass requires local development on port 3022');
  if ([c.adminPassword, c.deviceKey, c.webhookSecret].some(s => s.length < 32)) throw new Error('Secrets require at least 32 characters');
  if (!identifier.safeParse(c.adminUser).success) throw new Error('Invalid ADMIN_USER');
  const url = new URL(c.origin); if (url.origin !== c.origin || (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('Invalid APP_ORIGIN');
  return { ...c, localAdminAuthDisabled };
}
export function equal(a: string, b: string) { return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest()); }
export function admin(request: Request, c: Config, write = false) {
  const expected = 'Basic ' + Buffer.from(`${c.adminUser}:${c.adminPassword}`).toString('base64');
  if (!c.localAdminAuthDisabled && !equal(request.headers.get('authorization') ?? '', expected)) throw new HttpError(401, 'Authentication required');
  if (write && (request.headers.get('origin') !== c.origin || request.headers.get('x-csrf-protection') !== '1' || !request.headers.get('content-type')?.startsWith('application/json'))) throw new HttpError(403, 'Origin/CSRF rejected');
}
const claimsSchema = z.object({ deviceId: identifier, service: serviceId, channel, exp: z.number().int().positive() }).strict();
export type Claims = z.infer<typeof claimsSchema>;
export function signDevice(claims: Claims, key: string) { const payload = Buffer.from(JSON.stringify(claimsSchema.parse(claims))).toString('base64url'); return `${payload}.${createHmac('sha256', key).update(payload).digest('base64url')}`; }
export function device(request: Request, c: Config): Claims {
  const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
  if (token.length > 2000) throw new HttpError(401, 'Invalid device token');
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra || !equal(signature, createHmac('sha256', c.deviceKey).update(payload).digest('base64url'))) throw new HttpError(401, 'Invalid device token');
  let claims: Claims;
  try { claims = claimsSchema.parse(JSON.parse(Buffer.from(payload, 'base64url').toString())); } catch { throw new HttpError(401, 'Invalid device claims'); }
  if (claims.exp <= Date.now() / 1000 || request.headers.get('x-device-id') !== claims.deviceId) throw new HttpError(401, 'Device mismatch/expired');
  return claims;
}
export class HttpError extends Error { constructor(public status: number, message: string) { super(message); } }
export async function limitedBody(request: Request, max = 64_000) {
  if (Number(request.headers.get('content-length')) > max) throw new HttpError(413, 'Body too large');
  const reader = request.body?.getReader(); if (!reader) return '';
  const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const r = await reader.read(); if (r.done) break; size += r.value.length; if (size > max) throw new HttpError(413, 'Body too large'); chunks.push(r.value); } } finally { await reader.cancel(); }
  return Buffer.concat(chunks).toString('utf8');
}
