'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ArrowLeft, Loader2, ShieldAlert, Cpu, MonitorPlay, Lock } from 'lucide-react';
import type { ServerView, ActiveServerSession } from '../../lib/types';
import RdpClient, { type Phase } from './RdpClient';

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
  const [server, setServer] = useState<ServerView | null>(null);
  const [stage, setStage] = useState<Stage>('loading');
  const [conn, setConn] = useState<ConnectInfo | null>(null);
  const [password, setPassword] = useState('');
  const [livePhase, setLivePhase] = useState<Phase>('init');
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
      const res = await fetch(`/api/servers/${id}/connect`, { method: 'POST' });
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
  }, [id]);

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
      if (livePhase === 'connected') return { label: t('connected'), color: 'var(--success)' };
      if (livePhase === 'error') return { label: t('connectFailed'), color: 'var(--danger-fg)' };
      if (livePhase === 'closed') return { label: t('sessionEnded'), color: 'var(--muted)' };
      return { label: t('connecting'), color: 'var(--accent)' };
    }
    if (stage === 'connecting') return { label: t('connecting'), color: 'var(--accent)' };
    if (stage === 'denied') return { label: t('accessDeniedTitle'), color: 'var(--danger-fg)' };
    if (stage === 'error') return { label: t('sessionError'), color: 'var(--danger-fg)' };
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

        {/* live session — IronRDP / Devolutions Gateway */}
        {stage === 'live' && conn && server && (
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
                  <ShieldAlert size={36} style={{ color: 'var(--danger-fg)', marginBottom: 12 }} />
                  <div style={{ fontSize: 17, fontWeight: 640, color: 'var(--text)' }}>{t('accessDeniedTitle')}</div>
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
                  <div style={{ fontSize: 18, fontWeight: 650, color: 'var(--text)', letterSpacing: '-0.01em' }}>{t('readyTitle')}</div>
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
                          borderRadius: 999, fontSize: 13, fontWeight: 600, color: 'var(--warn)',
                          background: 'color-mix(in oklab, var(--warn) 13%, transparent)',
                          border: '1px solid color-mix(in oklab, var(--warn) 34%, transparent)',
                        }}
                      >
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--warn)' }} className="sess-pulse" />
                        {label}
                      </div>
                    );
                  })()}
                  <div>
                    <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={() => void onConnectClick()}>
                      <MonitorPlay size={16} style={{ marginRight: 7 }} /> {t('connect')}
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
                  <div style={{ fontSize: 17, fontWeight: 640, color: 'var(--text)', textAlign: 'center' }}>{t('passwordPromptTitle')}</div>
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
                  <div style={{ fontSize: 18, fontWeight: 650, color: 'var(--text)', letterSpacing: '-0.01em' }}>{t('gatewayPendingTitle')}</div>
                  <div style={{ fontSize: 14, marginTop: 8, lineHeight: 1.55 }}>{t('gatewayPendingBody')}</div>
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginTop: 18, fontSize: 12, color: 'rgba(231,233,238,.85)', padding: '7px 13px', borderRadius: 999, border: '1px solid var(--hover-2)', background: 'rgba(255,255,255,.03)', fontFamily: 'var(--font-mono, ui-monospace, monospace)' }}>
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
