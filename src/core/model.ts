import { z } from 'zod';
export const services = {
  'letmeup-kiosk-v2': { name: '렛미업 키오스크', repo: 'Samlab-Corp/letmeup-kiosk-v2-release', managed: true },
  'letmeup-tablet': { name: '렛미업 태블릿', repo: 'Samlab-Corp/letmeup-kiosk-app-releases', managed: false },
  'samlab-launcher': { name: '샘랩 런처', repo: 'Samlab-Corp/samlab-launcher-release', managed: false },
  'classup-tablet': { name: '클래스업 태블릿', repo: 'Samlab-Corp/classup-kiosk-app-releases', managed: false },
  'classup-desktop': { name: '클래스업 데스크톱', repo: 'Samlab-Corp/classup-desktop-app-releases', managed: false },
  'classup-kiosk': { name: '클래스업 키오스크', repo: 'Samlab-Corp/classup-kiosk-client-releases', managed: false },
  'classup-barrier-free': { name: '클래스업 배리어프리 키오스크', repo: 'Samlab-Corp/classup-kiosk-barrier-free-releases', managed: false },
} as const;
export const serviceId = z.enum(Object.keys(services) as [keyof typeof services, ...(keyof typeof services)[]]);
export const channel = z.enum(['stable', 'beta']);
export const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/);
export const version = z.string().regex(/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/).max(80);
export const sha512 = z.string().refine(s => /^[a-fA-F0-9]{128}$/.test(s) || (/^[A-Za-z0-9+/]{86}==$/.test(s) && Buffer.from(s, 'base64').length === 64));
export const artifactSchema = z.object({ version, url: z.string().url(), sha512, sizeBytes: z.number().int().positive().max(4_000_000_000), fileName: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._ +\-]{0,180}\.(exe|apk)$/i) }).strict();
export const candidateSchema = artifactSchema.omit({ sha512: true }).extend({ sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const releaseSchema = z.object({ id: identifier, service: serviceId, channel, tag: z.string().max(120), publishedAt: z.string().datetime(), artifact: artifactSchema.nullable(), candidate: candidateSchema.nullable().default(null), verifiedAt: z.string().datetime().nullable(), issue: z.string().max(200).nullable() }).strict();
const selection = z.object({ releaseId: identifier, detectedAt: z.string().datetime() }).strict();
const history = z.object({ revision: z.number().int().positive(), at: z.string().datetime(), actor: z.string().max(80), action: z.string().max(120), detail: z.string().max(300) }).strict();
export const snapshotSchema = z.object({
  schemaVersion: z.literal(1), revision: z.number().int().nonnegative(),
  releases: z.array(releaseSchema),
  defaults: z.record(z.string(), selection), overrides: z.record(z.string(), selection),
  stabilized: z.record(z.string(), selection), history: z.array(history),
  deliveries: z.record(z.string(), z.object({ status: z.enum(['pending', 'done', 'failed']), attempts: z.number().int().nonnegative(), at: z.string().datetime(), error: z.string().nullable() }).strict()),
  sync: z.object({ at: z.string().datetime().nullable(), error: z.string().nullable() }).strict(),
}).strict();
export type Snapshot = z.infer<typeof snapshotSchema>;
export type Release = z.infer<typeof releaseSchema>;
export type Service = z.infer<typeof serviceId>;
export type Channel = z.infer<typeof channel>;
export interface TargetState { programId: string; targetVersion: string; artifact: z.infer<typeof artifactSchema>; detectedAt: string }
export const emptySnapshot = (): Snapshot => ({ schemaVersion: 1, revision: 0, releases: [], defaults: {}, overrides: {}, stabilized: {}, history: [], deliveries: {}, sync: { at: null, error: null } });
export const scope = (service: Service, ch: Channel) => `${service}:${ch}`;
export function safeArtifact(release: Release): boolean {
  const a = release.artifact ?? release.candidate;
  if (!a) return false;
  const expected = `https://github.com/${services[release.service].repo}/releases/download/${encodeURIComponent(release.tag)}/${encodeURIComponent(a.fileName)}`;
  return a.url === expected;
}
export function validateSnapshot(raw: unknown): Snapshot {
  const s = snapshotSchema.parse(raw);
  const ids = new Set(s.releases.map(r => r.id));
  if (ids.size !== s.releases.length || s.releases.some(r => (r.artifact || r.candidate) && !safeArtifact(r))) throw new Error('Invalid catalog');
  for (const [map, partsLength] of [[s.defaults, 2], [s.stabilized, 2], [s.overrides, 3]] as const) for (const [key, value] of Object.entries(map)) {
    const parts = key.split(':');
    const r = s.releases.find(r => r.id === value.releaseId);
    if (!r?.artifact || !r.verifiedAt || parts[0] !== r.service || parts[1] !== r.channel || parts.length !== partsLength || (parts[2] && !identifier.safeParse(parts[2]).success)) throw new Error('Invalid selection');
  }
  if (s.history.some((h, i) => h.revision !== i + 1) || s.history.length !== s.revision) throw new Error('Invalid history');
  return s;
}
