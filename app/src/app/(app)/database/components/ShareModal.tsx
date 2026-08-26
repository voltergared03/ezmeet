'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Globe, Lock, X, EyeOff, UserPlus, Check, ArrowRightLeft } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { Avatar } from '@/components/ui/avatar';
import { Spinner } from '@/components/ui/spinner';
import { Select } from '@/components/ui/select';
import { TransferModal } from './TransferModal';
import type { OrgMember, BaseMemberT, BaseFieldRef, BaseRole } from '../lib/types';

const JSON_HEADERS = { 'Content-Type': 'application/json' };
type Vis = 'org' | 'restricted';

export function ShareModal({
  open,
  baseId,
  onClose,
  onVisibility,
  onOwnerChanged,
}: {
  open: boolean;
  baseId: string;
  onClose: () => void;
  onVisibility?: (v: Vis) => void;
  onOwnerChanged?: (ownerId: string) => void;
}) {
  const t = useTranslations('database');
  const [loading, setLoading] = useState(true);
  const [visibility, setVisibility] = useState<Vis>('org');
  const [ownerId, setOwnerId] = useState<string | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [canTransfer, setCanTransfer] = useState(false);
  const [members, setMembers] = useState<BaseMemberT[]>([]);
  const [orgMembers, setOrgMembers] = useState<OrgMember[]>([]);
  const [fields, setFields] = useState<BaseFieldRef[]>([]);
  const [query, setQuery] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [managingCols, setManagingCols] = useState<string | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);

  const load = useCallback(async () => {
    const [m, om] = await Promise.all([
      fetch(`/api/bases/${baseId}/members`).then((r) => (r.ok ? r.json() : null)),
      fetch('/api/org/members').then((r) => (r.ok ? r.json() : [])),
    ]);
    if (m) {
      setVisibility(m.visibility === 'restricted' ? 'restricted' : 'org');
      setOwnerId(m.ownerId ?? null);
      setCanManage(!!m.canManage);
      setCanTransfer(!!m.canTransfer);
      setMembers(m.members ?? []);
      setFields(m.fields ?? []);
    }
    setOrgMembers(om ?? []);
    setLoading(false);
  }, [baseId]);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setErr(null);
    setQuery('');
    setManagingCols(null);
    load();
  }, [open, load]);

  async function transferBase(userId: string): Promise<boolean> {
    const res = await fetch(`/api/bases/${baseId}/transfer`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ userId }) });
    if (!res.ok) return false;
    const d = await res.json().catch(() => ({}));
    const newOwner: string = d.ownerId ?? userId;
    setOwnerId(newOwner);
    onOwnerChanged?.(newOwner);
    await load(); // refresh members + canManage/canTransfer (old owner is now an admin member)
    return true;
  }

  const memberIds = new Set(members.map((m) => m.id));
  const owner = orgMembers.find((u) => u.id === ownerId) ?? null;
  const candidates = orgMembers.filter(
    (u) => u.id !== ownerId && !memberIds.has(u.id) &&
      (!query.trim() || (u.name || '').toLowerCase().includes(query.toLowerCase()) || (u.email || '').toLowerCase().includes(query.toLowerCase())),
  );

  async function setVis(v: Vis) {
    const prev = visibility;
    setVisibility(v);
    onVisibility?.(v);
    const res = await fetch(`/api/bases/${baseId}`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ visibility: v }) });
    if (!res.ok) { setVisibility(prev); onVisibility?.(prev); setErr(t('actionFailed')); }
  }

  async function addMember(body: { userId?: string; email?: string }) {
    setErr(null);
    const res = await fetch(`/api/bases/${baseId}/members`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ ...body, role: 'editor' }) });
    if (res.ok) {
      const m: BaseMemberT = await res.json();
      setMembers((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]));
      setQuery('');
    } else {
      const d = await res.json().catch(() => ({}));
      setErr(d.error === 'not_in_workspace' ? t('notInWorkspace') : t('actionFailed'));
    }
  }

  async function setRole(userId: string, role: BaseRole) {
    const prev = members;
    setMembers((p) => p.map((m) => (m.id === userId ? { ...m, role } : m)));
    const res = await fetch(`/api/bases/${baseId}/members/${userId}`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ role }) });
    if (!res.ok) { setMembers(prev); setErr(t('actionFailed')); }
  }

  async function toggleHidden(userId: string, fieldId: string) {
    const m = members.find((x) => x.id === userId);
    if (!m) return;
    const prev = members;
    const next = m.hiddenFields.includes(fieldId) ? m.hiddenFields.filter((f) => f !== fieldId) : [...m.hiddenFields, fieldId];
    setMembers((p) => p.map((x) => (x.id === userId ? { ...x, hiddenFields: next } : x)));
    const res = await fetch(`/api/bases/${baseId}/members/${userId}`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ hiddenFields: next }) });
    if (!res.ok) { setMembers(prev); setErr(t('actionFailed')); }
  }

  async function removeMember(userId: string) {
    const prev = members;
    setMembers((p) => p.filter((x) => x.id !== userId));
    const res = await fetch(`/api/bases/${baseId}/members/${userId}`, { method: 'DELETE' });
    if (!res.ok) { setMembers(prev); setErr(t('actionFailed')); }
  }

  const roleOptions = [
    { value: 'viewer', label: t('roleViewer') },
    { value: 'editor', label: t('roleEditor') },
    { value: 'admin', label: t('roleAdmin') },
  ];

  return (
    <>
    <Modal open={open} onClose={onClose} title={t('shareBase')} width={520}>
      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 24 }}><Spinner size={20} /></div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
            <VisOption icon={<Globe size={15} />} title={t('accessOrgShort')} sub={t('accessOrg')} active={visibility === 'org'} disabled={!canManage} onClick={() => setVis('org')} />
            <VisOption icon={<Lock size={15} />} title={t('accessRestrictedShort')} sub={t('accessRestricted')} active={visibility === 'restricted'} disabled={!canManage} onClick={() => setVis('restricted')} />
          </div>

          {canManage && (
            <div style={{ marginBottom: 14 }}>
              <input
                className="field"
                value={query}
                onChange={(e) => { setQuery(e.target.value); setErr(null); }}
                onKeyDown={(e) => { if (e.key === 'Enter' && query.includes('@')) addMember({ email: query.trim() }); }}
                placeholder={t('addPeople')}
                style={{ width: '100%' }}
              />
              {err && <div style={{ color: 'var(--red, var(--danger))', fontSize: 12, marginTop: 6 }}>{err}</div>}
              {query.trim() && candidates.length > 0 && (
                <div style={{ marginTop: 6, border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden', maxHeight: 200, overflowY: 'auto' }}>
                  {candidates.slice(0, 8).map((u) => (
                    <button
                      key={u.id}
                      onClick={() => addMember({ userId: u.id })}
                      style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '7px 10px', border: 'none', background: 'transparent', cursor: 'pointer', textAlign: 'left' }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface-2)')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                    >
                      <Avatar name={u.name || u.email || '?'} image={u.image} size="sm" />
                      <span style={{ flex: 1, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.name || u.email}</span>
                      <UserPlus size={14} style={{ color: 'var(--accent)' }} />
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 8 }}>
            {t('peopleWithAccess')}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {owner && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 4px' }}>
                <Avatar name={owner.name || owner.email || '?'} image={owner.image} size="sm" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{owner.name || owner.email}</div>
                </div>
                {canTransfer && (
                  <button
                    onClick={() => setTransferOpen(true)}
                    className="btn btn-ghost"
                    title={t('transferOwnership')}
                    style={{ fontSize: 12, padding: '4px 8px', gap: 5, color: 'var(--text-2)' }}
                  >
                    <ArrowRightLeft size={13} /> {t('transfer')}
                  </button>
                )}
                <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 600 }}>{t('owner')}</span>
              </div>
            )}
            {members.filter((m) => m.id !== ownerId).map((m) => (
              <div key={m.id}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '6px 4px' }}>
                  <Avatar name={m.name || m.email || '?'} image={m.image} size="sm" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.name || m.email}</div>
                  </div>
                  {canManage ? (
                    <>
                      <button
                        onClick={() => setManagingCols(managingCols === m.id ? null : m.id)}
                        className="btn btn-ghost"
                        title={t('hiddenColumnsTitle')}
                        style={{ fontSize: 12, padding: '4px 8px', gap: 5, color: m.hiddenFields.length ? 'var(--accent)' : 'var(--text-2)' }}
                      >
                        <EyeOff size={13} /> {m.hiddenFields.length ? t('columnsHiddenCount', { count: m.hiddenFields.length }) : t('hideColumns')}
                      </button>
                      <Select value={m.role} onChange={(v) => setRole(m.id, v as BaseRole)} options={roleOptions} style={{ width: 132, padding: '6px 8px' }} />
                      <button onClick={() => removeMember(m.id)} className="btn btn-ghost btn-icon" style={{ width: 28, height: 28 }} title={t('remove')}><X size={14} /></button>
                    </>
                  ) : (
                    <span style={{ fontSize: 12, color: 'var(--muted)' }}>{t(`role${m.role[0].toUpperCase()}${m.role.slice(1)}` as never)}</span>
                  )}
                </div>
                {managingCols === m.id && (
                  <div style={{ margin: '2px 0 10px 38px', padding: 10, border: '1px solid var(--border)', borderRadius: 10, background: 'var(--surface-2)' }}>
                    <div style={{ fontSize: 11.5, color: 'var(--muted)', marginBottom: 8 }}>{t('hiddenColumnsTitle')}</div>
                    {fields.length === 0 ? (
                      <div style={{ fontSize: 12, color: 'var(--muted)' }}>—</div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 220, overflowY: 'auto' }}>
                        {fields.map((f) => {
                          const hidden = m.hiddenFields.includes(f.id);
                          return (
                            <button
                              key={f.id}
                              onClick={() => toggleHidden(m.id, f.id)}
                              style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 6px', border: 'none', borderRadius: 6, background: 'transparent', cursor: 'pointer', textAlign: 'left' }}
                              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface-3)')}
                              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                            >
                              <span style={{ width: 16, height: 16, borderRadius: 4, border: `1.5px solid ${hidden ? 'var(--accent)' : 'var(--border-2, var(--border))'}`, background: hidden ? 'var(--accent)' : 'transparent', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                                {hidden && <Check size={11} style={{ color: 'var(--on-accent)' }} />}
                              </span>
                              <span style={{ fontSize: 12.5 }}>{f.name}</span>
                              <span className="mono" style={{ fontSize: 10.5, color: 'var(--muted)' }}>{f.tableName}</span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </Modal>
    <TransferModal
      open={transferOpen}
      title={t('transferBaseTitle')}
      members={orgMembers}
      currentOwnerId={ownerId}
      hint={t('transferBaseHint')}
      onClose={() => setTransferOpen(false)}
      onTransfer={transferBase}
    />
    </>
  );
}

function VisOption({ icon, title, sub, active, disabled, onClick }: { icon: ReactNode; title: string; sub: string; active: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        flex: 1, textAlign: 'left', padding: '10px 12px', borderRadius: 12, cursor: disabled ? 'default' : 'pointer',
        border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
        background: active ? 'color-mix(in oklab, var(--accent) 14%, transparent)' : 'var(--surface-2)',
        opacity: disabled && !active ? 0.55 : 1,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: active ? 'var(--accent)' : 'var(--text-2)', marginBottom: 3 }}>
        {icon}
        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{title}</span>
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>{sub}</div>
    </button>
  );
}
