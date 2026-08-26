'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import {
  Server as ServerIcon, Plus, Pencil, Trash2, ShieldCheck, ArrowRight, Loader2,
  Users as UsersIcon, Network, Building2,
} from 'lucide-react';
import { ServerFormModal } from './components/ServerFormModal';
import { AccessModal } from './components/AccessModal';
import type { ServerView, OrgMember, DeptLite } from './lib/types';

const STYLES = `
@keyframes srv-up { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: none; } }
@keyframes srv-shimmer { 0% { background-position: -340px 0; } 100% { background-position: 340px 0; } }
@keyframes srv-breathe { 0%,100% { opacity:.4; transform: scale(1); } 50% { opacity:1; transform: scale(1.35); } }
.srv-reveal { opacity: 0; animation: srv-up .52s cubic-bezier(.16,1,.3,1) forwards; }
.srv-node { position: relative; overflow: hidden; transition: transform .18s cubic-bezier(.16,1,.3,1), border-color .18s ease, box-shadow .18s ease; }
.srv-node:hover { transform: translateY(-3px); border-color: color-mix(in oklab, var(--accent) 55%, var(--border)); box-shadow: 0 16px 44px -16px color-mix(in oklab, var(--accent) 34%, transparent), inset 0 1px 0 rgba(255,255,255,.05); }
.srv-node:active { transform: translateY(-1px) scale(.995); }
.srv-rail { position:absolute; left:0; top:0; bottom:0; width:3px; background: var(--accent); opacity:.35; transition: opacity .18s ease; }
.srv-node:hover .srv-rail { opacity: 1; }
.srv-dot { animation: srv-breathe 2.6s ease-in-out infinite; }
.srv-connect .srv-arrow { transition: transform .2s cubic-bezier(.16,1,.3,1); }
.srv-node:hover .srv-connect .srv-arrow { transform: translateX(4px); }
.srv-act { opacity: 0; transform: translateY(-3px); transition: opacity .15s ease, transform .15s ease; }
.srv-node:hover .srv-act, .srv-node:focus-within .srv-act { opacity: 1; transform: none; }
@media (hover: none) { .srv-act { opacity: .85; transform: none; } }
.srv-skel { background: linear-gradient(90deg, var(--surface) 25%, var(--surface-2) 37%, var(--surface) 63%); background-size: 600px 100%; animation: srv-shimmer 1.4s ease-in-out infinite; border-radius: 16px; }
.srv-iconbtn { display:inline-flex; align-items:center; justify-content:center; width:30px; height:30px; border-radius:8px; border:1px solid transparent; background:transparent; color:var(--muted); cursor:pointer; transition: all .12s ease; }
.srv-iconbtn:hover { background: var(--surface-2); border-color: var(--border); color: var(--text); }
.srv-iconbtn:active { transform: scale(.92); }
.srv-iconbtn.danger:hover { color:var(--danger-fg); border-color: color-mix(in oklab, var(--danger-fg) 40%, transparent); }
.srv-cta { transition: transform .14s cubic-bezier(.16,1,.3,1), box-shadow .18s ease; }
.srv-cta:active { transform: translateY(1px) scale(.985); }
.spin { animation: srv-spin 1s linear infinite; }
@keyframes srv-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .srv-reveal, .srv-dot, .srv-skel, .spin { animation: none; opacity: 1; } .srv-node, .srv-connect .srv-arrow { transition: none; } }
`;

