import { useCallback, useEffect, useState } from 'react';
import { Activity, ArrowUpRight, BarChart3, Building2, CheckCircle2, ChevronDown, CircleHelp, ContactRound, Eye, EyeOff, Inbox, Layers3, LayoutDashboard, ListFilter, LockKeyhole, LogOut, Mail, Menu, PanelLeftClose, Plus, Search, Settings, ShieldCheck, Sparkles, Users, Waves, X } from 'lucide-react';
import { api, body, initials, list, setCsrf, useResource, type Session } from './api';
import { WorkspaceContext } from './context';
import { Button, FormError, Loading } from './ui';
import { Overview, Analytics, Health, Suppressions } from './pages/Reporting';
import { Contacts, ContactDetail, Pipeline } from './pages/Contacts';
import { Campaigns, Templates } from './pages/Campaigns';
import { InboxPage } from './pages/Inbox';
import { SettingsPage } from './pages/Settings';

const navigation = [
  { label: 'Overview', path: 'overview', icon: LayoutDashboard },
  { label: 'Prospects', path: 'prospects', icon: Users },
  { label: 'Campaigns', path: 'campaigns', icon: Mail },
  { label: 'Templates', path: 'templates', icon: Layers3 },
  { label: 'Inbox', path: 'inbox', icon: Inbox },
  { label: 'Pipeline', path: 'pipeline', icon: ContactRound },
  { label: 'Analytics', path: 'analytics', icon: BarChart3 },
];

