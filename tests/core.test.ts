import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import { Store, Conflict } from '../src/core/store';
import { Github, assetUrl } from '../src/core/github';
import { Manager } from '../src/core/manager';
import { Api } from '../src/core/api';
import { signDevice, type Config } from '../src/core/auth';
import { type Release, type Service, services } from '../src/core/model';
import { startCollector } from '../src/core/collector';
const bytes = Buffer.from('verified-installer');
const hash = createHash('sha512').update(bytes).digest('base64');
const release = (id = 'stable-1', ch: 'stable' | 'beta' = 'stable'): Release => ({ id, service: 'letmeup-kiosk-v2', channel: ch, tag: 'v1.0.0', publishedAt: '2026-10-01T00:00:00.000Z', artifact: { version: '1.0.0', url: assetUrl(services['letmeup-kiosk-v2'].repo, 'v1.0.0', 'Setup.exe'), sha512: hash, sizeBytes: bytes.length, fileName: 'Setup.exe' }, candidate: null, verifiedAt: '2026-10-01T00:00:00.000Z', issue: null });
const c: Config = { dataDir: '', origin: 'http://localhost:3022', adminUser: 'operator', adminPassword: 'test-password'.repeat(4), deviceKey: 'test-device'.repeat(4), webhookSecret: 'test-webhook'.repeat(4) };
async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'central-test-'));
  const store = new Store(); await store.open(dir);
  const manager = new Manager(store, new Github(async () => new Response(bytes)));
  const api = new Api(manager, c);
  return { dir, store, manager, api, async cleanup() { await store.close(); await fs.rm(dir, { recursive: true }); } };
}
async function seed(store: Store) { await store.change(0, 'test', 'seed', 'fixture', s => { s.releases = [release(), release('beta-1', 'beta')]; s.defaults['letmeup-kiosk-v2:stable'] = { releaseId: 'stable-1', detectedAt: '2026-10-01T00:00:00.000Z' }; }); }
function adminRequest(route: string, body?: unknown, origin = c.origin) { return new Request(c.origin + '/api/admin/' + route, { method: body ? 'POST' : 'GET', headers: { authorization: 'Basic ' + Buffer.from(`${c.adminUser}:${c.adminPassword}`).toString('base64'), origin, 'content-type': 'application/json', 'x-csrf-protection': '1' }, ...(body ? { body: JSON.stringify(body) } : {}) }); }
function target(id = 'device-1', ch: 'stable' | 'beta' = 'stable', etag?: string) { return new Request(c.origin + '/api/target?programId=letmeup-kiosk-v2', { headers: { 'x-device-id': id, authorization: 'Bearer ' + signDevice({ deviceId: id, service: 'letmeup-kiosk-v2', channel: ch, exp: Math.floor(Date.now() / 1000) + 3600 }, c.deviceKey), ...(etag ? { 'if-none-match': etag } : {}) } }); }
test('snapshot persists, writes serialize, stale revision conflicts, backup survives corruption', async () => {
  const f = await fixture();
  try {
    await seed(f.store);
    const results = await Promise.allSettled([f.store.change(1, 'test', 'one', '', () => {}), f.store.change(1, 'test', 'two', '', () => {})]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.ok(results.some(r => r.status === 'rejected' && r.reason instanceof Conflict));
    await f.store.close(); const restarted = new Store(); await restarted.open(f.dir); assert.equal(restarted.snapshot.revision, 2); await restarted.close();
    const file = path.join(f.dir, 'central.snapshot.json'); const backup = await fs.readFile(file + '.bak', 'utf8');
    await fs.writeFile(file, '{broken'); const damaged = new Store(); await assert.rejects(damaged.open(f.dir), /damaged/);
    assert.equal(await fs.readFile(file, 'utf8'), '{broken'); assert.equal(await fs.readFile(file + '.bak', 'utf8'), backup);
  } finally { await fs.rm(f.dir, { recursive: true }); }
});
test('process lock, external modification protection, unsafe directory rejection', async () => {
  const f = await fixture(); try {
    await assert.rejects(new Store().open(f.dir), /EEXIST/); await seed(f.store);
    await fs.writeFile(path.join(f.dir, 'central.snapshot.json'), 'broken');
    await assert.rejects(f.store.change(1, 'test', 'bad', '', () => {})); assert.equal(f.store.snapshot.revision, 1);
    await assert.rejects(new Store().open(process.cwd()), /outside/);
  } finally { await f.cleanup(); }
});
test('API authentication, CSRF, channels, revision conflicts and overrides', async () => {
  const f = await fixture(); try { await seed(f.store);
    assert.equal((await f.api.handle(new Request(c.origin + '/api/admin/state'))).status, 401);
    assert.equal((await f.api.handle(new Request(c.origin + '/api/target?programId=letmeup-kiosk-v2', { headers: { 'x-device-id': 'device-1' } }))).status, 401);
    const input = { revision: 1, service: 'letmeup-kiosk-v2', channel: 'stable', kind: 'default', releaseId: 'beta-1' };
    assert.equal((await f.api.handle(adminRequest('select', input, 'https://evil.invalid'))).status, 403);
    assert.equal((await f.api.handle(adminRequest('select', input))).status, 503);
    assert.equal((await f.api.handle(target('device-1', 'beta'))).status, 404);
    assert.equal((await f.api.handle(adminRequest('select', { ...input, releaseId: 'stable-1', kind: 'override', deviceId: 'device-2' }))).status, 200);
    assert.equal((await f.api.handle(adminRequest('select', { ...input, releaseId: 'stable-1' }))).status, 409);
    const oversized = adminRequest('reconcile', { text: 'a'.repeat(65000) }); assert.equal((await f.api.handle(oversized)).status, 413);
    const wrong = target(); wrong.headers.set('x-device-id', 'device-2'); assert.equal((await f.api.handle(wrong)).status, 401);
  } finally { await f.cleanup(); }
});
test('ETag stable across time and unrelated revisions, 304 scope private, no disk/GitHub reads', async () => {
  const f = await fixture(); try { await seed(f.store);
    const first = await f.api.handle(target()); const etag = first.headers.get('etag')!;
    assert.equal(first.status, 200); const body = await first.json(); assert.equal(body.targetVersion, '1.0.0'); assert.equal(body.artifact.sizeBytes, bytes.length);
    assert.equal((await f.api.handle(target('device-1', 'stable', etag))).status, 304);
    assert.equal((await f.api.handle(target('device-2', 'stable', etag))).status, 200);
    await f.store.change(1, 'test', 'unrelated', '', () => {});
    assert.equal((await f.api.handle(target('device-1', 'stable', etag))).status, 304);
    await fs.writeFile(path.join(f.dir, 'central.snapshot.json'), 'broken');
    const cached = await f.api.handle(target()); assert.equal(cached.status, 200); assert.equal(cached.headers.get('cache-control'), 'private, no-cache');
  } finally { await f.cleanup(); }
});
test('artifact actual stream verifies SHA512 and size; unsafe URL and redirected host rejected', async () => {
  const good = new Github(async () => new Response(bytes)); assert.deepEqual(await good.verify(release()), release().artifact);
  await assert.rejects(new Github(async () => new Response('wrong')).verify(release()), /mismatch/);
  const bad = release(); bad.artifact!.url = 'https://evil.invalid/Setup.exe'; await assert.rejects(good.verify(bad), /unavailable/);
  await assert.rejects(new Github(async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/secret' } })).verify(release()), /Untrusted/);
});
test('pagination separates prereleases and skips drafts; metadata linked to exact asset size/hash', async () => {
  const repo = services['letmeup-kiosk-v2'].repo; const urls: string[] = [];
  const entry = (id: number, prerelease: boolean, draft = false) => ({ id, tag_name: 'v1.0.0', draft, prerelease, published_at: '2026-10-01T00:00:00.000Z', assets: [{ name: 'latest.yml', size: 200, browser_download_url: assetUrl(repo, 'v1.0.0', 'latest.yml') }, { name: 'Setup.exe', size: bytes.length, browser_download_url: assetUrl(repo, 'v1.0.0', 'Setup.exe') }] });
  const gh = new Github(async url => { const u = String(url); urls.push(u); if (new URL(u).searchParams.get('page') === '1') return Response.json(Array.from({ length: 100 }, (_, i) => entry(i + 1, false, true))); if (new URL(u).searchParams.get('page') === '2') return Response.json([entry(101, false), entry(102, true)]); return new Response(`version: 1.0.0\npath: Setup.exe\nsha512: ${hash}\nfiles:\n  - url: Setup.exe\n    sha512: ${hash}\n    size: ${bytes.length}\n`); });
  const list = await gh.list('letmeup-kiosk-v2'); assert.equal(list.length, 2); assert.deepEqual(list.map(r => r.channel), ['stable', 'beta']); assert.ok(list.every(r => r.artifact?.sizeBytes === bytes.length)); assert.ok(urls.some(u => u.includes('page=2')));
});
test('webhook signed processing, duplicate id, failure retry, missed events and reversed payloads reconcile authoritative source', async () => {
  const f = await fixture(); try {
    let fail = false; let calls = 0;
    f.manager.github.list = async (service: Service) => { calls++; if (fail) throw new Error('offline'); return service === 'letmeup-kiosk-v2' ? [release()] : []; };
    const webhook = (delivery: string) => { const body = JSON.stringify({ repository: { full_name: services['letmeup-kiosk-v2'].repo }, release: { tag_name: 'old-event' } }); return new Request(c.origin + '/api/webhook', { method: 'POST', body, headers: { 'x-github-delivery': delivery, 'x-github-event': 'release', 'x-hub-signature-256': 'sha256=' + createHmac('sha256', c.webhookSecret).update(body).digest('hex') } }); };
    assert.equal((await f.api.handle(webhook('delivery-1'))).status, 200); const firstCalls = calls;
    assert.equal((await f.api.handle(webhook('delivery-1'))).status, 200); assert.equal(calls, firstCalls);
    const invalid = webhook('delivery-bad'); invalid.headers.set('x-hub-signature-256', 'sha256=bad'); assert.equal((await f.api.handle(invalid)).status, 401);
    fail = true; assert.equal((await f.api.handle(webhook('delivery-2'))).status, 503); assert.equal(f.store.snapshot.deliveries['delivery-2'].status, 'failed');
    fail = false; assert.equal((await f.api.handle(webhook('delivery-2'))).status, 200); assert.equal(f.store.snapshot.deliveries['delivery-2'].attempts, 2);
    await f.manager.reconcile(); assert.equal(f.store.snapshot.releases[0].tag, 'v1.0.0');
    await f.manager.webhook('delivery-old'); assert.equal(f.store.snapshot.releases[0].tag, 'v1.0.0');
  } finally { await f.cleanup(); }
});
test('APK build tags and GitHub digest produce verified SHA512; tampered APK rejected', async () => {
  const repo = services['letmeup-tablet'].repo; const tag = 'v1.0.79+83-beta'; const name = 'app-release-1.0.79+83-beta.apk';
  const entry = { id: 9, tag_name: tag, draft: false, prerelease: true, published_at: '2026-10-01T00:00:00.000Z', assets: [{ name, size: bytes.length, browser_download_url: assetUrl(repo, tag, name), digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex') }] };
  const gh = new Github(async url => String(url).startsWith('https://api.github.com/') ? Response.json([entry]) : new Response(bytes));
  const [r] = await gh.list('letmeup-tablet'); assert.ok(r.candidate); assert.equal(r.artifact, null);
  assert.equal((await gh.verify(r)).sha512, hash);
  await assert.rejects(new Github(async () => new Response(Buffer.alloc(bytes.length))).verify(r), /mismatch/);
});
test('collector runs at startup and periodically with no requests; metadata communication failure retains targets', async () => {
  const f = await fixture(); let calls = 0;
  f.manager.github.list = async (service: Service) => { calls++; return service === 'letmeup-kiosk-v2' ? [release()] : []; };
  await seed(f.store); const stop = startCollector(f.manager, () => {}, 30);
  try {
    await new Promise(resolve => setTimeout(resolve, 180)); stop(); await f.manager.drain(); assert.ok(calls >= Object.keys(services).length * 2);
    f.manager.github.list = async () => { throw new Error('network outage'); };
    await assert.rejects(f.manager.reconcile()); assert.ok(f.store.snapshot.defaults['letmeup-kiosk-v2:stable']); assert.ok(f.store.snapshot.sync.error);
  } finally { stop(); await f.cleanup(); }
});
test('upstream changed artifacts invalidate verification and selected target', async () => {
  const f = await fixture(); try {
    await seed(f.store); const changed = release(); changed.artifact!.sha512 = createHash('sha512').update('changed').digest('base64'); changed.verifiedAt = null;
    f.manager.github.list = async (service: Service) => service === 'letmeup-kiosk-v2' ? [changed] : [];
    await f.manager.reconcile(); assert.equal(f.store.snapshot.defaults['letmeup-kiosk-v2:stable'], undefined); assert.equal((await f.api.handle(target())).status, 404);
  } finally { await f.cleanup(); }
});
test('interrupted metadata transfer does not silently invalidate a working target', async () => {
  const f = await fixture(); try {
    await seed(f.store); const r = release();
    const gh = new Github(async url => {
      if (String(url).startsWith('https://api.github.com/')) return Response.json([{ id: 1, tag_name: r.tag, draft: false, prerelease: false, published_at: r.publishedAt, assets: [{ name: 'latest.yml', size: 200, browser_download_url: assetUrl(services[r.service].repo, r.tag, 'latest.yml') }] }]);
      return new Response(new ReadableStream({ start(controller) { controller.error(new Error('Disconnected')); } }));
    });
    f.manager.github.list = service => gh.list(service);
    await assert.rejects(f.manager.reconcile());
    assert.ok(f.store.snapshot.defaults['letmeup-kiosk-v2:stable']); assert.equal((await f.api.handle(target())).status, 200);
  } finally { await f.cleanup(); }
});
