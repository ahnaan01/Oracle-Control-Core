import React, { useEffect, useState, useCallback, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import { metricView, type Metrics } from './metrics.js';

declare global { interface Window { OCC_CONFIG: { basePath: string } } }
const base = window.OCC_CONFIG.basePath;
const pages = ['overview', 'monitoring', 'projects', 'bots', 'containers', 'activity', 'settings'] as const;
type Page = typeof pages[number];
const icons = ['◈', '◷', '▧', '⌘', '▣', '≋', '⚙'];
const pageTitles: Record<Page, string> = { overview: 'Your system, at a glance.', monitoring: 'A pulse on your system.',
  projects: 'Everything in one registry.', bots: 'One core. Every conversation.', containers: 'Your container inventory.',
  activity: 'A clear record of every action.', settings: 'Make it work for you.' };
function locationPage(): Page {
  const path = window.location.pathname.slice(base.length).split('/').filter(Boolean)[0] ?? 'overview';
  return pages.includes(path as Page) ? path as Page : 'overview';
}
interface Project { id: string; manifest: { name: string; runtime: string; version: string; description: string }; health: string; lastCheck: string | null }
interface Containers { available: boolean; mode: string; reason: string | null; containers: { id: string; name: string; image: string; state: string; health: string; composeProject: string | null }[] }
interface Activity { id: string; action: string; outcome: string; platform: string | null; user_id: string | null; created_at: string; request_id: string }
interface Bot { platform: string; mode: string; status: string; fresh: boolean; observedAt: string | null; reason: string | null; attempt: number; nextRetryAt: string | null }
interface Settings { mode: string; basePath: string; retentionDays: number; docker: string; ai: string; execution: string; pollingSeconds: number }
interface Snapshot { metrics?: Metrics; projects?: Project[]; containers?: Containers; activity?: Activity[]; bots?: Bot[]; settings?: Settings }
const bytes = (n: number | undefined | null) => n == null ? 'Unavailable' : `${(n / 1024 ** 3).toFixed(1)} GiB`;
const duration = (seconds: number) => `${Math.floor(seconds / 86400)}d ${Math.floor(seconds % 86400 / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
const label = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

function App() {
  const [user, setUser] = useState<{ username: string } | null>(null);
  const [csrf, setCsrf] = useState(''); const [booting, setBooting] = useState(true);
  const [page, setPage] = useState<Page>(locationPage);
  const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [snapshot, setSnapshot] = useState<Snapshot>({}); const [refreshing, setRefreshing] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<string>();
  const [polling, setPolling] = useState(15);
  const generation = useRef(0); const busy = useRef(false); const refreshAbort = useRef<AbortController | null>(null); const [clock, setClock] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 5000); return () => clearInterval(timer); }, []);
  const api = useCallback(async <T,>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> => {
    const response = await fetch(`${base}/api/v1${path}`, { method, credentials: 'same-origin',
      headers: { 'content-type': 'application/json', ...(method !== 'GET' ? { 'x-csrf-token': csrf } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) });
    const result = await response.json();
    if (response.status === 401) { setUser(null); setCsrf(''); setSnapshot({}); }
    if (!response.ok) throw new Error(result.error?.message ?? 'Request failed');
    return result.data as T;
  }, [csrf]);
  useEffect(() => { let active = true;
    fetch(`${base}/api/v1/auth/session`, { credentials: 'same-origin', signal: AbortSignal.timeout(10000) }).then(async response => {
      if (!response.ok) { if (response.status !== 401) throw new Error('Session service unavailable'); return; }
      const result = await response.json();
      if (active) { setUser(result.data.user); setCsrf(result.data.csrf); }
    }).catch(() => { if (active) setError('Unable to reach OCC. Check that the backend is running.'); })
      .finally(() => { if (active) setBooting(false); });
    return () => { active = false; };
  }, []);
  useEffect(() => { const onPop = () => setPage(locationPage()); window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop); }, []);
  const refresh = useCallback(async () => {
    if (!user || busy.current) return;
    const current = generation.current; const controller = new AbortController(); refreshAbort.current = controller; busy.current = true; setRefreshing(true);
    try {
      const next: Snapshot = {};
      if (page === 'overview' || page === 'monitoring') next.metrics = await api<Metrics>('/system', 'GET', undefined, controller.signal);
      if (page === 'overview' || page === 'projects') next.projects = await api<Project[]>('/projects', 'GET', undefined, controller.signal);
      if (page === 'overview' || page === 'containers') next.containers = await api<Containers>('/containers', 'GET', undefined, controller.signal);
      if (page === 'overview' || page === 'activity') next.activity = await api<Activity[]>('/activity', 'GET', undefined, controller.signal);
      if (page === 'bots') next.bots = await api<Bot[]>('/bots', 'GET', undefined, controller.signal);
      if (page === 'settings' || page === 'overview') {
        next.settings = await api<Settings>('/settings', 'GET', undefined, controller.signal); setPolling(next.settings.pollingSeconds);
      }
      if (current !== generation.current) return;
      setSnapshot(next); setLastRefresh(new Date().toLocaleTimeString()); setError('');
    } catch (e) { if (current === generation.current) setError(e instanceof Error ? e.message : 'Refresh failed'); }
    finally { if (current === generation.current) { busy.current = false; setRefreshing(false); } }
  }, [user, page, api]);
  useEffect(() => { void refresh(); const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, polling * 1000);
    return () => { clearInterval(timer); refreshAbort.current?.abort(); generation.current++; busy.current = false; }; }, [refresh, polling]);
  function navigate(next: Page) { refreshAbort.current?.abort(); generation.current++; busy.current = false; history.pushState({}, '', next === 'overview' ? base : `${base}/${next}`);
    setPage(next); setSnapshot({}); setNotice(''); setError(''); }
  async function login(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget); setError('');
    const password = String(form.get('password')); event.currentTarget.reset();
    try { const result = await api<{ user: { username: string }; csrf: string }>('/auth/login', 'POST', { username: form.get('username'), password });
      setUser(result.user); setCsrf(result.csrf); }
    catch (e) { setError(e instanceof Error ? e.message : 'Login failed'); }
  }
  async function logout() { refreshAbort.current?.abort(); generation.current++; try { await api('/auth/logout', 'POST', {}); setUser(null); setCsrf(''); setSnapshot({}); }
    catch (e) { setError(e instanceof Error ? e.message : 'Logout failed'); } }
  const metrics = snapshot.metrics; const view = metricView(metrics);
  const stale = !!view.sampledAt && clock - Date.parse(view.sampledAt) > Math.max(30000, polling * 2000);
  if (booting) return <main className="loading">Connecting to Oracle Control Core…</main>;
  if (!user) return <main className="login-page"><div className="login-brand"><div className="brand-symbol">◈</div><p className="eyebrow">ORACLE CONTROL CORE</p>
    <h1>A quieter way<br/>to run your world.</h1><p>Your applications, system health, and connected services.<br/>One secure place to keep it all in view.</p><span className="login-foot">PERSONAL INFRASTRUCTURE · CONNECTED BY DESIGN</span></div>
    <form className="login-card" onSubmit={login}><span className="eyebrow">CONTROL ROOM</span><h2>Welcome back</h2><p>Sign in to your management console.</p>
      {error && <div role="alert" className="alert">{error}</div>}
      <label>Username<input name="username" autoComplete="username" required maxLength={100}/></label>
      <label>Password<input type="password" name="password" autoComplete="current-password" required maxLength={256}/></label>
      <button className="primary" type="submit">Enter dashboard <span>→</span></button><small>No account yet? Run <code>npm run admin</code> locally.</small></form></main>;
  return <div className="shell"><aside className="sidebar"><a className="brand" href={base} onClick={e => { e.preventDefault(); navigate('overview'); }}><span className="brand-symbol">◈</span><span>ORACLE<span className="brand-sub">CONTROL CORE</span></span></a>
    <p className="nav-label">WORKSPACE</p><nav aria-label="Main navigation">{pages.map((name, i) => <a key={name} aria-current={page === name ? 'page' : undefined}
      className={page === name ? 'active' : ''} href={name === 'overview' ? base : `${base}/${name}`} onClick={e => { e.preventDefault(); navigate(name); }}><span aria-hidden="true">{icons[i]}</span>{label(name)}{page === name && <b aria-hidden="true">·</b>}</a>)}</nav>
    <div className="sidebar-bottom"><div className="safe-mode"><span className="dot"/> Read-only operations<small>Destructive actions disabled</small></div><div className="profile"><span className="avatar">{user.username[0]?.toUpperCase()}</span><div>{user.username}<small>Administrator</small></div><button title="Sign out" aria-label="Sign out" onClick={() => void logout()}>↪</button></div></div></aside>
    <div className="workspace"><header className="topbar"><span>Workspace <span className="muted">/</span> <strong>{label(page)}</strong></span><div><span className="badge">PHASE 1.1</span><span className="top-name"> OCC / v0.1.1</span><button className="mobile-signout" aria-label="Sign out" onClick={() => void logout()}>Sign out</button></div></header>
      <main className="content"><div className="page-heading"><div><p className="eyebrow">YOUR PERSONAL CONTROL PLANE</p><h1>{label(page)}</h1><p>{pageTitles[page]}</p></div><button onClick={() => void refresh()} disabled={refreshing}><span aria-hidden="true">↻ </span>{refreshing ? 'Refreshing…' : 'Refresh'}</button></div>
        <div className="context-strip"><span><span className="dot"/> {error ? 'Core request failed' : stale ? 'Observations stale' : 'Core session active'}</span><span>{snapshot.settings?.mode === 'mock' ? 'Mock messaging · real OS metrics' : 'Monitoring & application registry'}</span><span className="strip-time">{lastRefresh ? `Last refreshed ${lastRefresh}` : 'Loading data…'}</span></div>
        {error && <div role="alert" className="alert">{error} Data below may be stale.</div>}{notice && <div role="status" className="notice">{notice}</div>}
        {(page === 'overview' || page === 'monitoring') && <>
          <p className="scope"><strong>{view.source}</strong>{stale ? ' · Stale — refresh failed or polling paused' : ''}{view.sampledAt ? ` · Observed ${new Date(view.sampledAt).toLocaleTimeString()}` : ''}</p>
          <section className="stats" aria-label="System metrics"><Metric title="CPU USAGE" value={view.cpuPercent == null ? 'Unavailable' : `${view.cpuPercent.toFixed(1)}%`} detail={view.cores ? `${view.cores} cores · ${view.source}` : 'No measured CPU sample/limit yet'} percent={view.cpuPercent ?? undefined}/>
            <Metric title="MEMORY USED" value={bytes(view.memory?.usedBytes)} detail={`Available ${bytes(view.memory?.availableBytes)} / total ${bytes(view.memory?.totalBytes)}`} percent={view.memory?.totalBytes ? 100 * view.memory.usedBytes / view.memory.totalBytes : undefined}/>
            <Metric title="STORAGE USED" value={bytes(view.disk?.usedBytes)} detail={`${bytes(view.disk?.availableBytes)} available · ${view.diskScope}`} percent={view.disk?.totalBytes ? 100 * view.disk.usedBytes / view.disk.totalBytes : undefined}/>
            <Metric title="HOST UPTIME" value={view.uptime == null ? 'Unavailable' : duration(view.uptime)} detail={metrics ? `OCC process up ${duration(metrics.process.uptimeSeconds)}` : 'Waiting for process readings'}/></section>
          <p className="scope">{view.hostReason ? `Host: ${view.hostReason}. ` : ''}OCC process RSS: {bytes(metrics?.process.memoryRssBytes)}. Runtime OS compatibility fields are not confirmed host totals.</p>
        </>}
        {page === 'overview' && <div className="two-col"><section className="panel"><PanelTitle title="Registered applications" count={snapshot.projects?.length} action={() => navigate('projects')}/><ProjectList projects={snapshot.projects}/></section>
          <section className="panel"><PanelTitle title="System details"/><dl className="details"><dt>Operating system</dt><dd>{metrics?.os ?? 'Unavailable'}</dd><dt>Architecture</dt><dd>{metrics?.architecture ?? 'Unavailable'}</dd><dt>OCC process memory</dt><dd>{bytes(metrics?.processMemoryBytes)}</dd><dt>Docker monitor</dt><dd>{snapshot.containers?.available ? `${snapshot.containers.mode} · ${snapshot.containers.containers.length} containers` : 'Not available'}</dd><dt>Execution policy</dt><dd><span className="status">Read-only</span></dd></dl></section></div>}
        {page === 'monitoring' && <div className="two-col"><section className="panel"><PanelTitle title="Network interfaces"/><p className="panel-note">{view.networkScope}</p>{view.network ? <div className="table-wrap"><table><thead><tr><th>Interface</th><th>Received (total)</th><th>Sent (total)</th></tr></thead><tbody>{view.network.map(n => <tr key={n.interface}><td>{n.interface}</td><td>{bytes(n.receivedBytes)}</td><td>{bytes(n.transmittedBytes)}</td></tr>)}</tbody></table></div> : <Empty text="Network counters unavailable on this runtime."/>}</section>
          <section className="panel"><PanelTitle title="Runtime details"/><dl className="details"><dt>Load (1 / 5 / 15 min)</dt><dd>{metrics?.cpu.load.map(x => x.toFixed(2)).join(' / ') ?? 'Unavailable'}</dd><dt>Visible processes</dt><dd>{metrics?.processCount ?? 'Unavailable'}</dd><dt>Runtime</dt><dd>{metrics?.os} / {metrics?.architecture}</dd></dl></section></div>}
        {page === 'projects' && <><section className="panel"><PanelTitle title="Project registry" count={snapshot.projects?.length}/><ProjectList projects={snapshot.projects}/></section>
          <section className="panel form-panel"><h2>Register an application</h2><p>Paste an OCC v1 manifest or a registration bundle containing manifest and metadata. Registration records metadata only; it never changes a deployment or connects to its URLs.</p><form onSubmit={async e => {
            e.preventDefault(); const form = e.currentTarget; const raw = String(new FormData(form).get('manifest'));
            try { const input = JSON.parse(raw); await api('/projects', 'POST', input.manifest ? input : { manifest: input }); form.reset(); setNotice('Application registered. Integration tokens are issued through the authenticated API.'); await refresh(); }
            catch (err) { setError(err instanceof Error ? err.message : 'Registration failed'); }
          }}><label>Project manifest (JSON)<textarea name="manifest" rows={8} required placeholder={'{"protocolVersion":"1.0","id":"my-app","name":"My app","version":"1.0.0","runtime":"external"}'}/></label><button className="primary">Register project</button></form></section></>}
        {page === 'containers' && <section className="panel"><PanelTitle title="Docker containers" count={snapshot.containers?.containers.length}/><p className="panel-note">{snapshot.containers?.reason ?? 'Read-only discovery. Existing deployments remain independent.'}</p>
          {snapshot.containers?.containers.length ? <div className="table-wrap"><table><thead><tr><th>Container</th><th>ID</th><th>Image</th><th>State</th><th>Health</th><th>Compose project</th></tr></thead><tbody>{snapshot.containers.containers.map(c => <tr key={c.id}><td>{c.name}</td><td><code className="container-id">{c.id}</code></td><td>{c.image}</td><td><span className="status">{c.state}</span></td><td>{c.health}</td><td>{c.composeProject ?? 'Standalone'}</td></tr>)}</tbody></table></div> : <Empty text="No container data. Configure the restricted monitor or manually register existing applications."/>}</section>}
        {page === 'bots' && <div className="two-col">{snapshot.bots?.map(bot => <section className="panel form-panel" key={bot.platform}><div className="integration-icon">{bot.platform === 'telegram' ? '↗' : '◎'}</div><h2>{label(bot.platform)}</h2><p>{bot.status}</p><p className="scope">{bot.observedAt ? `Last heartbeat ${new Date(bot.observedAt).toLocaleString()}` : 'No live heartbeat observed'}{bot.mode === 'live' && !bot.fresh ? ' · Stale / unavailable' : ''}</p><dl className="details"><dt>Transport mode</dt><dd>{bot.mode}</dd><dt>Recovery state</dt><dd>{bot.reason ?? 'none'} · {bot.attempt} retries</dd><dt>Next attempt</dt><dd>{bot.nextRetryAt ? new Date(bot.nextRetryAt).toLocaleTimeString() : 'None scheduled'}</dd><dt>Command registry</dt><dd>Shared OCC router</dd><dt>Group policy</dt><dd>Allowlisted sender + chat</dd></dl></section>)}</div>}
        {(page === 'overview' || page === 'activity') && <section className="panel"><PanelTitle title="Recent activity" action={page === 'overview' ? () => navigate('activity') : undefined}/>{snapshot.activity?.length ? <div className="table-wrap"><table><thead><tr><th>Action</th><th>Outcome</th><th>Interface</th><th>Time</th></tr></thead><tbody>{snapshot.activity.slice(0, page === 'overview' ? 5 : 100).map(a => <tr key={a.id}><td>{a.action}</td><td><span className="status neutral">{a.outcome}</span></td><td>{a.platform ?? 'Integration / core'}</td><td>{new Date(a.created_at).toLocaleString()}</td></tr>)}</tbody></table></div> : <Empty text="No activity recorded yet."/>}</section>}
        {page === 'settings' && <section className="panel form-panel"><h2>Workspace settings</h2><p>Security and network settings are configured on the server. No secrets are displayed here.</p><dl className="details"><dt>Base path</dt><dd>{snapshot.settings?.basePath}</dd><dt>Mode</dt><dd>{snapshot.settings?.mode}</dd><dt>Audit retention</dt><dd>{snapshot.settings?.retentionDays} days · 10,000 record cap</dd><dt>AI inference</dt><dd>Disabled</dd><dt>Docker writes / shell</dt><dd>Disabled</dd></dl><form onSubmit={async e => {
          e.preventDefault(); const value = Number(new FormData(e.currentTarget).get('pollingSeconds'));
          try { await api('/settings', 'PATCH', { pollingSeconds: value }); setPolling(value); setNotice('Refresh interval saved.'); }
          catch (err) { setError(err instanceof Error ? err.message : 'Save failed'); }
        }}><label>Refresh interval<select name="pollingSeconds" key={snapshot.settings?.pollingSeconds} defaultValue={snapshot.settings?.pollingSeconds ?? 15}><option value="15">15 seconds</option><option value="30">30 seconds</option><option value="60">60 seconds</option></select></label><button className="primary">Save preferences</button></form></section>}
        <footer><span>◈ Oracle Control Core</span><span>Small footprint. Clear boundaries.</span></footer>
      </main></div></div>;
}
function Metric({ title, value, detail, percent }: { title: string; value: string; detail: string; percent?: number }) {
  return <article className="metric"><p>{title}<span>↗</span></p><h2>{value}</h2><small>{detail}</small>{percent !== undefined && <progress max={100} value={Math.max(0, Math.min(100, percent))}/>}</article>;
}
function PanelTitle({ title, count, action }: { title: string; count?: number; action?: () => void }) {
  return <div className="panel-title"><h2>{title} {count !== undefined && <span className="count">{count}</span>}</h2>{action && <button className="text-button" onClick={action}>View all ↗</button>}</div>;
}
function Empty({ text }: { text: string }) { return <div className="empty"><span>◇</span><p>{text}</p></div>; }
function ProjectList({ projects }: { projects?: Project[] }) {
  if (!projects?.length) return <Empty text="No applications registered yet. Add a manifest in Projects to get started."/>;
  return <div>{projects.map(p => <div className="project-row" key={p.id}><span className="project-icon">▧</span><div><strong>{p.manifest.name}</strong><small>{p.manifest.runtime} · v{p.manifest.version}</small></div><span className={`status ${p.health !== 'healthy' ? 'neutral' : ''}`}>{p.health}</span></div>)}</div>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
