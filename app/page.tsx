'use client';

import { useEffect, useState } from 'react';
import { services, scope, type Snapshot, type Service, type Channel } from '../src/core/model';

type State = Snapshot & { reporting: string };
const groups: { title: string; items: Service[] }[] = [
  { title: '셋업 렛미업', items: ['letmeup-kiosk-v2', 'letmeup-tablet'] },
  { title: '셋업 클래스업', items: ['classup-tablet', 'classup-desktop', 'classup-kiosk', 'classup-barrier-free'] },
  { title: '시스템', items: ['samlab-launcher'] },
];
const date = (value?: string | null) => value
  ? new Intl.DateTimeFormat('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Seoul' }).format(new Date(value))
  : '아직 수집되지 않음';
const size = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export default function Page() {
  const [state, setState] = useState<State>();
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);
  const [service, setService] = useState<Service>('letmeup-kiosk-v2');
  const [channel, setChannel] = useState<Channel>('stable');
  const [releaseId, setReleaseId] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [page, setPage] = useState(1);

  async function refresh() {
    const response = await fetch('/api/admin/state', { cache: 'no-store' });
    if (!response.ok) throw new Error('목록을 불러오지 못했습니다. 접속 상태와 관리자 인증을 확인하세요.');
    setState(await response.json());
  }
  useEffect(() => {
    let active = true;
    fetch('/api/admin/state', { cache: 'no-store' })
      .then(response => { if (!response.ok) throw new Error('목록을 불러오지 못했습니다. 접속 상태와 관리자 인증을 확인하세요.'); return response.json(); })
      .then(data => { if (active) setState(data); })
      .catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, []);

  async function action(path: string, body: unknown, message: string) {
    setBusy(true); setError(''); setSuccess('');
    try {
      const response = await fetch(`/api/admin/${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-csrf-protection': '1' }, body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      await refresh(); setSuccess(message);
    } catch (e) {
      setError(e instanceof Error ? e.message : '요청을 처리하지 못했습니다.');
      await refresh().catch(() => {});
    } finally { setBusy(false); }
  }
  async function reload() {
    setBusy(true); setError('');
    try { await refresh(); } catch (e) { setError(e instanceof Error ? e.message : '새로고침 실패'); }
    finally { setBusy(false); }
  }

  const key = scope(service, channel);
  const allReleases = state?.releases.filter(r => r.service === service) ?? [];
  const releases = allReleases.filter(r => r.channel === channel).sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  const selected = releases.find(r => r.id === releaseId);
  const label = (id?: string) => state?.releases.find(r => r.id === id)?.artifact?.version ?? state?.releases.find(r => r.id === id)?.tag ?? '미지정';
  const matches = releases.filter(r =>
    `${r.tag} ${r.artifact?.version ?? ''} ${r.artifact?.fileName ?? r.candidate?.fileName ?? ''}`.toLowerCase().includes(query.trim().toLowerCase())
    && (filter === 'all' || (filter === 'verified' ? !!r.verifiedAt : !r.verifiedAt)),
  );
  const pageCount = Math.max(1, Math.ceil(matches.length / 12));
  const currentPage = Math.min(page, pageCount);
  const visible = matches.slice((currentPage - 1) * 12, currentPage * 12);
  const overrides = Object.entries(state?.overrides ?? {}).filter(([k]) => k.startsWith(key + ':'));

  const choose = (kind: 'default' | 'override' | 'stabilized', clear = false, targetReleaseId = releaseId) => action('select', {
    revision: state?.revision, service, channel, kind,
    ...(kind === 'override' ? { deviceId } : {}), releaseId: clear ? null : targetReleaseId,
  }, clear ? '목표 지정을 해제했습니다.' : `${label(targetReleaseId)} 버전을 ${kind === 'default' ? '전체 배포 목표' : kind === 'override' ? `${deviceId} 단말 목표` : '운영 안정화 버전'}로 지정했습니다.`);
  const verify = (id: string) => action('verify', { revision: state?.revision, releaseId: id }, `${label(id)} 설치 파일의 크기와 해시를 확인했습니다.`);
  const resetFilters = () => { setQuery(''); setFilter('all'); setPage(1); };
  const selectService = (id: Service) => { setService(id); setReleaseId(''); setSuccess(''); resetFilters(); };

  return <div className="workspace">
    <a className="skip-link" href="#content">콘텐츠로 이동</a>
    <aside className="menu-panel">
      <div className="menu-brand"><span className="brand-mark" aria-hidden="true">S</span><div><strong>SAMLAB</strong><small>Deployment console</small></div></div>
      <p className="menu-caption">WORKSPACE</p>
      <nav aria-label="서비스 메뉴">
        {groups.map(group => <div className="menu-group" key={group.title}>
          <h3>{group.title}</h3>
          {group.items.map(id => <button key={id} disabled={busy} className={service === id ? 'menu-item active' : 'menu-item'} aria-pressed={service === id} onClick={() => selectService(id)}>
            <span className="menu-dot" aria-hidden="true"/><span>{services[id].name}</span><span className="menu-count">{state?.releases.filter(r => r.service === id).length ?? '—'}</span>
          </button>)}
        </div>)}
      </nav>
      <div className="menu-footer"><span className="health-dot" aria-hidden="true"/> 중앙 버전 관리<small>서비스별 목표와 이력을 한곳에서</small></div>
    </aside>

    <main className="content-panel" id="content">
      <header className="page-header">
        <div><p className="eyebrow">배포 관리 <span>/</span> {services[service].name}</p><h1>{services[service].name}</h1><p>릴리스 확인부터 검증, 배포 목표 지정까지.</p></div>
        <div className="header-actions"><button className="button secondary" disabled={busy} onClick={() => void reload()}>새로고침</button><button className="button" disabled={busy} onClick={() => void action('reconcile', {}, 'GitHub의 최신 릴리스 목록과 대조했습니다.')}>GitHub 동기화</button></div>
      </header>

      <div className="sync-line"><span className={state?.sync.error ? 'health-dot warning' : 'health-dot'}/><span>{state?.sync.error ?? (state?.sync.at ? '카탈로그 동기화됨' : '첫 카탈로그 수집 대기')}</span><span className="sync-time">마지막 확인 {date(state?.sync.at)}</span></div>
      {error && <div role="alert" className="feedback error"><span>{error}</span><button className="text-button" onClick={() => setError('')}>닫기</button></div>}
      {success && <div role="status" className="feedback success"><span>{success}</span><button className="text-button" onClick={() => setSuccess('')}>닫기</button></div>}
      {busy && <div className="progress" role="status"><span className="spinner"/> 요청을 처리하고 있습니다. 설치 파일 검증에는 시간이 걸릴 수 있습니다.</div>}

      <div className="channel-bar"><div className="channel-tabs" role="group" aria-label="릴리스 채널">
        {(['stable', 'beta'] as Channel[]).map(ch => <button key={ch} disabled={busy} className={channel === ch ? 'channel-tab active' : 'channel-tab'} aria-pressed={channel === ch} onClick={() => { setChannel(ch); setReleaseId(''); setSuccess(''); resetFilters(); }}>{ch === 'stable' ? 'Stable' : 'Beta'}<span>{allReleases.filter(r => r.channel === ch).length}</span></button>)}
      </div><span className="subtle">{channel === 'stable' ? '정식 릴리스' : '사전 공개 릴리스'} · 최신 공개일순</span></div>

      <div className="cards">
        <section className="metric primary-metric"><div className="metric-heading"><h2>전체 배포 목표</h2><span className="badge accent">{channel}</span></div><strong>{label(state?.defaults[key]?.releaseId)}</strong><p>각 행의 배포 버튼으로 지정</p></section>
        <section className="metric"><div className="metric-heading"><h2>운영 안정화 버전</h2><span className="metric-symbol" aria-hidden="true">◇</span></div><strong>{label(state?.stabilized[key]?.releaseId)}</strong><p>운영 검증을 마친 복구 후보</p></section>
        <section className="metric"><div className="metric-heading"><h2>단말 설치 상태</h2><span className="badge neutral">보고 대기</span></div><strong className="muted-value">미보고</strong><p>목표 지정과 실제 설치 완료는 별개</p></section>
      </div>
      {!services[service].managed && <div className="notice"><span className="notice-icon" aria-hidden="true">i</span><span>{service === 'samlab-launcher' ? '런처 자체 업데이트' : '이 앱의 중앙 설치'} 연동은 준비 중입니다. 카탈로그와 배포 목표를 관리할 수 있습니다.</span></div>}

      <section className="catalog panel">
        <div className="section-heading"><div><h2>릴리스 카탈로그 <span className="count-badge">{releases.length}</span></h2><p>파일 검증 후 배포하면 해당 버전이 전체 기본 목표로 지정됩니다.</p></div><span className="badge neutral">GitHub Releases</span></div>
        <div className="catalog-toolbar"><label className="search-field"><span aria-hidden="true">⌕</span><input aria-label="버전 또는 파일명 검색" placeholder="버전 또는 파일명 검색" value={query} onChange={e => { setQuery(e.target.value); setPage(1); }}/>{query && <button className="text-button" aria-label="검색 지우기" onClick={() => { setQuery(''); setPage(1); }}>×</button>}</label><select aria-label="검증 상태 필터" value={filter} onChange={e => { setFilter(e.target.value); setPage(1); }}><option value="all">모든 검증 상태</option><option value="verified">검증 완료</option><option value="pending">검증 대기</option></select></div>
        {!state ? <div className="empty-state" role="status">{error ? '목록을 불러오지 못했습니다. 위의 새로고침 버튼으로 다시 시도하세요.' : <><span className="spinner"/> 릴리스 목록을 불러오는 중입니다.</>}</div> : !matches.length ? <div className="empty-state"><div className="empty-symbol" aria-hidden="true">⌕</div><h3>{query || filter !== 'all' ? '검색 결과가 없습니다' : '이 채널에 릴리스가 없습니다'}</h3><p>{query || filter !== 'all' ? '다른 버전이나 파일명으로 검색해 보세요.' : 'GitHub 동기화 후 릴리스 목록을 확인하세요.'}</p>{(query || filter !== 'all') && <button className="button secondary" onClick={resetFilters}>필터 초기화</button>}</div> : <>
          <div className="table"><table><thead><tr><th className="selection-column"><span className="sr-only">선택</span></th><th>버전</th><th>공개일</th><th>설치 파일</th><th>파일 검증</th><th className="deploy-column">배포</th></tr></thead><tbody>{visible.map(r => {
            const assigned = state.defaults[key]?.releaseId === r.id;
            const artifact = r.artifact ?? r.candidate;
            return <tr key={r.id} className={assigned ? 'assigned-row' : releaseId === r.id ? 'selected-row' : ''}>
              <td><input aria-label={`${r.tag} 선택`} type="radio" name="release" checked={releaseId === r.id} disabled={busy} onChange={() => setReleaseId(r.id)}/></td>
              <td><strong className="version">{r.artifact?.version ?? r.candidate?.version ?? r.tag}</strong>{assigned && <small className="target-label">현재 배포 목표</small>}</td>
              <td className="date-cell">{r.publishedAt.slice(0, 10)}</td>
              <td><span className="file-name" title={artifact?.fileName}>{artifact?.fileName ?? '설치 메타데이터 없음'}</span><small>{artifact ? size(artifact.sizeBytes) : '목표 지정 불가'}</small></td>
              <td>{r.verifiedAt ? <span className="badge verified">검증 완료</span> : <div className="verification-cell"><span className="badge neutral">{artifact ? '검증 대기' : '확인 필요'}</span><button className="text-button" disabled={busy || !artifact} aria-label={`${r.tag} 파일 검증`} onClick={() => void verify(r.id)}>파일 검증</button></div>}</td>
              <td><button className={assigned ? 'button deployed' : 'button small-button'} disabled={busy || !r.verifiedAt || assigned} aria-label={`${r.tag} 배포`} title={!r.verifiedAt ? '파일 검증을 완료하면 배포할 수 있습니다.' : '전체 기본 목표로 지정합니다.'} onClick={() => void choose('default', false, r.id)}>{assigned ? '지정됨' : '배포'}</button></td>
            </tr>;
          })}</tbody></table></div>
          <div className="table-footer"><span>{matches.length}개 중 {(currentPage - 1) * 12 + 1}–{Math.min(currentPage * 12, matches.length)} 표시</span><div className="pagination"><button className="button secondary small-button" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>이전</button><span>{currentPage} / {pageCount}</span><button className="button secondary small-button" disabled={currentPage === pageCount} onClick={() => setPage(currentPage + 1)}>다음</button></div></div>
        </>}
        <div className="selection-actions"><span>{selected ? <><strong>{label(selected.id)}</strong> 선택됨</> : '행을 선택하면 안정화 버전이나 단말 목표로 지정할 수 있습니다.'}</span><div className="actions"><button className="button secondary small-button" disabled={busy || !selected || (!selected.artifact && !selected.candidate)} onClick={() => void verify(releaseId)}>선택 파일 검증</button><button className="button secondary small-button" disabled={busy || !selected?.verifiedAt} onClick={() => void choose('stabilized')}>운영 검증 완료 · 안정화 지정</button><button className="text-button" disabled={busy || !state?.defaults[key]} onClick={() => void choose('default', true)}>기본 목표 해제</button></div></div>
      </section>

      <div className="detail-grid">
        <section className="panel"><div className="section-heading"><div><h2>단말별 목표</h2><p>특정 단말에는 전체 기본 목표보다 우선 적용합니다.</p></div><span className="count-badge">{overrides.length}</span></div><label className="field-label" htmlFor="device-id">단말 ID</label><div className="device-input"><input id="device-id" value={deviceId} onChange={e => setDeviceId(e.target.value)} maxLength={80} placeholder="단말 ID 입력"/><button className="button" disabled={busy || !selected?.verifiedAt || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(deviceId)} onClick={() => void choose('override')}>선택 버전 지정</button></div><p className="field-hint">{selected ? `지정할 버전: ${label(selected.id)}` : '위 목록에서 검증한 버전을 먼저 선택하세요.'}</p>{overrides.length ? <ul className="device-list">{overrides.map(([k, v]) => <li key={k}><span>{k.split(':')[2]}</span><strong>{label(v.releaseId)}</strong><span className="badge neutral">설치 미보고</span></li>)}</ul> : <div className="inline-empty">단말별 지정이 없습니다. 전체 기본 목표를 따릅니다.</div>}<button className="text-button" disabled={busy || !deviceId || !state?.overrides[`${key}:${deviceId}`]} onClick={() => void choose('override', true)}>입력한 단말 지정 해제</button></section>
        <section className="panel recovery-panel"><div className="section-heading"><div><h2>복구와 안정화</h2><p>다운로드 실패 시 정상 앱을 유지하고 재시도합니다.</p></div></div><div className="recovery-target"><span>운영 안정화 후보</span><strong>{label(state?.stabilized[key]?.releaseId)}</strong></div><p className="recovery-copy">다운로드 실패만으로 자동 하향 설치하지 않습니다. 단말의 마지막 정상 실행 버전은 미보고이며, 실제 복구에는 정상 설치 파일 보관과 APP_READY 확인이 필요합니다.</p></section>
      </div>

      <section className="panel history-panel"><div className="section-heading"><div><h2>변경 이력</h2><p>최근 50건의 목표 변경과 수집 기록</p></div></div>{state?.history.length ? <ol className="timeline">{state.history.slice(-50).reverse().map(h => <li key={h.revision}><span className="timeline-dot"/><div><div className="history-title"><strong>{({ default: '전체 배포 목표 변경', override: '단말 목표 변경', stabilized: '안정화 버전 변경', 'verify-artifact': '설치 파일 검증', reconcile: '릴리스 동기화', 'reconcile-failed': '동기화 실패', 'delivery-pending': '웹훅 수신', 'delivery-failed': '웹훅 처리 실패' } as Record<string, string>)[h.action] ?? h.action}</strong><time>{date(h.at)}</time></div><p>{h.detail}</p><small>{h.actor} · #{h.revision}</small></div></li>)}</ol> : <div className="inline-empty">저장된 변경 이력이 없습니다.</div>}</section>
      <footer className="page-footer">SAMLAB DEPLOYMENT CONSOLE <span>설치 파일은 GitHub CDN에서 제공합니다.</span></footer>
    </main>
  </div>;
}
