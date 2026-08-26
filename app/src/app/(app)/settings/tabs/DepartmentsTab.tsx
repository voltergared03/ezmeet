'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import {
  Plus, Pencil, Check, X, Trash2, Loader2, Crown, Building2, ChevronDown, ChevronRight, Users as UsersIcon, ListChecks, AlertTriangle,
} from 'lucide-react';
import { Avatar } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { Select } from '@/components/ui/select';

interface DeptMember { userId: string; isLead: boolean; name: string | null; email: string | null; image?: string | null }
interface Dept { id: string; name: string; color: string | null; teableBaseId: string | null; clickupListId?: string | null; taskCount: number; meetingCount: number; members: DeptMember[] }
interface UserOpt { id: string; name: string; email: string; image?: string | null }
interface ListOpt { listId: string; label: string }

const COLORS = ['var(--accent)', '#8b5cf6', '#06b6d4', 'var(--success)', 'var(--warn)', 'var(--danger)', 'var(--pink)', '#64748b'];

export function DepartmentsTab() {
  const t = useTranslations();
  const [depts, setDepts] = useState<Dept[]>([]);
  const [users, setUsers] = useState<UserOpt[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState(COLORS[0]);
  const [busy, setBusy] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editVal, setEditVal] = useState('');
  const [lists, setLists] = useState<ListOpt[]>([]);
  const [clickupOn, setClickupOn] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/departments');
      const d = r.ok ? await r.json() : [];
      setDepts(Array.isArray(d) ? d : []);
    } catch { /* ignore */ } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    fetch('/api/users').then((r) => (r.ok ? r.json() : [])).then((u) => setUsers(Array.isArray(u) ? u : [])).catch(() => {});
  }, []);
  // The ClickUp lists for the picker: one fetch for the whole tab, never per row — it
  // walks Spaces → Folders → Lists upstream. Only when the integration is actually on.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const s = await fetch('/api/settings/clickup').then((r) => (r.ok ? r.json() : null));
        if (!alive || !s?.enabled || !s?.tokenSet) return;
        setClickupOn(true);
        const d = await fetch('/api/settings/clickup/lists').then((r) => (r.ok ? r.json() : null));
        if (alive && Array.isArray(d?.lists)) setLists(d.lists);
      } catch { /* the picker just stays hidden */ }
    })();
    return () => { alive = false; };
  }, []);

  const setList = async (d: Dept, listId: string) => {
    const prev = d.clickupListId ?? null;
    const next = listId || null;
    setDepts((ds) => ds.map((x) => (x.id === d.id ? { ...x, clickupListId: next } : x)));
    try {
      const res = await fetch(`/api/departments/${d.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clickupListId: next }),
      });
      if (!res.ok) setDepts((ds) => ds.map((x) => (x.id === d.id ? { ...x, clickupListId: prev } : x)));
    } catch {
      setDepts((ds) => ds.map((x) => (x.id === d.id ? { ...x, clickupListId: prev } : x)));
    }
  };

  const createDept = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    try {
      const r = await fetch('/api/departments', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, color: newColor }),
      });
      if (r.ok) { setNewName(''); setNewColor(COLORS[0]); setCreating(false); await load(); }
    } finally { setBusy(false); }
  };

  const renameDept = async (d: Dept) => {
    const name = editVal.trim();
    setEditId(null);
    if (!name || name === d.name) return;
    setDepts((ds) => ds.map((x) => (x.id === d.id ? { ...x, name } : x)));
    await fetch(`/api/departments/${d.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
    }).catch(() => {});
  };

  const setColor = async (d: Dept, color: string) => {
    setDepts((ds) => ds.map((x) => (x.id === d.id ? { ...x, color } : x)));
    await fetch(`/api/departments/${d.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ color }),
    }).catch(() => {});
  };

  const deleteDept = async (d: Dept) => {
    if (!window.confirm(t('departments.deleteConfirm', { name: d.name }))) return;
    setDepts((ds) => ds.filter((x) => x.id !== d.id));
    await fetch(`/api/departments/${d.id}`, { method: 'DELETE' }).catch(() => {});
  };

  const addMember = async (d: Dept, userId: string) => {
    if (!userId) return;
    await fetch(`/api/departments/${d.id}/members`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId }),
    }).catch(() => {});
    await load();
  };

  const removeMember = async (d: Dept, userId: string) => {
    setDepts((ds) => ds.map((x) => (x.id === d.id ? { ...x, members: x.members.filter((m) => m.userId !== userId) } : x)));
    await fetch(`/api/departments/${d.id}/members?userId=${encodeURIComponent(userId)}`, { method: 'DELETE' }).catch(() => {});
  };

  const toggleLead = async (d: Dept, m: DeptMember) => {
    setDepts((ds) => ds.map((x) => (x.id === d.id ? { ...x, members: x.members.map((mm) => (mm.userId === m.userId ? { ...mm, isLead: !mm.isLead } : mm)) } : x)));
    await fetch(`/api/departments/${d.id}/members`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: m.userId, isLead: !m.isLead }),
    }).catch(() => {});
  };

  const countChip = (icon: React.ReactNode, n: number, label: string) => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--text-2)' }}>
      {icon}<b style={{ fontWeight: 600 }}>{n}</b> <span style={{ color: 'var(--muted)' }}>{label}</span>
    </span>
  );

  return (
    <div style={{ maxWidth: 880, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>{t('settings.tabDepartments')}</div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>{t('departments.subtitle')}</div>
        </div>
        <button className="btn btn-primary" onClick={() => { setCreating((c) => !c); setNewName(''); }}>
          <Plus size={14} /> {t('departments.add')}
        </button>
      </div>

      {creating && (
        <div className="card" style={{ padding: 16, marginBottom: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <input
            className="field" autoFocus value={newName} placeholder={t('departments.namePlaceholder')}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') createDept(); if (e.key === 'Escape') setCreating(false); }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>{t('departments.color')}</span>
            {COLORS.map((c) => (
              <button key={c} onClick={() => setNewColor(c)} aria-label={c} style={{
                width: 22, height: 22, borderRadius: '50%', background: c, cursor: 'pointer',
                border: newColor === c ? '2px solid var(--text)' : '2px solid transparent',
              }} />
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn btn-sm" onClick={() => setCreating(false)}>{t('common.cancel')}</button>
            <button className="btn btn-primary btn-sm" onClick={createDept} disabled={busy || !newName.trim()}>
              {busy ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Check size={13} />} {t('departments.create')}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        // Departments arrive as a list of cards, so the wait shows that shape rather
        // than a spinner: nothing jumps when the data lands, and the page already
        // reads as "a list, loading" instead of "something, somewhere".
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }} role="status" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="card" style={{ padding: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
              <Skeleton w={30} h={30} radius={9} style={{ flexShrink: 0 }} />
              <span style={{ display: 'flex', flexDirection: 'column', gap: 7, flex: 1 }}>
                <Skeleton w="34%" h={13} />
                <Skeleton w="18%" h={10} />
              </span>
            </div>
          ))}
        </div>
      ) : depts.length === 0 ? (
        <div className="card" style={{ padding: '40px 24px', textAlign: 'center' }}>
          <Building2 size={28} style={{ color: 'var(--muted)', opacity: 0.5, marginBottom: 10 }} />
          <div style={{ fontSize: 14, fontWeight: 600 }}>{t('departments.empty')}</div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 4, lineHeight: 1.5 }}>{t('departments.emptyHint')}</div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {depts.map((d) => {
            const isOpen = expanded === d.id;
            const dot = d.color || 'var(--accent)';
            const nonMembers = users.filter((u) => !d.members.some((m) => m.userId === u.id));
            return (
              <div key={d.id} className="card" style={{ padding: 0, overflow: 'hidden' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px' }}>
                  <button className="btn btn-ghost btn-icon" style={{ width: 28, height: 28, flexShrink: 0 }}
                    onClick={() => setExpanded(isOpen ? null : d.id)} aria-label="toggle">
                    {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  </button>
                  <span style={{ width: 12, height: 12, borderRadius: 4, background: dot, flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {editId === d.id ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <input className="field" autoFocus value={editVal} onChange={(e) => setEditVal(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') renameDept(d); if (e.key === 'Escape') setEditId(null); }}
                          style={{ height: 30, fontSize: 13.5, padding: '4px 8px', maxWidth: 240 }} />
                        <button className="btn btn-ghost btn-icon" style={{ width: 26, height: 26 }} title={t('common.save')} onClick={() => renameDept(d)}><Check size={14} /></button>
                        <button className="btn btn-ghost btn-icon" style={{ width: 26, height: 26 }} title={t('common.cancel')} onClick={() => setEditId(null)}><X size={14} /></button>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontWeight: 600, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name}</span>
                        <button className="btn btn-ghost btn-icon" style={{ width: 26, height: 26, flexShrink: 0, opacity: 0.8 }} title={t('common.edit')}
                          onClick={() => { setEditId(d.id); setEditVal(d.name); }}><Pencil size={13} /></button>
                      </div>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexShrink: 0 }}>
                    {clickupOn && !d.clickupListId && (
                      <span className="chip" title={t('departments.clickupUnmappedHint')}
                        style={{ background: 'var(--warn-bg)', color: 'var(--warn-fg)' }}>
                        <AlertTriangle size={10} /> {t('departments.clickupUnmapped')}
                      </span>
                    )}
                    {countChip(<UsersIcon size={13} style={{ color: 'var(--muted)' }} />, d.members.length, t('departments.members'))}
                    {countChip(<ListChecks size={13} style={{ color: 'var(--muted)' }} />, d.taskCount, t('departments.tasks'))}
                    <button className="btn btn-ghost btn-icon" style={{ width: 30, height: 30, color: 'var(--red)' }} title={t('common.delete')} onClick={() => deleteDept(d)}>
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>

                {isOpen && (
                  <div style={{ borderTop: '1px solid var(--border)', padding: '14px 16px', background: 'var(--surface-2)' }}>
                    {/* color */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
                      <span style={{ fontSize: 12, color: 'var(--muted)' }}>{t('departments.color')}</span>
                      {COLORS.map((c) => (
                        <button key={c} onClick={() => setColor(d, c)} aria-label={c} style={{
                          width: 20, height: 20, borderRadius: '50%', background: c, cursor: 'pointer',
                          border: (d.color || COLORS[0]) === c ? '2px solid var(--text)' : '2px solid transparent',
                        }} />
                      ))}
                    </div>

                    {/* ClickUp destination list */}
                    {clickupOn && (
                      <div style={{ marginBottom: 14 }}>
                        <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 600, marginBottom: 8 }}>
                          {t('departments.clickupList')}
                        </div>
                        <div style={{ maxWidth: 380 }}>
                          <Select
                            value={d.clickupListId ?? ''}
                            placeholder={t('departments.clickupPick')}
                            options={[
                              { value: '', label: t('departments.clickupNoList') },
                              ...lists.map((l) => ({ value: l.listId, label: l.label })),
                            ]}
                            onChange={(v) => setList(d, v)}
                            style={{ height: 34, fontSize: 13 }}
                          />
                        </div>
                        <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6, lineHeight: 1.5 }}>
                          {t('departments.clickupListHint')}
                        </div>
                      </div>
                    )}

                    {/* members */}
                    <div style={{ fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 600, marginBottom: 8 }}>
                      {t('departments.members')}
                    </div>
                    {d.members.length === 0 ? (
                      <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 10 }}>{t('departments.noMembers')}</div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
                        {d.members.map((m) => (
                          <div key={m.userId} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 8px', background: 'var(--surface)', borderRadius: 10 }}>
                            <Avatar name={m.name || m.email || '?'} image={m.image} size="sm" />
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 13, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6 }}>
                                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.name || m.email}</span>
                                {m.isLead && <span className="chip" style={{ background: 'var(--warn-bg)', color: 'var(--warn-fg)' }}><Crown size={10} /> {t('departments.lead')}</span>}
                              </div>
                            </div>
                            <button className="btn btn-ghost btn-icon" style={{ width: 28, height: 28, color: m.isLead ? 'var(--amber)' : 'var(--muted)' }}
                              title={m.isLead ? t('departments.removeLead') : t('departments.makeLead')} onClick={() => toggleLead(d, m)}>
                              <Crown size={14} />
                            </button>
                            <button className="btn btn-ghost btn-icon" style={{ width: 28, height: 28, color: 'var(--red)' }}
                              title={t('departments.removeMember')} onClick={() => removeMember(d, m.userId)}>
                              <X size={14} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}

                    {nonMembers.length > 0 && (
                      <div style={{ maxWidth: 320 }}>
                        <Select
                          value=""
                          placeholder={t('departments.addMember')}
                          options={nonMembers.map((u) => ({ value: u.id, label: u.name || u.email }))}
                          onChange={(uid) => addMember(d, uid)}
                          style={{ height: 34, fontSize: 13 }}
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
