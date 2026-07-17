'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ArrowLeft, Loader2, ShieldAlert, Cpu, MonitorPlay, Lock } from 'lucide-react';
import type { ServerView, ActiveServerSession } from '../../lib/types';
import RdpClient, { type Phase } from './RdpClient';
import GuacamoleClient from './GuacamoleClient';

const STYLES = `
@keyframes sess-ring { 0% { transform: scale(.62); opacity:.6; } 100% { transform: scale(2.3); opacity:0; } }
@keyframes sess-pulse { 0%,100% { opacity:.55; } 50% { opacity:1; } }
@keyframes sess-spin { to { transform: rotate(360deg); } }
.sess-ring { position:absolute; inset:0; border-radius:50%; border:1px solid color-mix(in oklab, var(--accent) 60%, transparent); animation: sess-ring 2.8s cubic-bezier(.16,1,.3,1) infinite; }
.sess-pulse { animation: sess-pulse 2.2s ease-in-out infinite; }
.spin { animation: sess-spin 1s linear infinite; }
@media (prefers-reduced-motion: reduce) { .sess-ring, .sess-pulse, .spin { animation: none; } }
`;

interface ConnectInfo {
  method?: 'guac'; // RDP v2 (Guacamole); absent → v1 (IronRDP/DGW)
  tunnelUrl?: string; // v2 only — the guac-tunnel wss base
  gatewayUrl: string;
  token: string;
  sessionId: string;
  destination: string;
  username: string;
  domain: string | null;
  hasStoredPassword: boolean;
  password: string; // decrypted server-side for the authorized caller; '' when none stored
}

// Pre-connect → token mint → live IronRDP session host. The WASM canvas + toolbar
// live in <RdpClient>; this page owns access-check, the connect handshake, the
// not-injected password prompt, and the gateway-pending fallback. Credentials that
// are stored on the server never reach the browser — the gateway injects them.
type Stage = 'loading' | 'idle' | 'needPassword' | 'connecting' | 'live' | 'gatewayPending' | 'denied' | 'error';

