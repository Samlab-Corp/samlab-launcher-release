import { createHash, createHmac } from 'node:crypto';
import { z } from 'zod';
import { admin, device, equal, HttpError, limitedBody, type Config } from './auth';
import { channel, identifier, serviceId, services } from './model';
import { Manager, resolveTarget } from './manager';
import { Conflict } from './store';
const mutation = z.object({ revision: z.number().int().nonnegative(), service: serviceId, channel, kind: z.enum(['default', 'override', 'stabilized']), deviceId: identifier.optional(), releaseId: identifier.nullable() }).strict().refine(i => i.kind !== 'override' || !!i.deviceId);
const verification = z.object({ revision: z.number().int().nonnegative(), releaseId: identifier }).strict();
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
export class Api {
  private targetCache = new Map<string, { body: string; etag: string }>();
  private cacheRevision = -1;
  constructor(readonly manager: Manager, readonly config: Config) {}
  async handle(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname === '/api/target' && request.method === 'GET') {
        const claims = device(request, this.config);
        if (url.searchParams.get('programId') !== claims.service || (url.searchParams.has('channel') && url.searchParams.get('channel') !== claims.channel)) throw new HttpError(403, 'Target scope mismatch');
        if (!services[claims.service].managed) throw new HttpError(409, 'Client update integration not implemented');
        const s = this.manager.store.snapshot;
        if (s.revision !== this.cacheRevision) { this.targetCache.clear(); this.cacheRevision = s.revision; }
        const key = `${claims.service}:${claims.channel}:${claims.deviceId}`;
        let cached = this.targetCache.get(key);
        if (!cached) {
          const target = resolveTarget(s, claims.service, claims.channel, claims.deviceId);
          if (!target) return json({ error: 'No verified target assigned' }, 404);
          const body = JSON.stringify(target);
          cached = { body, etag: `"${createHash('sha256').update(key).update(body).digest('hex')}"` };
          if (this.targetCache.size >= 10000) this.targetCache.clear();
          this.targetCache.set(key, cached);
        }
        const headers = { 'Cache-Control': 'private, no-cache', Vary: 'Authorization, x-device-id', ETag: cached.etag, 'Content-Type': 'application/json' };
        const matching = request.headers.get('if-none-match')?.split(',').map(s => s.trim().replace(/^W\//, ''));
        if (matching?.includes(cached.etag) || matching?.includes('*')) return new Response(null, { status: 304, headers });
        return new Response(cached.body, { headers });
      }
      if (url.pathname === '/api/webhook' && request.method === 'POST') {
        const body = await limitedBody(request, 256_000);
        const expected = 'sha256=' + createHmac('sha256', this.config.webhookSecret).update(body).digest('hex');
        if (!equal(request.headers.get('x-hub-signature-256') ?? '', expected)) throw new HttpError(401, 'Signature rejected');
        const delivery = z.string().regex(/^[A-Za-z0-9-]{1,100}$/).parse(request.headers.get('x-github-delivery'));
        const event = request.headers.get('x-github-event');
        if (event === 'ping') return json({ ok: true });
        if (event !== 'release') throw new HttpError(400, 'Unsupported event');
        const payload = z.object({ repository: z.object({ full_name: z.string() }) }).parse(JSON.parse(body));
        if (!Object.values(services).some(s => s.repo === payload.repository.full_name)) throw new HttpError(403, 'Unknown repository');
        await this.manager.webhook(delivery);
        return json({ ok: true });
      }
      if (url.pathname.startsWith('/api/admin/')) {
        admin(request, this.config, request.method !== 'GET');
        if (url.pathname === '/api/admin/state' && request.method === 'GET') return json({ ...this.manager.store.snapshot, services, reporting: '미보고 — 단말 보고 연동 미구현' });
        if (request.method === 'POST') {
          const body = JSON.parse(await limitedBody(request));
          if (url.pathname === '/api/admin/select') { await this.manager.select(mutation.parse(body), this.config.adminUser); return json({ revision: this.manager.store.snapshot.revision }); }
          if (url.pathname === '/api/admin/verify') { const i = verification.parse(body); await this.manager.verify(i.releaseId, i.revision, this.config.adminUser); return json({ revision: this.manager.store.snapshot.revision }); }
          if (url.pathname === '/api/admin/reconcile') { z.object({}).strict().parse(body); await this.manager.reconcile(); return json({ revision: this.manager.store.snapshot.revision }); }
        }
      }
      return json({ error: 'Not found' }, 404);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status, e.status === 401 ? { 'WWW-Authenticate': 'Basic realm="Central deployment"' } : {});
      if (e instanceof Conflict) return json({ error: '다른 변경이 먼저 저장되었습니다. 새로고침 후 다시 시도하세요.' }, 409);
      if (e instanceof z.ZodError || e instanceof SyntaxError) return json({ error: 'Invalid input' }, 400);
      return json({ error: '처리 실패: 릴리스 검증 또는 GitHub/저장소 상태를 확인하세요.' }, 503);
    }
  }
}
