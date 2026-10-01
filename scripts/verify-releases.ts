import { Github } from '../src/core/github';
import { services, type Service } from '../src/core/model';
const gh = new Github(fetch, process.env.GITHUB_TOKEN);
const requested = process.argv.slice(2);
for (const service of (Object.keys(services) as Service[]).filter(s => !requested.length || requested.includes(s))) {
  const releases = await gh.list(service);
  console.log(JSON.stringify({ service, stable: releases.filter(r => r.channel === 'stable').length, beta: releases.filter(r => r.channel === 'beta').length, withMetadata: releases.filter(r => r.artifact || r.candidate).length }));
  const candidate = releases.find(r => r.artifact || r.candidate);
  if (candidate) { await gh.verify(candidate); console.log(JSON.stringify({ service, verifiedTag: candidate.tag, bytes: candidate.artifact?.sizeBytes ?? candidate.candidate?.sizeBytes })); }
  else console.log(JSON.stringify({ service, limitation: 'No trusted metadata; cannot assign target' }));
}