export default function ServerSessionPage() {
  const t = useTranslations('servers');
  const params = useParams<{ id: string }>();
  const id = params?.id;
  // Opt-in RDP v2 (Guacamole). Seeds from ?v=2 or a saved choice; the toggle persists it.
  // Read the URL client-side (NOT useSearchParams — that needs a Suspense boundary in
  // Next 15 and crashed the whole session page for every user, v1 included).
  const [v2, setV2] = useState(false);
  useEffect(() => {
    let saved = false;
    let fromUrl = false;
    try { saved = localStorage.getItem('garely-rdp-v2') === '1'; } catch { /* noop */ }
    try { fromUrl = new URLSearchParams(window.location.search).get('v') === '2'; } catch { /* noop */ }
    setV2(fromUrl || saved);
  }, []);
  const toggleV2 = (on: boolean) => {
    setV2(on);
    try { localStorage.setItem('garely-rdp-v2', on ? '1' : '0'); } catch { /* noop */ }
  };

  const [server, setServer] = useState<ServerView | null>(null);
  const [stage, setStage] = useState<Stage>('loading');
  const [conn, setConn] = useState<ConnectInfo | null>(null);
  const [password, setPassword] = useState('');
  const [livePhase, setLivePhase] = useState<Phase>('init');
  // v2 render scale (viewport × scale). guacd can't scale the Windows UI, so scale sets BOTH
  // sharpness and UI size. Two modes only, no picker: normal 1× and HD 1.25× (the levels that
  // read best in practice). Per-connection, default normal, not persisted — hdRef is what
  // doConnect reads (avoids a stale closure); hd state drives the pill's button.
  // Normal is a comfort choice (1× was too large). HD must equal devicePixelRatio: a render is
  // pixel-exact only when its width == frame × dpr — anything less gets upscaled by the browser
  // and looks soft no matter how high it is. On a dpr-2 Retina that means exactly 2×.
  const SCALE_NORMAL = 1.25;
  const HD_DESKTOP_SCALE = 150; // Windows UI scaling requested in HD (percent)
  const hdRef = useRef(false);
  const [hd, setHd] = useState(false);
  const hdScaleRef = useRef(2);
  const [hdScale, setHdScale] = useState(2);
  useEffect(() => {
    const dpr = Math.min(Math.max(window.devicePixelRatio || 1, 1), 2);
    const v = Math.max(SCALE_NORMAL + 0.25, dpr); // never below normal — HD is always an upgrade
    hdScaleRef.current = v;
    setHdScale(v);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Guards against racing reconnects: rapid scale/HD changes fire several /connect requests, and
  // whichever RESPONSE lands last used to win — so the session could end up at an older scale
  // while the UI showed the newest one (this is what made the on-screen scale label lie).
  const connectSeq = useRef(0);

  useEffect(() => {
    if (!id) return;
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/servers/${id}`);
        if (!alive) return;
        if (res.status === 403 || res.status === 404) return setStage('denied');
        if (!res.ok) return setStage('error');
        setServer(await res.json());
        setStage('idle');
      } catch {
        if (alive) setStage('error');
      }
    })();
    return () => {
      alive = false;
    };
  }, [id]);

  const doConnect = useCallback(async () => {
    if (!id) return;
    const seq = ++connectSeq.current; // only the newest connect may apply its result
    setStage('connecting');
    try {
      // For v2, start guacd at viewport × the chosen scale. guacd can't scale the remote Windows
      // UI (it sets no DesktopScaleFactor), so this single number sets both sharpness and UI size.
      let url = `/api/servers/${id}/connect`;
      if (v2) {
        const s = hdRef.current ? hdScaleRef.current : SCALE_NORMAL;
        const w = Math.round((window.innerWidth || 1280) * s);
        const h = Math.round((window.innerHeight || 800) * s);
        url += `?v=2&w=${w}&h=${h}`;
        // HD renders at device-pixel density (crisp) and asks Windows to scale its UI to
        // 150%, so the extra pixels buy sharpness instead of shrinking everything. Needs our
        // patched guacd; a stock guacd ignores it (the picture is just crisp-and-small).
        if (hdRef.current) url += `&ds=${HD_DESKTOP_SCALE}`;
      }
      const res = await fetch(url, { method: 'POST' });
      if (seq !== connectSeq.current) return; // superseded by a newer connect — drop this response
      if (res.status === 403 || res.status === 404) return setStage('denied');
      if (res.status === 503) return setStage('gatewayPending');
      if (!res.ok) return setStage('error');
      const info = await res.json();
      if (seq !== connectSeq.current) return;
      setConn(info);
      setStage('live');
    } catch {
      if (seq === connectSeq.current) setStage('error');
    }
  }, [id, v2]);

  // HD toggle: flip the mode, then reconnect so guacd starts at the new resolution (its live
  // display-update resize is unreliable, especially when shrinking).
  const toggleHd = useCallback(() => {
    hdRef.current = !hdRef.current;
    setHd(hdRef.current);
    void doConnect();
  }, [doConnect]);

  // Connect entry: re-check live occupancy (so the warning is accurate at click time),
  // warn if someone else is already connected (RDP bumps the prior session for the same
  // account), then prompt for a password when none is stored, else connect.
  const onConnectClick = useCallback(async () => {
    let others: ActiveServerSession[] = (server?.activeSessions ?? []).filter((s) => !s.isSelf);
    try {
      const res = await fetch(`/api/servers/${id}`);
      if (res.ok) {
        const fresh: ServerView = await res.json();
        setServer(fresh);
        others = (fresh.activeSessions ?? []).filter((s) => !s.isSelf);
      }
    } catch {
      /* use last-known occupancy */
    }
    if (others.length > 0) {
      const name = others[0].name?.trim() || t('someone');
      if (!window.confirm(t('inUseConfirm', { name }))) return;
    }
    if (server && !server.hasSecret) {
      setStage('needPassword');
      return;
    }
    void doConnect();
  }, [server, doConnect, id, t]);

  const statusPill = (() => {
    if (stage === 'live') {
      if (livePhase === 'connected') return { label: t('connected'), color: '#10b981' };
      if (livePhase === 'error') return { label: t('connectFailed'), color: '#f87171' };
      if (livePhase === 'closed') return { label: t('sessionEnded'), color: 'var(--muted)' };
      return { label: t('connecting'), color: 'var(--accent)' };
    }
    if (stage === 'connecting') return { label: t('connecting'), color: 'var(--accent)' };
    if (stage === 'denied') return { label: t('accessDeniedTitle'), color: '#f87171' };
    if (stage === 'error') return { label: t('sessionError'), color: '#f87171' };
    return { label: 'RDP', color: 'var(--accent)' };
  })();

  return (
    <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
      <div style={{ maxWidth: 1180, margin: '0 auto', padding: '30px clamp(16px, 4vw, 44px) 64px' }}>
        <style>{STYLES}</style>

        {/* header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
          <Link href="/servers" className="btn btn-ghost" style={{ padding: 8, textDecoration: 'none' }} aria-label={t('back')}>
            <ArrowLeft size={18} />
          </Link>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h1 style={{ margin: 0, fontSize: 18, fontWeight: 640, letterSpacing: '-0.01em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {server ? server.name : t('session')}
            </h1>
            {/* address/login subtitle — admins only; the member view omits host/username */}
            {server?.host && (
              <div style={{ fontSize: 12.5, color: 'var(--muted)', fontFamily: 'var(--font-mono, ui-monospace, monospace)' }}>
                {server.domain ? `${server.domain}\\${server.username}` : server.username}
                <span style={{ opacity: 0.5 }}> @ </span>
                {server.host}:{server.port}
              </div>
            )}
          </div>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '5px 11px', borderRadius: 999, border: '1px solid var(--border)', background: 'var(--surface)', fontSize: 12, fontWeight: 600 }}>
            <span className="sess-pulse" style={{ width: 8, height: 8, borderRadius: '50%', background: statusPill.color }} />
            {statusPill.label}
          </span>
        </div>

        {/* live session — RDP v2 (Guacamole) when the connect route returned method:'guac' */}
        {stage === 'live' && conn && server && conn.method === 'guac' && (
          <GuacamoleClient
            key={conn.sessionId}
            tunnelUrl={conn.tunnelUrl || ''}
            token={conn.token}
            serverName={server.name}
            scale={hd ? hdScale : SCALE_NORMAL}
            hd={hd}
            onToggleHd={toggleHd}
            onExit={() => {
              setConn(null);
              setLivePhase('init');
              setStage('idle');
            }}
          />
        )}

        {/* live session — v1 (IronRDP / Devolutions Gateway) */}
        {stage === 'live' && conn && server && conn.method !== 'guac' && (
          <RdpClient
            key={conn.sessionId}
            connectionId={id!}
            gatewayUrl={conn.gatewayUrl}
            token={conn.token}
            destination={conn.destination}
            sessionId={conn.sessionId}
            serverName={server.name}
            username={conn.username}
            domain={conn.domain}
            password={conn.hasStoredPassword ? conn.password : password}
            onPhase={setLivePhase}
            onRequestReconnect={() => void doConnect()}
            onExit={() => {
              setConn(null);
              setPassword('');
              setLivePhase('init');
              setStage('idle');
            }}
          />
        )}

        {/* everything else renders inside the faux window frame */}
        {stage !== 'live' && (
          <div style={{ border: '1px solid var(--border)', borderRadius: 16, overflow: 'hidden', background: '#0a0d12', boxShadow: '0 24px 70px -30px rgba(0,0,0,.7)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderBottom: '1px solid rgba(255,255,255,.07)', background: 'rgba(255,255,255,.02)' }}>
              <div style={{ display: 'flex', gap: 6 }}>
                <span style={{ width: 11, height: 11, borderRadius: '50%', background: '#ff5f57' }} />
                <span style={{ width: 11, height: 11, borderRadius: '50%', background: '#febc2e' }} />
                <span style={{ width: 11, height: 11, borderRadius: '50%', background: '#28c840' }} />
              </div>
            </div>

            <div style={{ minHeight: 'min(72vh, 720px)', display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: 32 }}>
              {(stage === 'loading' || stage === 'connecting') && (
                <div style={{ color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 10 }}>
                  <Loader2 size={18} className="spin" /> {t('connecting')}
                </div>
              )}

              {stage === 'denied' && (
                <div style={{ color: 'var(--muted)', maxWidth: 380 }}>
                  <ShieldAlert size={36} style={{ color: '#f87171', marginBottom: 12 }} />
                  <div style={{ fontSize: 17, fontWeight: 640, color: '#e7e9ee' }}>{t('accessDeniedTitle')}</div>
                  <div style={{ fontSize: 14, marginTop: 8 }}>{t('accessDeniedBody')}</div>
                  <Link href="/servers" className="btn" style={{ marginTop: 18, textDecoration: 'none' }}>{t('back')}</Link>
                </div>
              )}

              {stage === 'error' && <div style={{ color: 'var(--muted)' }}>{t('sessionError')}</div>}

              {stage === 'idle' && server && (
                <div style={{ color: 'rgba(231,233,238,.7)', maxWidth: 460 }}>
                  <div style={{ position: 'relative', width: 92, height: 92, margin: '0 auto 20px' }}>
                    <span className="sess-ring" />
                    <span className="sess-ring" style={{ animationDelay: '1.4s' }} />
                    <span style={{ position: 'absolute', inset: 16, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'color-mix(in oklab, var(--accent) 18%, #0a0d12)', color: 'var(--accent)', border: '1px solid color-mix(in oklab, var(--accent) 40%, transparent)' }}>
                      <MonitorPlay size={26} />
                    </span>
                  </div>
                  <div style={{ fontSize: 18, fontWeight: 650, color: '#e7e9ee', letterSpacing: '-0.01em' }}>{t('readyTitle')}</div>
                  <div style={{ fontSize: 14, marginTop: 8, lineHeight: 1.55 }}>{t('readyBody')}</div>
                  {(() => {
                    const others = (server.activeSessions ?? []).filter((s) => !s.isSelf);
                    if (others.length === 0) return null;
                    const name = others[0].name?.trim() || t('someone');
                    const extra = others.length - 1;
                    const label = extra > 0 ? `${t('inUseBy', { name })} +${extra}` : t('inUseBy', { name });
                    return (
                      <div
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: 8, marginTop: 16, padding: '8px 14px',
                          borderRadius: 999, fontSize: 13, fontWeight: 600, color: '#f59e0b',
                          background: 'color-mix(in oklab, #f59e0b 13%, transparent)',
                          border: '1px solid color-mix(in oklab, #f59e0b 34%, transparent)',
                        }}
                      >
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#f59e0b' }} className="sess-pulse" />
                        {label}
                      </div>
                    );
                  })()}
                  {/* RDP method — v1 (standard) vs v2 (Guacamole, beta) */}
                  <div style={{ display: 'inline-flex', marginTop: 18, padding: 3, gap: 3, borderRadius: 999, border: '1px solid var(--border)', background: 'rgba(255,255,255,.03)' }}>
                    {[{ on: false, label: 'Стандарт' }, { on: true, label: 'V2 (beta)' }].map((o) => (
                      <button
                        key={String(o.on)}
                        onClick={() => toggleV2(o.on)}
                        style={{
                          padding: '5px 15px', borderRadius: 999, border: 'none', cursor: 'pointer', fontSize: 12.5, fontWeight: 600,
                          background: v2 === o.on ? 'var(--accent)' : 'transparent',
                          color: v2 === o.on ? '#fff' : 'var(--muted)',
                        }}
                      >
                        {o.label}
                      </button>
                    ))}
                  </div>
                  <div>
                    <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={() => void onConnectClick()}>
                      <MonitorPlay size={16} style={{ marginRight: 7 }} /> {t('connect')}{v2 ? ' · V2' : ''}
                    </button>
                  </div>
                </div>
              )}

              {stage === 'needPassword' && server && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (password) void doConnect();
                  }}
                  style={{ width: '100%', maxWidth: 360, textAlign: 'left' }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 9, justifyContent: 'center', marginBottom: 14, color: 'var(--accent)' }}>
                    <Lock size={22} />
                  </div>
                  <div style={{ fontSize: 17, fontWeight: 640, color: '#e7e9ee', textAlign: 'center' }}>{t('passwordPromptTitle')}</div>
                  <div style={{ fontSize: 13.5, marginTop: 8, color: 'var(--muted)', textAlign: 'center', lineHeight: 1.5 }}>
                    {t('passwordPromptBody', {
                      user: server.username
                        ? (server.domain ? `${server.domain}\\${server.username}` : server.username)
                        : server.name,
                    })}
                  </div>
                  <input
                    type="password"
                    autoFocus
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={t('password')}
                    className="field"
                    style={{ width: '100%', marginTop: 16 }}
                  />
                  <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
                    <button type="button" className="btn btn-ghost" style={{ flex: 1 }} onClick={() => { setPassword(''); setStage('idle'); }}>
                      {t('cancel')}
                    </button>
                    <button type="submit" className="btn btn-primary" style={{ flex: 1 }} disabled={!password}>
                      {t('connect')}
                    </button>
                  </div>
                </form>
              )}

              {stage === 'gatewayPending' && (
                <div style={{ color: 'rgba(231,233,238,.7)', maxWidth: 480 }}>
                  <div style={{ position: 'relative', width: 92, height: 92, margin: '0 auto 20px' }}>
                    <span className="sess-ring" />
                    <span className="sess-ring" style={{ animationDelay: '1.4s' }} />
                    <span style={{ position: 'absolute', inset: 16, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'color-mix(in oklab, var(--accent) 18%, #0a0d12)', color: 'var(--accent)', border: '1px solid color-mix(in oklab, var(--accent) 40%, transparent)' }}>
                      <Cpu size={26} />
                    </span>
                  </div>
                  <div style={{ fontSize: 18, fontWeight: 650, color: '#e7e9ee', letterSpacing: '-0.01em' }}>{t('gatewayPendingTitle')}</div>
                  <div style={{ fontSize: 14, marginTop: 8, lineHeight: 1.55 }}>{t('gatewayPendingBody')}</div>
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginTop: 18, fontSize: 12, color: 'rgba(231,233,238,.85)', padding: '7px 13px', borderRadius: 999, border: '1px solid rgba(255,255,255,.12)', background: 'rgba(255,255,255,.03)', fontFamily: 'var(--font-mono, ui-monospace, monospace)' }}>
                    <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--accent)' }} className="sess-pulse" />
                    IronRDP · Devolutions Gateway
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