function Login({ onLogin }: { onLogin: (session: Session) => void }) {
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [visible, setVisible] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  return <main className="login-layout"><div className="login-story"><a className="login-brand" href="https://sandiegowebsiteexperts.com" target="_blank" rel="noreferrer"><div className="brand-icon"><Waves size={27} /></div><span>San Diego<br /><strong>Website Experts</strong></span></a><div className="login-copy"><div className="eyebrow light">YOUR RELATIONSHIP WORKSPACE</div><h1>Good conversations.<br /><span>Lasting connections.</span></h1><p>A little more personal. A lot more organized. Bring your contacts, campaigns, and conversations together.</p><div className="login-pill"><ShieldCheck size={18} />Built for your agency. Owned by you.</div></div><div className="coastal-art" aria-hidden="true"><div className="sun" /><div className="coast coast-one" /><div className="coast coast-two" /><div className="coast coast-three" /></div><div className="login-story-footer">SAN DIEGO, CALIFORNIA <span>32.7157° N · 117.1611° W</span></div></div><div className="login-form-side"><div className="login-form"><div className="eyebrow">WELCOME BACK</div><h2>Your next connection<br />starts here.</h2><p>Sign in to your agency workspace.</p><form onSubmit={async e => { e.preventDefault(); setBusy(true); setError(''); try { const result = await api<Session>('/auth/login', body({ email, password })); setCsrf(result.csrfToken); onLogin(result); } catch (err: any) { setError(err.message); } finally { setBusy(false); } }}><label className="field"><span className="field-label">Email address</span><input type="email" autoComplete="username" placeholder="you@sandiegowebsiteexperts.com" required value={email} onChange={e => setEmail(e.target.value)} /></label><label className="field"><span className="field-label">Password</span><div className="password-field"><input type={visible ? 'text' : 'password'} autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} /><button type="button" className="icon-button" aria-label={visible ? 'Hide password' : 'Show password'} onClick={() => setVisible(!visible)}>{visible ? <EyeOff size={18} /> : <Eye size={18} />}</button></div></label><FormError error={error} /><Button type="submit" busy={busy}>Sign in to workspace <ArrowUpRight size={17} /></Button></form><p className="login-help"><LockKeyhole size={14} />Private agency workspace. Contact your owner for access.</p></div><div className="login-form-footer">© {new Date().getFullYear()} San Diego Website Experts <span>Thoughtful outreach, better relationships.</span></div></div></main>;
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null); const [sessionError, setSessionError] = useState('');
  const [revision, setRevision] = useState(0); const [route, setRoute] = useState(location.hash.slice(1) || 'overview');
  const [mobile, setMobile] = useState(false); const [toast, setToast] = useState<{ message: string; error: boolean } | null>(null);
  const refresh = useCallback(() => setRevision(v => v + 1), []);
  const notify = useCallback((message: string, error = false) => setToast({ message, error }), []);
  useEffect(() => { api<Session>('/auth/session').then(s => { setCsrf(s.csrfToken); setSession(s); }).catch(e => setSessionError(e.message)); }, []);
  useEffect(() => { let pending = false; const expired = async () => { if (pending) return; pending = true; try { const next = await api<Session>('/auth/session'); setCsrf(next.csrfToken); setSession(next); } finally { pending = false; } }; window.addEventListener('session-expired', expired); return () => window.removeEventListener('session-expired', expired); }, []);
  useEffect(() => { const onHash = () => { setRoute(location.hash.slice(1) || 'overview'); setMobile(false); window.scrollTo(0, 0); }; window.addEventListener('hashchange', onHash); return () => window.removeEventListener('hashchange', onHash); }, []);
  useEffect(() => { if (toast) { const timer = setTimeout(() => setToast(null), 6000); return () => clearTimeout(timer); } }, [toast]);
  const settings = useResource(session?.user ? '/settings' : null, revision);
  const accounts = useResource(session?.user ? '/accounts' : null, revision);
  const stages = useResource(session?.user ? '/stages' : null, revision);
  const users = useResource(session?.user ? '/users' : null, revision);
  const can = (permission: string) => session?.user?.role === 'owner' || Boolean(session?.user?.permissions?.includes(permission));
  const act = async <T,>(path: string, options: RequestInit, success?: string): Promise<T> => { try { const result = await api<T>(path, options); refresh(); if (success) notify(success); return result; } catch (e: any) { notify(e.message, true); throw e; } };
  if (!session) return sessionError ? <div className="boot-error"><div className="brand-icon"><Waves /></div><h1>Your workspace needs a connection.</h1><p>{sessionError}</p><p>Start the API and check your local database configuration, then reload.</p><Button onClick={() => location.reload()}>Reload workspace</Button></div> : <div className="boot"><Waves size={34} /><Loading /></div>;
  if (!session.user) return <Login onLogin={setSession} />;
  const active = route.split('/')[0]; const selected = navigation.find(n => n.path === active);
  const context = { session, revision, settings: settings.data || {}, accounts: list(accounts.data), stages: list(stages.data), users: list(users.data), can, refresh, notify, act };
  let content;
  if (active === 'prospects') content = route.includes('/') && route.split('/')[1] !== 'new' ? <ContactDetail id={route.split('/')[1]} /> : <Contacts />;
  else if (active === 'campaigns') content = <Campaigns />;
  else if (active === 'templates') content = <Templates />;
  else if (active === 'inbox') content = <InboxPage />;
  else if (active === 'pipeline') content = <Pipeline />;
  else if (active === 'analytics') content = <Analytics />;
  else if (active === 'suppressions') content = <Suppressions />;
  else if (active === 'settings') content = <SettingsPage />;
  else if (active === 'health') content = <Health />;
  else content = <Overview />;
  return <WorkspaceContext.Provider value={context}><div className="app-shell">{mobile && <div className="sidebar-shade" onClick={() => setMobile(false)} />}<aside className={`sidebar ${mobile ? 'open' : ''}`}><a href="#overview" className="brand"><div className="brand-icon"><Waves size={23} /></div><span>San Diego<strong>Website Experts</strong></span></a><div className="workspace-switch"><span className="workspace-avatar">SD</span><div><strong>Agency workspace</strong><span>San Diego Website Experts</span></div><ChevronDown size={14} /></div><div className="nav-label">WORKSPACE</div><nav aria-label="Main navigation">{navigation.map(({ label, path, icon: Icon }) => <a key={path} href={`#${path}`} className={`nav-item ${active === path ? 'active' : ''}`} aria-current={active === path ? 'page' : undefined}><Icon size={19} strokeWidth={1.8} /><span>{label}</span>{active === path && <span className="nav-active-dot" />}</a>)}</nav><div className="nav-label management-label">MANAGEMENT</div><nav aria-label="Management"><a href="#suppressions" className={`nav-item ${active === 'suppressions' ? 'active' : ''}`}><ShieldCheck size={19} />Suppression list</a><a href="#health" className={`nav-item ${active === 'health' ? 'active' : ''}`}><Activity size={19} />System health</a><a href="#settings" className={`nav-item ${active === 'settings' ? 'active' : ''}`}><Settings size={19} />Settings</a></nav><div className="sidebar-bottom"><div className="workspace-note"><span className="small-icon"><Sparkles size={16} /></span><strong>Make every message count.</strong><p>Personal connections start with thoughtful outreach.</p><a href="#campaigns">Your campaigns <ArrowUpRight size={13} /></a></div><div className="sidebar-user"><div className="avatar">{initials(session.user.name)}</div><div><strong>{session.user.name}</strong><span>{session.user.role === 'owner' ? 'Workspace owner' : 'Team member'}</span></div><button className="icon-button" title="Sign out" aria-label="Sign out" onClick={async () => { try { await api('/auth/logout', body({})); const next = await api<Session>('/auth/session'); setCsrf(next.csrfToken); setSession(next); } catch (e: any) { notify(e.message, true); } }}><LogOut size={17} /></button></div></div></aside><div className="main-shell"><header className="topbar"><div className="breadcrumb"><button className="icon-button mobile-menu" aria-label="Open navigation" onClick={() => setMobile(true)}><Menu size={22} /></button><span>Workspace</span><span className="breadcrumb-slash">/</span><strong>{selected?.label || (active === 'health' ? 'System health' : active === 'settings' ? 'Settings' : 'Suppression list')}</strong></div><div className="topbar-right"><a className="help-link" href="#health"><CircleHelp size={16} /><span>Workspace health</span></a><span className={`local-status ${settings.data?.paused === false ? 'enabled' : ''}`}><span />{settings.data?.paused === false ? 'Automation enabled' : 'Automation paused'}</span><div className="avatar avatar-small">{initials(session.user.name)}</div></div></header><main className="page-content" key={active}>{content}</main><footer className="app-footer"><span>San Diego Website Experts</span><span>Made for meaningful connections <Waves size={15} /></span></footer></div>{toast && <div className={`toast ${toast.error ? 'error' : ''}`} role="status">{toast.error ? <X size={19} /> : <CheckCircle2 size={19} />}<span>{toast.message}</span><button className="icon-button" aria-label="Dismiss notification" onClick={() => setToast(null)}><X size={16} /></button></div>}</div></WorkspaceContext.Provider>;
}
