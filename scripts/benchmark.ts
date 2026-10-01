import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { Store } from '../src/core/store';
import { Github, assetUrl } from '../src/core/github';
import { Manager } from '../src/core/manager';
import { Api } from '../src/core/api';
import { signDevice, type Config } from '../src/core/auth';
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'central-benchmark-'));
const store = new Store(); await store.open(dir);
const config: Config = { dataDir: dir, origin: 'http://127.0.0.1', adminUser: 'benchmark', adminPassword: randomBytes(32).toString('hex'), deviceKey: randomBytes(32).toString('hex'), webhookSecret: randomBytes(32).toString('hex') };
const manager = new Manager(store, new Github(async () => { throw new Error('Unexpected upstream call'); }));
await store.change(0, 'benchmark', 'seed', 'local fixture only', s => {
  s.releases = [{ id: 'fixture', service: 'letmeup-kiosk-v2', channel: 'stable', tag: 'v1.0.0', publishedAt: '2026-10-01T00:00:00.000Z', artifact: { version: '1.0.0', url: assetUrl('Samlab-Corp/letmeup-kiosk-v2-release', 'v1.0.0', 'Setup.exe'), fileName: 'Setup.exe', sha512: createHash('sha512').update('fixture').digest('base64'), sizeBytes: 7 }, candidate: null, verifiedAt: '2026-10-01T00:00:00.000Z', issue: null }];
  s.defaults['letmeup-kiosk-v2:stable'] = { releaseId: 'fixture', detectedAt: '2026-10-01T00:00:00.000Z' };
});
const api = new Api(manager, config);
const server = http.createServer(async (req, res) => {
  const response = await api.handle(new Request('http://127.0.0.1' + req.url, { headers: req.headers as Record<string, string> }));
  res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as { port: number }).port;
const latencies: number[] = []; let failures = 0; const concurrency = 32; const count = 10000; const start = performance.now();
try {
  await Promise.all(Array.from({ length: concurrency }, async (_, worker) => {
    const deviceId = `bench-${worker}`;
    const headers = { authorization: 'Bearer ' + signDevice({ deviceId, service: 'letmeup-kiosk-v2', channel: 'stable', exp: Math.floor(Date.now() / 1000) + 3600 }, config.deviceKey), 'x-device-id': deviceId };
    for (let i = worker; i < count; i += concurrency) {
      const t = performance.now(); const r = await fetch(`http://127.0.0.1:${port}/api/target?programId=letmeup-kiosk-v2`, { headers }); await r.arrayBuffer(); if (r.status !== 200) failures++; latencies.push(performance.now() - t);
    }
  }));
  const elapsed = performance.now() - start; latencies.sort((a, b) => a - b);
  console.log(JSON.stringify({ kind: 'local-loopback-http-fixture', node: process.version, platform: process.platform, requests: count, concurrency, failures, elapsedMs: Math.round(elapsed), requestsPerSecond: Math.round(count * 1000 / elapsed), p50Ms: +latencies[Math.floor(count * .5)].toFixed(2), p95Ms: +latencies[Math.floor(count * .95)].toFixed(2), p99Ms: +latencies[Math.floor(count * .99)].toFixed(2), note: 'Local fixture excludes TLS/nginx/production network and real device load' }, null, 2));
} finally { await new Promise<void>(resolve => server.close(() => resolve())); await store.close(); await fs.rm(dir, { recursive: true }); }
