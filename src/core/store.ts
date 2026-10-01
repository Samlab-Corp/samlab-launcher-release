import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { emptySnapshot, validateSnapshot, type Snapshot } from './model';
export class Conflict extends Error {}
export class Store {
  private state = emptySnapshot();
  private queue: Promise<unknown> = Promise.resolve();
  private lock: fs.FileHandle | undefined;
  private lockPath = '';
  private file = '';
  get snapshot(): Readonly<Snapshot> { return this.state; }
  async open(directory: string, project = process.cwd()) {
    if (!path.isAbsolute(directory)) throw new Error('DATA_DIR must be absolute');
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const real = await fs.realpath(directory);
    const root = await fs.realpath(project);
    if (real === root || real.startsWith(root + path.sep)) throw new Error('DATA_DIR must be outside project/public/build');
    this.file = path.join(real, 'central.snapshot.json');
    this.lockPath = path.join(real, 'central.lock');
    this.lock = await fs.open(this.lockPath, 'wx', 0o600);
    await this.lock.writeFile(String(process.pid));
    try {
      try { this.state = freeze(validateSnapshot(JSON.parse(await fs.readFile(this.file, 'utf8')))); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Snapshot damaged; restore explicitly from backup before starting');
        // A missing primary with a backup is not a new installation.
        try { await fs.access(this.file + '.bak'); } catch (backupError) {
          if ((backupError as NodeJS.ErrnoException).code === 'ENOENT') return;
          throw backupError;
        }
        throw new Error('Primary missing; restore backup explicitly');
      }
    } catch (e) { await this.close(); throw e; }
  }
  async close() { await this.queue.catch(() => {}); await this.lock?.close(); this.lock = undefined; if (this.lockPath) await fs.unlink(this.lockPath); }
  private async atomic(file: string, content: string) {
    const tmp = `${file}.${randomUUID()}.tmp`;
    const handle = await fs.open(tmp, 'wx', 0o600);
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    try { await fs.rename(tmp, file); } catch (e) { await fs.unlink(tmp).catch(() => {}); throw e; }
    if (process.platform !== 'win32') { const dir = await fs.open(path.dirname(file), 'r'); try { await dir.sync(); } finally { await dir.close(); } }
  }
  change(expected: number | null, actor: string, action: string, detail: string, mutate: (s: Snapshot) => void): Promise<Snapshot> {
    const operation = this.queue.then(async () => {
      if (!this.lock) throw new Error('Store closed');
      if (expected !== null && expected !== this.state.revision) throw new Conflict('Revision conflict; refresh');
      const next = structuredClone(this.state);
      mutate(next); next.revision++;
      next.history.push({ revision: next.revision, at: new Date().toISOString(), actor, action, detail });
      validateSnapshot(next);
      // Preserve last validated on-disk contents; never copy a damaged external file into backup.
      try {
        const disk = validateSnapshot(JSON.parse(await fs.readFile(this.file, 'utf8')));
        if (disk.revision !== this.state.revision) throw new Error('External snapshot modification');
        await this.atomic(this.file + '.bak', JSON.stringify(disk));
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || this.state.revision !== 0) throw e; }
      await this.atomic(this.file, JSON.stringify(next));
      this.state = freeze(next);
      return next;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
function freeze<T>(object: T): T { if (object && typeof object === 'object') { Object.freeze(object); for (const v of Object.values(object)) freeze(v); } return object; }
