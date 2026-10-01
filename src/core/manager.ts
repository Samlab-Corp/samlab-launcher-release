import { Github } from './github';
import { Store, Conflict } from './store';
import { services, scope, type Snapshot, type Service, type Channel, type Release } from './model';
export class Manager {
  private flight: Promise<void> | undefined;
  private webhookQueue: Promise<unknown> = Promise.resolve();
  constructor(readonly store: Store, readonly github: Github) {}
  async drain() { await this.webhookQueue.catch(() => {}); await this.flight?.catch(() => {}); }
  reconcile(): Promise<void> {
    if (this.flight) return this.flight;
    this.flight = this.collect().finally(() => { this.flight = undefined; });
    return this.flight;
  }
  private async collect() {
    try {
      const collected: Release[] = [];
      // Sequential to avoid a burst against GitHub rate limits.
      for (const service of Object.keys(services) as Service[]) collected.push(...await this.github.list(service));
      await this.store.change(null, 'collector', 'reconcile', `${collected.length} releases`, s => {
        const old = new Map(s.releases.map(r => [r.id, r]));
        s.releases = collected.map(r => {
          const previous = old.get(r.id);
          // Keep verification only while upstream metadata remains identical.
          if (previous && JSON.stringify(previous.candidate) === JSON.stringify(r.candidate) && (JSON.stringify(previous.artifact) === JSON.stringify(r.artifact) || (!r.artifact && r.candidate && previous.verifiedAt))) return { ...r, artifact: previous.artifact, verifiedAt: previous.verifiedAt, issue: previous.verifiedAt ? null : r.issue };
          return r;
        });
        for (const map of [s.defaults, s.overrides, s.stabilized]) for (const [key, sel] of Object.entries(map)) {
          const r = s.releases.find(r => r.id === sel.releaseId);
          if (!r?.artifact || !r.verifiedAt || !key.startsWith(scope(r.service, r.channel))) delete map[key];
        }
        s.sync = { at: new Date().toISOString(), error: null };
        // Full authoritative refresh repairs pending deliveries after a crash.
        for (const d of Object.values(s.deliveries)) if (d.status !== 'done') { d.status = 'done'; d.error = null; d.at = s.sync.at!; }
      });
    } catch {
      await this.store.change(null, 'collector', 'reconcile-failed', 'GitHub collection failed; last catalog retained', s => { s.sync.error = 'GitHub 수집 실패; 마지막 정상 카탈로그 유지'; });
      throw new Error('GitHub collection failed');
    }
  }
  async verify(id: string, revision: number, actor: string) {
    if (revision !== this.store.snapshot.revision) throw new Conflict('Revision conflict');
    const release = this.store.snapshot.releases.find(r => r.id === id);
    if (!release) throw new Error('Unknown release');
    const artifact = await this.github.verify(release);
    return this.store.change(revision, actor, 'verify-artifact', id, s => { const r = s.releases.find(r => r.id === id)!; r.artifact = artifact; r.verifiedAt = new Date().toISOString(); r.issue = null; });
  }
  select(input: { service: Service; channel: Channel; kind: 'default' | 'override' | 'stabilized'; deviceId?: string; releaseId: string | null; revision: number }, actor: string) {
    return this.store.change(input.revision, actor, input.kind, `${input.service}/${input.channel}/${input.deviceId ?? 'all'} -> ${input.releaseId ?? 'clear'}`, s => {
      const key = scope(input.service, input.channel) + (input.kind === 'override' ? `:${input.deviceId}` : '');
      const map = input.kind === 'default' ? s.defaults : input.kind === 'override' ? s.overrides : s.stabilized;
      if (input.releaseId === null) { delete map[key]; return; }
      const r = s.releases.find(r => r.id === input.releaseId && r.service === input.service && r.channel === input.channel);
      if (!r?.artifact || !r.verifiedAt) throw new Error('Release must be verified');
      map[key] = { releaseId: r.id, detectedAt: new Date().toISOString() };
    });
  }
  webhook(delivery: string): Promise<void> {
    const operation = this.webhookQueue.then(async () => {
      if (this.store.snapshot.deliveries[delivery]?.status === 'done') return;
      await this.store.change(null, 'webhook', 'delivery-pending', delivery, s => { s.deliveries[delivery] = { status: 'pending', attempts: (s.deliveries[delivery]?.attempts ?? 0) + 1, at: new Date().toISOString(), error: null }; });
      try {
        // Wait for an older collection, then fetch again: this event may have arrived mid-fetch.
        if (this.flight) await this.flight.catch(() => {});
        await this.reconcile();
      } catch {
        await this.store.change(null, 'webhook', 'delivery-failed', delivery, s => { s.deliveries[delivery].status = 'failed'; s.deliveries[delivery].error = 'Reconciliation failed; retry required'; });
        throw new Error('Webhook processing failed');
      }
    });
    this.webhookQueue = operation.catch(() => {}); return operation;
  }
}
export function resolveTarget(s: Readonly<Snapshot>, service: Service, channel: Channel, deviceId: string) {
  const key = scope(service, channel);
  const selected = s.overrides[`${key}:${deviceId}`] ?? s.defaults[key];
  const r = selected && s.releases.find(r => r.id === selected.releaseId);
  return r?.artifact && r.verifiedAt ? { programId: service, targetVersion: r.artifact.version, artifact: r.artifact, detectedAt: selected.detectedAt } : null;
}
