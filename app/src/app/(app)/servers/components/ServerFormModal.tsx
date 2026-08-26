'use client';

import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import { X, Loader2, Server as ServerIcon } from 'lucide-react';
import { Select } from '@/components/ui/select';
import type { ServerView, DeptLite } from '../lib/types';

const STYLES = `
@keyframes srvf-in { from { opacity:0; transform: translateY(8px) scale(.98); } to { opacity:1; transform:none; } }
@keyframes srvf-fade { from { opacity:0; } to { opacity:1; } }
.srvf-backdrop { animation: srvf-fade .18s ease forwards; }
.srvf-panel { animation: srvf-in .26s cubic-bezier(.16,1,.3,1) forwards; }
.srvf-input { width:100%; padding:9px 11px; border-radius:10px; border:1px solid var(--border); background: var(--bg); color: var(--text); font-size:14px; outline:none; transition: border-color .14s ease, box-shadow .14s ease; }
.srvf-input:focus { border-color: color-mix(in oklab, var(--accent) 70%, var(--border)); box-shadow: 0 0 0 3px color-mix(in oklab, var(--accent) 18%, transparent); }
.srvf-input::placeholder { color: var(--muted-2, var(--muted)); }
.srvf-save { transition: transform .14s cubic-bezier(.16,1,.3,1); }
.srvf-save:active:not(:disabled) { transform: translateY(1px) scale(.985); }
@media (prefers-reduced-motion: reduce){ .srvf-backdrop, .srvf-panel { animation: none; } }
`;

/** Create / edit a ServerConnection. Password is write-only: on edit it stays blank
 *  and is only sent when the admin types a new one ("leave blank to keep"). */
export function ServerFormModal({
  initial,
  departments,
  onClose,
  onSaved,
}: {
  initial: ServerView | null;
  departments: DeptLite[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations('servers');
  const tc = useTranslations('common');
  const editing = !!initial;

  const [name, setName] = useState(initial?.name ?? '');
  const [host, setHost] = useState(initial?.host ?? '');
  const [port, setPort] = useState(String(initial?.port ?? 3389));
  const [username, setUsername] = useState(initial?.username ?? '');
  const [password, setPassword] = useState('');
  const [domain, setDomain] = useState(initial?.domain ?? '');
  const [departmentId, setDepartmentId] = useState(initial?.departmentId ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const deptOptions = [{ value: '', label: t('noDepartment') }, ...departments.map((d) => ({ value: d.id, label: d.name }))];

  const save = async () => {
    setError(null);
    if (!name.trim() || !host.trim() || !username.trim()) {
      setError(t('errRequired'));
      return;
    }
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        host: host.trim(),
        port: Number(port) || 3389,
        username: username.trim(),
        domain: domain.trim() || null,
        departmentId: departmentId || null,
      };
      if (password) body.password = password;
      const res = await fetch(editing ? `/api/servers/${initial!.id}` : '/api/servers', {
        method: editing ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(String(res.status));
      onSaved();
    } catch {
      setError(t('errSave'));
      setSaving(false);
    }
  };

  const label: React.CSSProperties = { fontSize: 12, fontWeight: 650, color: 'var(--text-2)', marginBottom: 6, display: 'block', letterSpacing: '-0.01em' };

  return createPortal(
    <div
      className="srvf-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(4,6,10,.6)', backdropFilter: 'blur(3px)', zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
      }}
    >
      <style>{STYLES}</style>
      <div
        className="srvf-panel"
        style={{
          width: '100%', maxWidth: 470, background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 18, boxShadow: '0 30px 80px -24px rgba(0,0,0,.7), inset 0 1px 0 var(--hover)',
          maxHeight: '92vh', overflow: 'auto',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '16px 18px', borderBottom: '1px solid var(--border)' }}>
          <span style={{ display: 'inline-flex', width: 32, height: 32, borderRadius: 9, alignItems: 'center', justifyContent: 'center', background: 'color-mix(in oklab, var(--accent) 14%, transparent)', color: 'var(--accent)' }}>
            <ServerIcon size={17} />
          </span>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 640, flex: 1, letterSpacing: '-0.01em' }}>{editing ? t('editServer') : t('newServer')}</h3>
          <button onClick={onClose} className="srvf-save" style={{ display: 'inline-flex', padding: 7, borderRadius: 8, border: '1px solid transparent', background: 'transparent', color: 'var(--muted)', cursor: 'pointer' }} aria-label={tc('cancel')}><X size={18} /></button>
        </div>

        <div style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 15 }}>
          <div>
            <label style={label}>{t('name')}</label>
            <input className="srvf-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Bastion · Kyiv DC" autoFocus />
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <div style={{ flex: 2 }}>
              <label style={label}>{t('host')}</label>
              <input className="srvf-input" value={host} onChange={(e) => setHost(e.target.value)} placeholder="10.10.4.21" style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)' }} />
            </div>
            <div style={{ width: 96 }}>
              <label style={label}>{t('port')}</label>
              <input className="srvf-input" value={port} onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ''))} inputMode="numeric" style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)' }} />
            </div>
          </div>
          <div>
            <label style={label}>{t('username')}</label>
            <input className="srvf-input" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="Administrator" autoComplete="off" />
          </div>
          <div>
            <label style={label}>{t('password')}</label>
            <input
              className="srvf-input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={editing && initial?.hasSecret ? t('passwordKeep') : '••••••••'}
              autoComplete="new-password"
            />
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6, lineHeight: 1.4 }}>{t('passwordHint')}</div>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <div style={{ flex: 1 }}>
              <label style={label}>{t('domain')}</label>
              <input className="srvf-input" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="WORKGROUP" autoComplete="off" />
            </div>
            <div style={{ flex: 1 }}>
              <label style={label}>{t('department')}</label>
              <Select value={departmentId} onChange={setDepartmentId} options={deptOptions} />
            </div>
          </div>

          {error && (
            <div style={{ fontSize: 13, color: 'var(--danger-fg)', background: 'color-mix(in oklab, var(--danger-fg) 10%, transparent)', border: '1px solid color-mix(in oklab, var(--danger-fg) 30%, transparent)', borderRadius: 9, padding: '8px 11px' }}>
              {error}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '14px 18px', borderTop: '1px solid var(--border)' }}>
          <button onClick={onClose} className="btn srvf-save" disabled={saving}>{tc('cancel')}</button>
          <button onClick={save} className="btn btn-primary srvf-save" disabled={saving} style={{ minWidth: 108, justifyContent: 'center', fontWeight: 640 }}>
            {saving ? <Loader2 size={16} className="spin" /> : tc('save')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