export default function ServersPage() {
  const t = useTranslations('servers');
  const tc = useTranslations('common');

  const [servers, setServers] = useState<ServerView[]>([]);
  const [canManage, setCanManage] = useState(false);
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [departments, setDepartments] = useState<DeptLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const [formFor, setFormFor] = useState<ServerView | null | undefined>(undefined); // undefined=closed, null=new
  const [accessFor, setAccessFor] = useState<ServerView | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetch('/api/servers');
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      setServers(data.servers ?? []);
      setCanManage(!!data.canManage);
      if (data.canManage) {
        const [mRes, dRes] = await Promise.all([fetch('/api/org/members'), fetch('/api/departments')]);
        if (mRes.ok) setMembers(await mRes.json());
        if (dRes.ok) setDepartments((await dRes.json()).map((d: DeptLite) => ({ id: d.id, name: d.name, color: d.color })));
      }
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Live presence: silently refresh the server list every 25s (and when the tab
  // refocuses) so "in use by …" stays current without showing skeletons.
  useEffect(() => {
    const tick = async () => {
      try {
        const res = await fetch('/api/servers');
        if (!res.ok) return;
        const data = await res.json();
        setServers(data.servers ?? []);
      } catch {
        /* keep last-known on a transient failure */
      }
    };
    const id = setInterval(tick, 25_000);
    const onVis = () => { if (document.visibilityState === 'visible') void tick(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVis); };
  }, []);

  // Compact "who's using this server right now" label for a card. null = free.
  const occupancyLabel = useCallback((sessions: ServerView['activeSessions']): string | null => {
    if (!sessions || sessions.length === 0) return null;
    const others = sessions.filter((s) => !s.isSelf);
    if (others.length === 0) return t('inUseByYou'); // only my own session
    const name = others[0].name?.trim() || t('someone');
    const extra = others.length - 1;
    return extra > 0 ? `${t('inUseBy', { name })} +${extra}` : t('inUseBy', { name });
  }, [t]);

  const del = async (id: string) => {
    if (!confirm(t('confirmDelete'))) return;
    setDeletingId(id);
    try {
      const res = await fetch(`/api/servers/${id}`, { method: 'DELETE' });
      if (res.ok) setServers((s) => s.filter((x) => x.id !== id));
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
      <div style={{ maxWidth: 1180, margin: '0 auto', padding: '30px clamp(16px, 4vw, 44px) 64px' }}>
      <style>{STYLES}</style>

      {/* ── Editorial header: left title block, right stat + action ── */}
      <header style={{ position: 'relative', marginBottom: 26 }}>
        <div
          aria-hidden
          style={{
            position: 'absolute', inset: '-30px -40px auto -40px', height: 120, pointerEvents: 'none',
            background: 'radial-gradient(60% 100% at 18% 0%, color-mix(in oklab, var(--accent) 16%, transparent), transparent 70%)',
          }}
        />
        <div style={{ position: 'relative', display: 'flex', alignItems: 'flex-end', gap: 18, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 240 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--accent)', fontSize: 12, fontWeight: 700, letterSpacing: '.14em', textTransform: 'uppercase' }}>
              <Network size={14} /> RDP
            </div>
            <h1 style={{ margin: '8px 0 0', fontSize: 27, fontWeight: 680, letterSpacing: '-0.02em', lineHeight: 1.05 }}>
              {t('title')}
            </h1>
            <p style={{ margin: '8px 0 0', color: 'var(--muted)', fontSize: 14, maxWidth: '52ch' }}>{t('subtitle')}</p>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            {!loading && !error && servers.length > 0 && (
              <div style={{ textAlign: 'right', lineHeight: 1.1 }}>
                <div style={{ fontSize: 22, fontWeight: 700, fontFamily: 'var(--font-mono, ui-monospace, monospace)', letterSpacing: '-0.02em' }}>
                  {String(servers.length).padStart(2, '0')}
                </div>
                <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.08em' }}>
                  {t('serverCount', { count: servers.length })}
                </div>
              </div>
            )}
            {canManage && (
              <button className="btn btn-primary srv-cta" onClick={() => setFormFor(null)} style={{ fontWeight: 650 }}>
                <Plus size={16} /> {t('newServer')}
              </button>
            )}
          </div>
        </div>
        <div style={{ marginTop: 18, height: 1, background: 'linear-gradient(90deg, var(--border), transparent)' }} />
      </header>

      {/* ── Loading skeletons (match card geometry) ── */}
      {loading ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 16 }}>
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="srv-skel" style={{ height: 150, animationDelay: `${i * 120}ms` }} />
          ))}
        </div>
      ) : error ? (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '64px 20px', color: 'var(--muted)' }}>
          <Network size={28} style={{ opacity: 0.5 }} />
          <div>{tc('loadError')}</div>
          <button className="btn srv-cta" onClick={() => void load()}>{tc('retry')}</button>
        </div>
      ) : servers.length === 0 ? (
        /* ── Composed empty state ── */
        <div
          style={{
            position: 'relative', overflow: 'hidden', textAlign: 'center',
            padding: '60px 24px', border: '1px dashed var(--border)', borderRadius: 20, background: 'var(--surface)',
          }}
        >
          <div aria-hidden style={{ position: 'absolute', inset: 0, background: 'radial-gradient(50% 80% at 50% 0%, color-mix(in oklab, var(--accent) 10%, transparent), transparent 70%)', pointerEvents: 'none' }} />
          <div style={{ position: 'relative' }}>
            <span style={{ display: 'inline-flex', width: 60, height: 60, borderRadius: 16, alignItems: 'center', justifyContent: 'center', background: 'color-mix(in oklab, var(--accent) 14%, transparent)', color: 'var(--accent)', marginBottom: 16 }}>
              <ServerIcon size={28} />
            </span>
            <div style={{ fontSize: 18, fontWeight: 650, letterSpacing: '-0.01em' }}>
              {canManage ? t('emptyAdminTitle') : t('emptyMemberTitle')}
            </div>
            <div style={{ color: 'var(--muted)', fontSize: 14, marginTop: 8, maxWidth: 430, marginInline: 'auto', lineHeight: 1.5 }}>
              {canManage ? t('emptyAdminBody') : t('emptyMemberBody')}
            </div>
            {canManage && (
              <button className="btn btn-primary srv-cta" onClick={() => setFormFor(null)} style={{ marginTop: 18, fontWeight: 650 }}>
                <Plus size={16} /> {t('newServer')}
              </button>
            )}
          </div>
        </div>
      ) : (
        /* ── Connection grid ── */
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 16 }}>
          {servers.map((s, i) => {
            const identity = s.domain ? `${s.domain}\\${s.username}` : s.username;
            const occ = occupancyLabel(s.activeSessions);
            const occByOthers = (s.activeSessions ?? []).some((x) => !x.isSelf);
            return (
              <article
                key={s.id}
                className="srv-node srv-reveal"
                style={{
                  animationDelay: `${Math.min(i, 10) * 50}ms`,
                  border: '1px solid var(--border)', borderRadius: 16, background: 'var(--surface)',
                  padding: '16px 18px 16px 20px', display: 'flex', flexDirection: 'column', gap: 14,
                }}
              >
                <span className="srv-rail" aria-hidden />

                {/* Row: status + name + admin actions */}
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 11 }}>
                  <span style={{ position: 'relative', display: 'inline-flex', width: 40, height: 40, flexShrink: 0, alignItems: 'center', justifyContent: 'center', borderRadius: 11, background: 'color-mix(in oklab, var(--accent) 13%, transparent)', color: 'var(--accent)' }}>
                    <ServerIcon size={20} />
                    <span
                      className="srv-dot"
                      aria-hidden
                      style={{ position: 'absolute', right: -2, top: -2, width: 9, height: 9, borderRadius: '50%', background: 'var(--accent)', border: '2px solid var(--surface)' }}
                    />
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 15.5, fontWeight: 640, letterSpacing: '-0.01em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {s.name}
                    </div>
                    {/* address shown to admins only — members never see host:port */}
                    {s.host && (
                      <div style={{ fontSize: 12.5, color: 'var(--muted)', fontFamily: 'var(--font-mono, ui-monospace, monospace)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 2 }}>
                        {s.host}<span style={{ opacity: 0.5 }}>:</span>{s.port}
                      </div>
                    )}
                  </div>
                  {canManage && (
                    <div className="srv-act" style={{ display: 'flex', gap: 2, marginRight: -4 }}>
                      <button className="srv-iconbtn" title={tc('edit')} onClick={() => setFormFor(s)}><Pencil size={15} /></button>
                      <button className="srv-iconbtn" title={t('manageAccess')} onClick={() => setAccessFor(s)}><ShieldCheck size={15} /></button>
                      <button className="srv-iconbtn danger" title={tc('delete')} disabled={deletingId === s.id} onClick={() => void del(s.id)}>
                        {deletingId === s.id ? <Loader2 size={15} className="spin" /> : <Trash2 size={15} />}
                      </button>
                    </div>
                  )}
                </div>

                {/* Meta chips */}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, fontSize: 11.5 }}>
                  {s.username && (
                    <span style={{ padding: '3px 9px', borderRadius: 999, background: 'var(--surface-2)', color: 'var(--text-2)', fontFamily: 'var(--font-mono, ui-monospace, monospace)' }}>
                      {identity}
                    </span>
                  )}
                  <span style={{ padding: '3px 9px', borderRadius: 999, border: '1px solid var(--border)', color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 600 }}>
                    {s.protocol}
                  </span>
                  {canManage && typeof s.accessCount === 'number' && (
                    <span style={{ padding: '3px 9px', borderRadius: 999, background: 'var(--surface-2)', color: 'var(--text-2)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      {s.accessCount > 0 ? <UsersIcon size={12} /> : <Building2 size={12} />} {t('grantsCount', { count: s.accessCount })}
                    </span>
                  )}
                </div>

                {/* Live presence — who's currently connected */}
                {occ && (
                  <div
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 7, alignSelf: 'flex-start',
                      maxWidth: '100%', padding: '4px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600,
                      background: occByOthers ? 'color-mix(in oklab, var(--warn) 14%, transparent)' : 'var(--surface-2)',
                      color: occByOthers ? 'var(--warn)' : 'var(--muted)',
                      border: `1px solid ${occByOthers ? 'color-mix(in oklab, var(--warn) 35%, transparent)' : 'var(--border)'}`,
                    }}
                    title={occ}
                  >
                    <span
                      className="srv-dot"
                      aria-hidden
                      style={{ width: 7, height: 7, flexShrink: 0, borderRadius: '50%', background: occByOthers ? 'var(--warn)' : 'var(--success)' }}
                    />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{occ}</span>
                  </div>
                )}

                {/* Connect */}
                <Link
                  href={`/servers/${s.id}/session`}
                  className="btn btn-primary srv-connect srv-cta"
                  style={{ justifyContent: 'center', gap: 8, fontWeight: 640, textDecoration: 'none', marginTop: 'auto' }}
                >
                  {t('connect')} <ArrowRight size={16} className="srv-arrow" />
                </Link>
              </article>
            );
          })}
        </div>
      )}

      {formFor !== undefined && (
        <ServerFormModal
          initial={formFor}
          departments={departments}
          onClose={() => setFormFor(undefined)}
          onSaved={() => { setFormFor(undefined); void load(); }}
        />
      )}
      {accessFor && (
        <AccessModal
          server={accessFor}
          members={members}
          departments={departments}
          onClose={() => setAccessFor(null)}
          onChanged={() => void load()}
        />
      )}
      </div>
    </div>
  );
}
