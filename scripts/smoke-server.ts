import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'central-smoke-'));
const socket = net.createServer(); await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve));
const port = (socket.address() as net.AddressInfo).port; await new Promise<void>(resolve => socket.close(() => resolve()));
const origin = `http://127.0.0.1:${port}`;
const password = randomBytes(32).toString('hex');
// Ephemeral fixture keys are passed via process environment, never logged or stored.
const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], { env: { ...process.env, DATA_DIR: dir, APP_ORIGIN: origin, PORT: String(port), ADMIN_USER: 'smoke', ADMIN_PASSWORD: password, DEVICE_SIGNING_KEY: randomBytes(32).toString('hex'), GITHUB_WEBHOOK_SECRET: randomBytes(32).toString('hex'), NODE_ENV: 'production' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let output = ''; child.stdout.on('data', b => { output += b.toString(); }); child.stderr.on('data', b => { output += b.toString(); });
try {
  const deadline = Date.now() + 60000;
  while (!output.includes('listening on loopback')) { if (child.exitCode !== null || Date.now() > deadline) throw new Error('Server did not start: ' + output); await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.equal((await fetch(origin)).status, 401);
  const headers = { authorization: 'Basic ' + Buffer.from(`smoke:${password}`).toString('base64') };
  const page = await fetch(origin, { headers }); assert.equal(page.status, 200); assert.match(await page.text(), /앱 버전 관리/);
  const state = await fetch(origin + '/api/admin/state', { headers }); assert.equal(state.status, 200); assert.ok((await state.json()).services['classup-tablet']);
  assert.equal((await fetch(origin + '/api/target?programId=letmeup-kiosk-v2')).status, 401);
  console.log('Production custom server smoke passed: page/API authentication, authenticated HTML, service catalog');
} finally {
  child.kill('SIGTERM'); await new Promise<void>(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', () => resolve()); });
  // Test-owned absolute directory created by mkdtemp; force-termination on Windows can leave a lock.
  await fs.rm(dir, { recursive: true });
}
