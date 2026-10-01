import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { z } from 'zod';
import { artifactSchema, candidateSchema, services, safeArtifact, type Release, type Service } from './model';
const assetSchema = z.object({ name: z.string(), size: z.number().int().nonnegative(), browser_download_url: z.string(), digest: z.string().nullable().optional() });
const githubRelease = z.object({ id: z.number().int(), tag_name: z.string().min(1).max(120), draft: z.boolean(), prerelease: z.boolean(), published_at: z.string().datetime(), assets: z.array(assetSchema) });
type Asset = z.infer<typeof assetSchema>;
type GHRelease = z.infer<typeof githubRelease>;
export type Fetcher = typeof fetch;
class SourceUnavailable extends Error {}
const allowedCDN = (u: URL) => u.protocol === 'https:' && !u.username && !u.password && !u.port && ['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(u.hostname);
export function assetUrl(repo: string, tag: string, name: string) { return `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`; }
async function boundedText(response: Response, limit: number) {
  const reader = response.body?.getReader(); if (!reader) throw new Error('Empty body');
  const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const r = await reader.read(); if (r.done) break; size += r.value.length; if (size > limit) throw new Error('Response too large'); chunks.push(r.value); } }
  finally { await reader.cancel(); }
  return Buffer.concat(chunks).toString('utf8');
}
export class Github {
  constructor(private fetcher: Fetcher = fetch, private token?: string) {}
  async download(url: string): Promise<Response> {
    for (let i = 0; i < 5; i++) {
      const u = new URL(url); if (!allowedCDN(u)) throw new Error('Untrusted download URL');
      let response: Response;
      try { response = await this.fetcher(u, { redirect: 'manual', signal: AbortSignal.timeout(120_000), headers: { 'User-Agent': 'samlab-central' } }); } catch { throw new SourceUnavailable('Download source unavailable'); }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location'); await response.body?.cancel();
        if (!location) throw new Error('Missing redirect'); url = new URL(location, u).href; continue;
      }
      if (!response.ok) throw new SourceUnavailable(`Download HTTP ${response.status}`);
      return response;
    }
    throw new Error('Too many redirects');
  }
  async list(service: Service): Promise<Release[]> {
    const repo = services[service].repo; const result: Release[] = [];
    for (let page = 1; page <= 100; page++) {
      const response = await this.fetcher(`https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`, { signal: AbortSignal.timeout(30_000), headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'samlab-central', ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) } });
      if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
      const entries = z.array(githubRelease).parse(JSON.parse(await boundedText(response, 8_000_000)));
      for (const entry of entries.filter(e => !e.draft)) {
        let artifact: Release['artifact'] = null; let issue: string | null = null;
        try { artifact = await this.metadata(repo, entry); } catch (e) { if (e instanceof SourceUnavailable) throw e; issue = '설치 메타데이터 없음 또는 검증 실패'; }
        let candidate: Release['candidate'] = null;
        const apk = entry.assets.filter(a => a.name.endsWith('.apk'));
        if (!artifact && apk.length === 1 && apk[0].digest?.startsWith('sha256:')) {
          try { this.checkAsset(repo, entry.tag_name, apk[0]); candidate = candidateSchema.parse({ version: entry.tag_name.replace(/^v/, ''), fileName: apk[0].name, url: apk[0].browser_download_url, sizeBytes: apk[0].size, sha256: apk[0].digest.slice(7) }); issue = 'APK 검증 대기'; } catch { /* Unsafe APK remains unavailable. */ }
        }
        result.push({ id: `${service}-${entry.id}`, service, channel: entry.prerelease ? 'beta' : 'stable', tag: entry.tag_name, publishedAt: entry.published_at, artifact, candidate, verifiedAt: null, issue });
      }
      if (entries.length < 100) return result;
    }
    throw new Error('Pagination safety limit; catalog not replaced');
  }
  private checkAsset(repo: string, tag: string, a: Asset) {
    if (a.browser_download_url !== assetUrl(repo, tag, a.name)) throw new Error('Unexpected asset URL');
  }
  async metadata(repo: string, entry: GHRelease): Promise<Release['artifact']> {
    const names = entry.prerelease ? ['beta.yml', 'latest.yml'] : ['latest.yml'];
    const asset = names.map(name => entry.assets.find(a => a.name === name)).find(Boolean);
    if (!asset) throw new Error('No electron-builder metadata');
    this.checkAsset(repo, entry.tag_name, asset);
    const text = await boundedText(await this.download(asset.browser_download_url), 64_000);
    const metadata = z.object({ version: z.string(), path: z.string().optional(), sha512: z.string().optional(), files: z.array(z.object({ url: z.string(), sha512: z.string(), size: z.number() })) }).parse(parse(text, { maxAliasCount: 0 }));
    const file = metadata.files.find(f => /\.(exe|apk)$/i.test(f.url) && (!metadata.path || f.url === metadata.path));
    if (!file || (metadata.sha512 && metadata.sha512 !== file.sha512)) throw new Error('Inconsistent metadata');
    const binary = entry.assets.find(a => a.name === file.url);
    if (!binary || binary.size !== file.size) throw new Error('Missing binary or size mismatch');
    this.checkAsset(repo, entry.tag_name, binary);
    return artifactSchema.parse({ version: metadata.version, fileName: binary.name, url: binary.browser_download_url, sha512: file.sha512, sizeBytes: binary.size });
  }
  async verify(release: Release) {
    const a = release.artifact ?? release.candidate;
    if (!a || !safeArtifact(release)) throw new Error('Artifact unavailable');
    const response = await this.download(a.url);
    const reader = response.body?.getReader(); if (!reader) throw new Error('Empty artifact');
    const hash = createHash('sha512'); const hash256 = createHash('sha256'); let size = 0;
    try { for (;;) { const r = await reader.read(); if (r.done) break; size += r.value.length; if (size > a.sizeBytes) throw new Error('Artifact size exceeded'); hash.update(r.value); hash256.update(r.value); } }
    finally { await reader.cancel(); }
    const digest = hash.digest('base64');
    const expected = release.artifact && (/^[a-fA-F0-9]{128}$/.test(release.artifact.sha512) ? Buffer.from(release.artifact.sha512, 'hex').toString('base64') : release.artifact.sha512);
    if (size !== a.sizeBytes || (expected && digest !== expected) || (!expected && hash256.digest('hex') !== release.candidate?.sha256)) throw new Error('Artifact size/hash mismatch');
    return artifactSchema.parse({ version: a.version, fileName: a.fileName, url: a.url, sizeBytes: a.sizeBytes, sha512: digest });
  }
}
