import http from 'node:http';
import { Readable } from 'node:stream';
import next from 'next';
import { config, admin, HttpError } from './src/core/auth';
import { Store } from './src/core/store';
import { Github } from './src/core/github';
import { Manager } from './src/core/manager';
import { Api } from './src/core/api';
import { startCollector } from './src/core/collector';
const development = process.argv.includes('--dev');
const c = config(development);
const store = new Store(); await store.open(c.dataDir);
const manager = new Manager(store, new Github(fetch, c.githubToken));
const api = new Api(manager, c);
const app = next({ dev: development, hostname: '127.0.0.1', port: Number(process.env.PORT ?? 3022) });
await app.prepare();
const handler = app.getRequestHandler();
let shuttingDown = false;
// Starts independently of traffic; one process owns the durable store and collector.
const stopCollector = startCollector(manager, () => { console.error('Catalog reconciliation failed; inspect authenticated admin status'); });
const server = http.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url ?? '/', c.origin).pathname;
    const headers = new Headers(); for (const [name, value] of Object.entries(req.headers)) if (value) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    const init: RequestInit & { duplex?: 'half' } = { method: req.method, headers };
    if (!['GET', 'HEAD'].includes(req.method ?? 'GET')) { init.body = Readable.toWeb(req) as ReadableStream; init.duplex = 'half'; }
    const request = new Request(new URL(req.url ?? '/', c.origin), init);
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'same-origin');
    if (pathname.startsWith('/api/')) {
      const response = await api.handle(request); res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined); return;
    }
    admin(request, c);
    res.setHeader('Cache-Control', 'no-store');
    await handler(req, res);
  } catch (e) {
    if (!res.headersSent) { res.statusCode = e instanceof HttpError ? e.status : 503; if (res.statusCode === 401) res.setHeader('WWW-Authenticate', 'Basic realm="Central deployment"'); }
    res.end('Request rejected');
  }
});
server.requestTimeout = 180_000; server.headersTimeout = 15_000;
server.listen(Number(process.env.PORT ?? 3022), '127.0.0.1', () => console.log('Central deployment listening on loopback'));
async function stop() { if (shuttingDown) return; shuttingDown = true; stopCollector(); await new Promise<void>(resolve => server.close(() => resolve())); await manager.drain(); await store.close(); process.exit(0); }
process.on('SIGTERM', () => void stop()); process.on('SIGINT', () => void stop());
