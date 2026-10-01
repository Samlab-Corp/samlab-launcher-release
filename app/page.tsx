'use client';
import { useEffect, useState } from 'react';
import { services, scope, type Snapshot, type Service, type Channel } from '../src/core/model';
type State = Snapshot & { reporting: string };
export default function Page() {
  const [state, setState] = useState<State>(); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [service, setService] = useState<Service>('letmeup-kiosk-v2'); const [channel, setChannel] = useState<Channel>('stable');
  const [releaseId, setReleaseId] = useState(''); const [deviceId, setDeviceId] = useState('');
  async function refresh() { const r = await fetch('/api/admin/state', { cache: 'no-store' }); if (!r.ok) throw new Error('관리자 인증을 확인하세요.'); setState(await r.json()); }
  useEffect(() => {
    let active = true;
    fetch('/api/admin/state', { cache: 'no-store' }).then(r => { if (!r.ok) throw new Error('관리자 인증을 확인하세요.'); return r.json(); }).then(data => { if (active) setState(data); }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, []);
  async function action(path: string, body: unknown) {
    setBusy(true); setError('');
    try { const r = await fetch(`/api/admin/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-csrf-protection': '1' }, body: JSON.stringify(body) }); const data = await r.json(); if (!r.ok) throw new Error(data.error); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : '실패'); await refresh().catch(() => {}); } finally { setBusy(false); }
  }
  const key = scope(service, channel);
  const releases = state?.releases.filter(r => r.service === service && r.channel === channel) ?? [];
  const selected = releases.find(r => r.id === releaseId);
  const label = (id?: string) => state?.releases.find(r => r.id === id)?.artifact?.version ?? state?.releases.find(r => r.id === id)?.tag ?? '미지정';
  const choose = (kind: 'default' | 'override' | 'stabilized', clear = false) => action('select', { revision: state?.revision, service, channel, kind, ...(kind === 'override' ? { deviceId } : {}), releaseId: clear ? null : releaseId });
  return <main>
    <header><div><p className="eyebrow">SAMLAB · SETUP</p><h1>앱 버전 관리</h1><p>셋업 렛미업 · 셋업 클래스업 배포 목표와 검증 상태</p></div><button disabled={busy} onClick={() => void action('reconcile', {})}>GitHub 대조</button></header>
    <p className="status">마지막 수집: {state?.sync.at ?? '수집 대기'} · {state?.sync.error ?? '수집 오류 없음'} · revision {state?.revision ?? '—'}</p>
    {error && <p role="alert" className="error">{error}</p>}
    <section className="filters"><label>서비스<select value={service} onChange={e => { setService(e.target.value as Service); setReleaseId(''); }}>{Object.entries(services).map(([id, s]) => <option key={id} value={id}>{s.name}</option>)}</select></label><label>채널<select value={channel} onChange={e => { setChannel(e.target.value as Channel); setReleaseId(''); }}><option>stable</option><option>beta</option></select></label></section>
    <div className="cards"><section><h2>전체 기본 목표</h2><strong>{label(state?.defaults[key]?.releaseId)}</strong><p>목표 지정 상태 · 설치 완료와 별개</p></section><section><h2>운영 검증 안정화 버전</h2><strong>{label(state?.stabilized[key]?.releaseId)}</strong><p>운영자가 운영 검증 후 명시적으로 선택</p></section><section><h2>실제 단말 상태</h2><strong>미보고</strong><p>{state?.reporting ?? '단말 보고 연동 미구현'}</p></section></div>
    {!services[service].managed && <p className="notice">{service === 'samlab-launcher' ? '런처 자체 업데이트 미구현' : '해당 앱의 중앙 목표 조회·설치 연동 미구현'} · 카탈로그와 관리 목표를 저장하며 실제 적용을 주장하지 않습니다.</p>}
    <section><h2>릴리스 카탈로그</h2><p>설치 파일은 GitHub CDN에서 다운로드합니다. 실제 파일 검증 후 목표를 지정할 수 있습니다.</p><div className="table"><table><thead><tr><th>선택</th><th>버전 / 태그</th><th>공개일</th><th>파일</th><th>검증</th></tr></thead><tbody>{releases.map(r => <tr key={r.id}><td><input aria-label={`${r.tag} 선택`} type="radio" name="release" checked={releaseId === r.id} onChange={() => setReleaseId(r.id)}/></td><td>{r.artifact?.version ?? r.tag}</td><td>{r.publishedAt.slice(0, 10)}</td><td>{r.artifact?.fileName ?? r.candidate?.fileName ?? '메타데이터 없음'}<small>{r.artifact?.sizeBytes ?? r.candidate?.sizeBytes ?? 0} bytes</small></td><td>{r.verifiedAt ? '파일 검증 완료' : r.issue ?? '검증 대기'}</td></tr>)}</tbody></table>{!releases.length && <p>이 채널에 수집된 릴리스가 없습니다.</p>}</div>
    <div className="actions"><button disabled={busy || !selected || (!selected.artifact && !selected.candidate)} onClick={() => void action('verify', { revision: state?.revision, releaseId })}>설치 파일 크기·해시 검증</button><button disabled={busy || !selected?.verifiedAt} onClick={() => void choose('default')}>전체 기본 목표 지정</button><button disabled={busy || !selected?.verifiedAt} onClick={() => void choose('stabilized')}>운영 검증 완료 · 안정화 지정</button><button disabled={busy || !state?.defaults[key]} onClick={() => void choose('default', true)}>기본 목표 해제</button></div>{busy && <p role="status">처리 중입니다. 파일 검증은 다운로드 크기에 따라 시간이 걸립니다.</p>}</section>
    <section><h2>단말별 지정</h2><label>단말 ID<input value={deviceId} onChange={e => setDeviceId(e.target.value)} maxLength={80} placeholder="등록된 단말 ID"/></label><div className="actions"><button disabled={busy || !selected?.verifiedAt || !deviceId} onClick={() => void choose('override')}>선택 버전 지정</button><button disabled={busy || !deviceId} onClick={() => void choose('override', true)}>단말 지정 해제</button></div><ul>{Object.entries(state?.overrides ?? {}).filter(([k]) => k.startsWith(key + ':')).map(([k, v]) => <li key={k}>{k.split(':')[2]} → {label(v.releaseId)} · 실제 설치 미보고</li>)}</ul></section>
    <section><h2>다운로드 실패 시 복구 안내</h2><p>정상 앱을 유지하고 다운로드를 재시도합니다. 다운로드 실패만으로 하향 설치하지 않습니다.</p><p>전역 안정화 후보: {label(state?.stabilized[key]?.releaseId)}. 단말의 마지막 정상 실행 버전은 미보고입니다. 자동 복구에는 로컬 정상 설치 파일 보관과 APP_READY 확인이 필요합니다.</p></section>
    <section><h2>변경 이력</h2><ol>{state?.history.slice(-50).reverse().map(h => <li key={h.revision}><time>{h.at}</time> · {h.actor} · {h.action}<small>{h.detail}</small></li>)}</ol></section>
  </main>;
}
