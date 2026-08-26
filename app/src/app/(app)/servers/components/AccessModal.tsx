'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import { X, Loader2, UserPlus, Users, Trash2, ShieldCheck } from 'lucide-react';
import { Avatar } from '@/components/ui/avatar';
import { Select } from '@/components/ui/select';
import type { ServerView, OrgMember, DeptLite, Grant } from '../lib/types';

const STYLES = `
@keyframes acc-in { from { opacity:0; transform: translateY(8px) scale(.98); } to { opacity:1; transform:none; } }
@keyframes acc-fade { from { opacity:0; } to { opacity:1; } }
@keyframes acc-row { from { opacity:0; transform: translateX(-6px); } to { opacity:1; transform:none; } }
.acc-backdrop { animation: acc-fade .18s ease forwards; }
.acc-panel { animation: acc-in .26s cubic-bezier(.16,1,.3,1) forwards; }
.acc-grant { animation: acc-row .22s cubic-bezier(.16,1,.3,1) forwards; transition: background .12s ease; }
.acc-grant:hover { background: color-mix(in oklab, var(--surface-2) 70%, transparent); }
.acc-rm { opacity:.55; transition: opacity .12s ease, transform .1s ease; }
.acc-grant:hover .acc-rm { opacity: 1; }
.acc-rm:active { transform: scale(.9); }
@media (prefers-reduced-motion: reduce){ .acc-backdrop,.acc-panel,.acc-grant { animation: none; } }
`;

/** Admin: manage who can reach a server — per-user and per-department grants. */
export function AccessModal({
  server,
  members,
  departments,
  onClose,
  onChanged,
}: {
  server: ServerView;
  members: OrgMember[];
  departments: DeptLite[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const t = useTranslations('servers');
  const tc = useTranslations('common');
  const [grants, setGrants] = useState<Grant[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/servers/${server.id}/access`);
      if (res.ok) setGrants((await res.json()).grants ?? []);
    } finally {
      setLoading(false);
    }
  }, [server.id]);

  useEffect(() => { void load(); }, [load]);

  const grantedUserIds = useMemo(() => new Set(grants.filter((g) => g.user).map((g) => g.user!.id)), [grants]);
  const grantedDeptIds = useMemo(() => new Set(grants.filter((g) => g.department).map((g) => g.department!.id)), [grants]);

  const userOptions = [
    { value: '', label: t('addUser') },
    ...members.filter((m) => !grantedUserIds.has(m.id)).map((m) => ({ value: m.id, label: m.name || m.email || m.id })),
  ];
  const deptOptions = [
    { value: '', label: t('addDepartment') },
    ...departments.filter((d) => !grantedDeptIds.has(d.id)).map((d) => ({ value: d.id, label: d.name })),
  ];

  const grant = async (body: { userId?: string; departmentId?: string }) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/servers/${server.id}/access`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (res.ok) { await load(); onChanged(); }
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (grantId: string) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/servers/${server.id}/access?grantId=${grantId}`, { method: 'DELETE' });
      if (res.ok) { setGrants((gs) => gs.filter((g) => g.id !== grantId)); onChanged(); }
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div
      className="acc-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(4,6,10,.6)', backdropFilter: 'blur(3px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
    >
      <style>{STYLES}</style>
      <div className="acc-panel" style={{ width: '100%', maxWidth: 490, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 18, boxShadow: '0 30px 80px -24px rgba(0,0,0,.7), inset 0 1px 0 var(--hover)', maxHeight: '92vh', overflow: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '16px 18px', borderBottom: '1px solid var(--border)' }}>
          <span style={{ display: 'inline-flex', width: 32, height: 32, borderRadius: 9, alignItems: 'center', justifyContent: 'center', background: 'color-mix(in oklab, var(--accent) 14%, transparent)', color: 'var(--accent)' }}>
            <ShieldCheck size={17} />
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 640, letterSpacing: '-0.01em' }}>{t('manageAccess')}</h3>
            <div style={{ fontSize: 12, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{server.name}</div>
          </div>
          <button onClick={onClose} style={{ display: 'inline-flex', padding: 7, borderRadius: 8, border: '1px solid transparent', background: 'transparent', color: 'var(--muted)', cursor: 'pointer' }} aria-label={tc('cancel')}><X size={18} /></button>
        </div>

        <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ display: 'flex', gap: 10 }}>
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 7 }}>
              <UserPlus size={15} style={{ color: 'var(--muted)', flexShrink: 0 }} />
              <Select value="" onChange={(v) => v && grant({ userId: v })} options={userOptions} disabled={busy} style={{ flex: 1 }} />
            </div>
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 7 }}>
              <Users size={15} style={{ color: 'var(--muted)', flexShrink: 0 }} />
              <Select value="" onChange={(v) => v && grant({ departmentId: v })} options={deptOptions} disabled={busy} style={{ flex: 1 }} />
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {loading ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--muted)', fontSize: 13, padding: 10 }}>
                <Loader2 size={15} className="spin" /> {tc('loading')}
              </div>
            ) : grants.length === 0 ? (
              <div style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 13, padding: '22px 4px', border: '1px dashed var(--border)', borderRadius: 12 }}>
                {t('noGrants')}
              </div>
            ) : (
              grants.map((g) => (
                <div key={g.id} className="acc-grant" style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 10, background: 'var(--surface-2)' }}>
                  {g.user ? (
                    <>
                      <Avatar name={g.user.name || g.user.email || '?'} image={g.user.image} size="sm" />
                      <span style={{ flex: 1, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {g.user.name || g.user.email}
                      </span>
                    </>
                  ) : (
                    <>
                      <span style={{ width: 28, height: 28, borderRadius: 8, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: g.department?.color || 'var(--accent)', color: 'var(--on-accent)', flexShrink: 0 }}>
                        <Users size={14} />
                      </span>
                      <span style={{ flex: 1, fontSize: 13 }}>{g.department?.name}<span style={{ color: 'var(--muted)', fontSize: 11 }}> · {t('department')}</span></span>
                    </>
                  )}
                  <button onClick={() => revoke(g.id)} disabled={busy} className="acc-rm" style={{ display: 'inline-flex', padding: 6, borderRadius: 7, border: 'none', background: 'transparent', color: 'var(--muted)', cursor: 'pointer' }} aria-label={tc('delete')}>
                    <Trash2 size={15} />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '14px 18px', borderTop: '1px solid var(--border)' }}>
          <button onClick={onClose} className="btn btn-primary" style={{ fontWeight: 640 }}>{tc('done')}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
