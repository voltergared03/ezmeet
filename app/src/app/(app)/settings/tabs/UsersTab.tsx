'use client';

import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import {
  Languages, Check, Search, Plus, Mail, Key, Loader2, Trash2, X, Copy, Pencil,
} from 'lucide-react';
import { Avatar } from '@/components/ui/avatar';
import { Select } from '@/components/ui/select';
import { useSession } from 'next-auth/react';
import { FieldWrapper } from '../components/shared';
import { getUserStatus } from '../lib/user-status';

interface UserRecord {
  id: string; name: string; email: string; image?: string | null;
  role: 'admin' | 'member' | 'viewer'; lastLogin?: string | null; createdAt?: string;
  hasPassword?: boolean;
  spokenLanguage?: string | null;
  spokenLanguageLocked?: boolean;
  clickupListId?: string | null;
}

interface ListOpt { listId: string; label: string }

export function UsersTab() {
  const t = useTranslations();
  const { data: session } = useSession();
  const [search, setSearch] = useState('');
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [lists, setLists] = useState<ListOpt[]>([]);
  const [clickupOn, setClickupOn] = useState(false);
  const [editNameId, setEditNameId] = useState<string | null>(null);
  const [editNameVal, setEditNameVal] = useState('');
  const saveName = async (u: UserRecord) => {
    const n = editNameVal.trim();
    if (!n || n === u.name) { setEditNameId(null); return; }
    const prev = u.name;
    setUsers((us) => us.map((x) => (x.id === u.id ? { ...x, name: n } : x)));
    setEditNameId(null);
    try {
      const res = await fetch(`/api/users/${u.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: n }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setUsers((us) => us.map((x) => (x.id === u.id ? { ...x, name: prev } : x)));
        alert(err.error || t('settings.changeRoleFailed'));
      }
    } catch {
      setUsers((us) => us.map((x) => (x.id === u.id ? { ...x, name: prev } : x)));
      alert(t('settings.networkError'));
    }
  };
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('member');
  const [invitePassword, setInvitePassword] = useState('');
  const [inviting, setInviting] = useState(false);
  const [inviteMsg, setInviteMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // Admin password reset for an existing user.
  const [resetUser, setResetUser] = useState<UserRecord | null>(null);
  const [resetting, setResetting] = useState(false);
  const [resetResult, setResetResult] = useState<{ password: string; emailed: boolean } | null>(null);
  const [resetErr, setResetErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const openReset = (u: UserRecord) => {
    setResetUser(u); setResetResult(null); setResetErr(null); setCopied(false);
  };
  const doReset = async () => {
    if (!resetUser) return;
    setResetting(true); setResetErr(null);
    try {
      const res = await fetch(`/api/users/${resetUser.id}/password`, { method: 'POST' });
      const d = await res.json().catch(() => ({}));
      if (res.ok && d.password) {
        setResetResult({ password: d.password, emailed: !!d.emailed });
        setUsers((us) => us.map((x) => (x.id === resetUser.id ? { ...x, hasPassword: true } : x)));
      } else {
        setResetErr(d.error || t('settings.resetPasswordFailed'));
      }
    } catch { setResetErr(t('settings.networkError')); }
    finally { setResetting(false); }
  };

  const sendInvite = async () => {
    if (!inviteEmail.trim()) return;
    const withPassword = invitePassword.trim().length > 0;
    if (withPassword && invitePassword.length < 8) {
      setInviteMsg({ ok: false, text: t('settings.passwordMin8') });
      return;
    }
    setInviting(true); setInviteMsg(null);
    try {
      // With a temp password → create a credentials user (POST /api/users).
      // Without → send the Google-SSO invite as before.
      const res = withPassword
        ? await fetch('/api/users', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole, password: invitePassword }),
          })
        : await fetch('/api/users/invite', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole }),
          });
      const d = await res.json().catch(() => ({}));
      if (res.ok && d.user) {
        const created = withPassword ? { ...d.user, hasPassword: true } : d.user;
        setUsers((us) => {
          const exists = us.some((x) => x.id === created.id);
          return exists ? us.map((x) => (x.id === created.id ? { ...x, ...created } : x)) : [...us, created];
        });
        setInviteMsg({
          ok: true,
          text: withPassword
            ? (d.emailed ? t('settings.inviteCreatedEmailed') : t('settings.inviteCreatedManual'))
            : (d.emailSent ? t('settings.inviteSent') : t('settings.inviteAddedNoEmail')),
        });
        setInviteEmail(''); setInvitePassword('');
        setTimeout(() => { setInviteOpen(false); setInviteMsg(null); }, 1800);
      } else {
        setInviteMsg({ ok: false, text: d.error || t('settings.error') });
      }
    } catch { setInviteMsg({ ok: false, text: t('settings.networkError') }); }
    finally { setInviting(false); }
  };

  useEffect(() => {
    let cancelled = false;
    fetch('/api/users')
      .then((r) => (r.ok ? r.json() : []))
      .then((data: UserRecord[]) => { if (!cancelled) setUsers(data); })
      .catch(() => {
        if (!cancelled && session?.user) {
          setUsers([{
            id: session.user.id ?? '1',
            name: session.user.name ?? t('settings.you'),
            email: session.user.email ?? '',
            image: session.user.image,
            role: 'admin', lastLogin: new Date().toISOString(),
          }]);
        }
      });
    return () => { cancelled = true; };
  }, [session]);

  // ClickUp lists for the per-user destination picker: one fetch for the tab (it walks
  // Spaces → Folders → Lists upstream), and only when the integration is actually on.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const s = await fetch('/api/settings/clickup').then((r) => (r.ok ? r.json() : null));
        if (!alive || !s?.enabled || !s?.tokenSet) return;
        setClickupOn(true);
        const d = await fetch('/api/settings/clickup/lists').then((r) => (r.ok ? r.json() : null));
        if (alive && Array.isArray(d?.lists)) setLists(d.lists);
      } catch { /* the column just stays hidden */ }
    })();
    return () => { alive = false; };
  }, []);

  // Self-registration requests awaiting approval.
  const [requests, setRequests] = useState<{ id: string; email: string; name: string | null; createdAt: string; expiresAt: string }[]>([]);
  const [reqBusy, setReqBusy] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/users/requests')
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => { if (Array.isArray(d)) setRequests(d); })
      .catch(() => {});
  }, []);

  const decideRequest = async (id: string, action: 'approve' | 'deny') => {
    setReqBusy(id);
    try {
      const res = await fetch('/api/users/requests', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, action }),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok) {
        setRequests((rs) => rs.filter((r) => r.id !== id));
        if (action === 'approve' && d.user) {
          const created = { ...d.user, hasPassword: true };
          setUsers((us) => (us.some((x) => x.id === created.id) ? us : [...us, created]));
        }
      }
    } catch { /* ignore */ }
    finally { setReqBusy(null); }
  };

  const filtered = users.filter(
    (u) => u.name.toLowerCase().includes(search.toLowerCase()) || u.email.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div style={{ maxWidth: 1000, margin: '0 auto' }}>
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <div className="tasks-search" style={{ position: 'relative', flex: 1 }}>
          <Search size={14} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
          <input className="field" placeholder={t('settings.searchUser')} value={search} onChange={(e) => setSearch(e.target.value)} style={{ paddingLeft: 34, height: 36 }} />
        </div>
        <div className="muted" style={{ fontSize: 12.5 }}>{t('settings.countOf', { shown: filtered.length, total: users.length })}</div>
        <button className="btn btn-primary" onClick={() => { setInviteOpen(true); setInviteMsg(null); }}><Plus size={14} /> {t('settings.add')}</button>
      </div>

      {requests.length > 0 && (
        <div className="card" style={{ padding: '16px 18px', marginBottom: 16, borderColor: 'color-mix(in oklab, var(--amber) 30%, var(--border))' }}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
            {t('settings.registrationRequests')}
            <span className="chip" style={{ background: 'color-mix(in oklab, var(--amber) 18%, transparent)', color: '#fde68a' }}>{requests.length}</span>
          </div>
          <div style={{ display: 'grid', gap: 8 }}>
            {requests.map((r) => {
              const daysLeft = Math.max(0, Math.ceil((new Date(r.expiresAt).getTime() - Date.now()) / 86400000));
              return (
                <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 12px', background: 'var(--surface-2)', borderRadius: 10, flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: 160 }}>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{r.name || r.email.split('@')[0]}</div>
                    <div className="mono" style={{ fontSize: 11.5, color: 'var(--muted)' }}>{r.email}</div>
                  </div>
                  <span style={{ fontSize: 11, color: 'var(--muted)' }}>{t('settings.daysLeft', { count: daysLeft })}</span>
                  <button className="btn btn-sm" disabled={reqBusy === r.id} onClick={() => decideRequest(r.id, 'deny')} style={{ color: 'var(--red)' }}>{t('settings.deny')}</button>
                  <button className="btn btn-primary btn-sm" disabled={reqBusy === r.id} onClick={() => decideRequest(r.id, 'approve')}>
                    {reqBusy === r.id ? <Loader2 size={13} className="spin" /> : t('settings.approve')}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
        <div className={`admin-table-header${clickupOn ? ' has-clickup' : ''}`} style={{ padding: '11px 16px', borderBottom: '1px solid var(--border)', fontSize: 11, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 600 }}>
          <div>{t('settings.colUser')}</div><div>{t('settings.colEmail')}</div><div>{t('settings.colRole')}</div><div>{t('settings.colLanguage')}</div>{clickupOn && <div>{t('settings.colClickup')}</div>}<div>{t('settings.colStatus')}</div><div />
        </div>
        {filtered.map((u) => {
          const isMe = session?.user?.email === u.email;
          const st = getUserStatus(u.lastLogin);
          return (
            <div key={u.id} className={`admin-table-row user-row${clickupOn ? ' has-clickup' : ''}`} style={{ display: 'grid', padding: '14px 16px', borderBottom: '1px solid var(--border)', alignItems: 'center', fontSize: 13 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
                <span style={{ position: 'relative', flexShrink: 0, display: 'inline-flex' }}>
                  <Avatar name={u.name} image={u.image} size="md" />
                  <span className={st.kind === 'online' ? 'av-presence av-online' : 'av-presence'} style={{ background: st.color }} />
                </span>
                <div style={{ minWidth: 0 }}>
                  {editNameId === u.id ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <input
                        className="field"
                        value={editNameVal}
                        autoFocus
                        onChange={(e) => setEditNameVal(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') saveName(u);
                          if (e.key === 'Escape') setEditNameId(null);
                        }}
                        style={{ height: 30, fontSize: 13, padding: '4px 8px', maxWidth: 180 }}
                      />
                      <button className="btn btn-ghost btn-icon" style={{ width: 26, height: 26 }} title={t('common.save')} onClick={() => saveName(u)}>
                        <Check size={14} />
                      </button>
                      <button className="btn btn-ghost btn-icon" style={{ width: 26, height: 26 }} title={t('common.cancel')} onClick={() => setEditNameId(null)}>
                        <X size={14} />
                      </button>
                    </div>
                  ) : (
                    <div style={{ fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.name}</span>
                      {isMe && <span className="chip">{t('settings.itsYou')}</span>}
                      <button
                        className="btn btn-ghost btn-icon"
                        style={{ width: 28, height: 28, flexShrink: 0, opacity: 0.85 }}
                        title={t('settings.editName')}
                        onClick={() => { setEditNameId(u.id); setEditNameVal(u.name); }}
                      >
                        <Pencil size={15} />
                      </button>
                    </div>
                  )}
                </div>
              </div>
              <div className="mono" style={{ fontSize: 12, color: 'var(--text-2)' }}>{u.email}</div>
              <div style={{ minWidth: 0 }}>
                <Select
                  value={u.role}
                  options={[
                    { value: 'admin', label: t('settings.role_admin') },
                    { value: 'member', label: t('settings.role_member') },
                    { value: 'viewer', label: t('settings.role_viewer') },
                  ]}
                  style={{ height: 32, fontSize: 12.5, width: '100%' }}
                  onChange={async (newRole) => {
                    const prev = u.role;
                    setUsers((us) => us.map((x) => x.id === u.id ? { ...x, role: newRole as UserRecord['role'] } : x));
                    try {
                      const res = await fetch(`/api/users/${u.id}`, {
                        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ role: newRole }),
                      });
                      if (!res.ok) {
                        const err = await res.json().catch(() => ({}));
                        alert(err.error || t('settings.changeRoleFailed'));
                        setUsers((us) => us.map((x) => x.id === u.id ? { ...x, role: prev } : x));
                      }
                    } catch {
                      alert(t('settings.networkError'));
                      setUsers((us) => us.map((x) => x.id === u.id ? { ...x, role: prev } : x));
                    }
                  }}
                />
              </div>
              <div style={{ minWidth: 0 }}>
                <Select
                  value={u.spokenLanguageLocked ? (u.spokenLanguage || '') : ''}
                  icon={<Languages size={13} style={{ color: 'var(--muted)' }} />}
                  options={[
                    { value: '', label: t('settings.spokenLanguageAuto') },
                    { value: 'uk', label: 'Українська' },
                    { value: 'en', label: 'English' },
                    { value: 'ru', label: 'Русский' },
                  ]}
                  style={{ height: 32, fontSize: 12.5, width: '100%' }}
                  onChange={async (v) => {
                    const prevLang = u.spokenLanguage; const prevLock = u.spokenLanguageLocked;
                    setUsers((us) => us.map((x) => x.id === u.id ? { ...x, spokenLanguage: v || x.spokenLanguage, spokenLanguageLocked: !!v } : x));
                    try {
                      const res = await fetch(`/api/users/${u.id}`, {
                        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(v ? { spokenLanguage: v, spokenLanguageLocked: true } : { spokenLanguageLocked: false }),
                      });
                      if (!res.ok) {
                        setUsers((us) => us.map((x) => x.id === u.id ? { ...x, spokenLanguage: prevLang, spokenLanguageLocked: prevLock } : x));
                      }
                    } catch {
                      setUsers((us) => us.map((x) => x.id === u.id ? { ...x, spokenLanguage: prevLang, spokenLanguageLocked: prevLock } : x));
                    }
                  }}
                />
              </div>
              {clickupOn && (
                <div style={{ minWidth: 0 }} title={t('settings.clickupUserListHint')}>
                  <Select
                    value={u.clickupListId ?? ''}
                    options={[
                      { value: '', label: t('settings.clickupUserNoList') },
                      ...lists.map((l) => ({ value: l.listId, label: l.label })),
                    ]}
                    style={{ height: 32, fontSize: 12.5, width: '100%' }}
                    onChange={async (v) => {
                      const prev = u.clickupListId ?? null;
                      const next = v || null;
                      setUsers((us) => us.map((x) => x.id === u.id ? { ...x, clickupListId: next } : x));
                      try {
                        const res = await fetch(`/api/users/${u.id}`, {
                          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ clickupListId: next }),
                        });
                        if (!res.ok) setUsers((us) => us.map((x) => x.id === u.id ? { ...x, clickupListId: prev } : x));
                      } catch {
                        setUsers((us) => us.map((x) => x.id === u.id ? { ...x, clickupListId: prev } : x));
                      }
                    }}
                  />
                </div>
              )}
              <div>
                {(() => {
                  const label =
                    st.kind === 'never' ? t('settings.statusNeverLoggedIn')
                    : st.kind === 'online' ? t('settings.statusOnline')
                    : st.kind === 'minutes' ? t('settings.statusMinutesAgo', { count: st.value })
                    : st.kind === 'hours' ? t('settings.statusHoursAgo', { count: st.value })
                    : t('settings.statusDaysAgo', { count: st.value });
                  const online = st.kind === 'online';
                  return (
                    <span style={{
                      display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11.5, fontWeight: 500,
                      padding: '3px 9px', borderRadius: 999, whiteSpace: 'nowrap',
                      background: online ? 'color-mix(in oklab, var(--green) 13%, transparent)' : 'var(--surface-2)',
                      border: `1px solid ${online ? 'color-mix(in oklab, var(--green) 32%, transparent)' : 'var(--border)'}`,
                      color: online ? 'var(--green)' : 'var(--text-2)',
                    }}>
                      {online && <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--green)', flexShrink: 0 }} />}
                      {label}
                    </span>
                  );
                })()}
              </div>
              <div className="row-actions" style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', alignItems: 'center' }}>
                {!isMe && u.hasPassword && (
                  <button
                    className="btn btn-ghost btn-icon"
                    title={t('settings.resetPassword')}
                    onClick={() => openReset(u)}
                    style={{ width: 30, height: 30 }}
                  >
                    <Key size={14} />
                  </button>
                )}
                {!isMe && (
                  <button
                    className="btn btn-ghost btn-icon"
                    title={t('settings.deleteUser')}
                    disabled={deletingId === u.id}
                    onClick={async () => {
                      if (!window.confirm(t('settings.deleteUserConfirm', { name: u.name, email: u.email }))) return;
                      setDeletingId(u.id);
                      try {
                        const res = await fetch(`/api/users/${u.id}`, { method: 'DELETE' });
                        if (res.ok) {
                          setUsers((us) => us.filter((x) => x.id !== u.id));
                        } else {
                          const err = await res.json().catch(() => ({}));
                          alert(err.error || t('settings.deleteUserFailed'));
                        }
                      } catch {
                        alert(t('settings.networkError'));
                      } finally {
                        setDeletingId(null);
                      }
                    }}
                    style={{ width: 30, height: 30, color: 'var(--red)' }}
                  >
                    {deletingId === u.id ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Trash2 size={14} />}
                  </button>
                )}
              </div>
            </div>
          );
        })}
        {filtered.length === 0 && (
          <div style={{ padding: '44px 24px', textAlign: 'center', color: 'var(--muted)' }}>
            <Search size={26} style={{ opacity: 0.4, marginBottom: 10 }} />
            <div style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--text-2)' }}>{t('settings.noUsersFound')}</div>
          </div>
        )}
        </div>
      </div>

      {inviteOpen && (
        <div onClick={() => setInviteOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, animation: 'fadeIn .15s' }}>
          <div onClick={(e) => e.stopPropagation()} className="card" style={{ width: 420, maxWidth: '92vw', padding: '22px 24px' }}>
            <div style={{ fontWeight: 700, fontSize: 17, marginBottom: 4 }}>{t('settings.addUser')}</div>
            <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 18 }}>{t('settings.addUserDesc')}</div>
            <FieldWrapper label={t('settings.colEmail')}>
              <input className="field" type="email" value={inviteEmail} placeholder="user@example.com" autoFocus
                onChange={(e) => setInviteEmail(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') sendInvite(); }} />
            </FieldWrapper>
            <div style={{ marginTop: 14 }}>
              <FieldWrapper label={t('settings.colRole')}>
                <Select value={inviteRole} onChange={setInviteRole} options={[
                  { value: 'member', label: t('settings.role_member') },
                  { value: 'admin', label: t('settings.role_admin') },
                  { value: 'viewer', label: t('settings.role_viewer') },
                ]} />
              </FieldWrapper>
            </div>
            <div style={{ marginTop: 14 }}>
              <FieldWrapper label={t('settings.tempPasswordOptional')}>
                <input className="field" type="text" value={invitePassword} placeholder={t('settings.tempPasswordPlaceholder')}
                  onChange={(e) => setInvitePassword(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') sendInvite(); }} />
              </FieldWrapper>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6, lineHeight: 1.45 }}>
                {t('settings.tempPasswordHint')}
              </div>
            </div>
            {inviteMsg && <div style={{ marginTop: 12, fontSize: 12.5, color: inviteMsg.ok ? 'var(--green)' : '#f87171' }}>{inviteMsg.text}</div>}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
              <button className="btn btn-sm" onClick={() => setInviteOpen(false)}>{t('common.cancel')}</button>
              <button className="btn btn-primary btn-sm" onClick={sendInvite} disabled={inviting || !inviteEmail.trim()}>
                {inviting ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Mail size={13} />} {t('settings.send')}
              </button>
            </div>
          </div>
        </div>
      )}

      {resetUser && (
        <div onClick={() => setResetUser(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, animation: 'fadeIn .15s' }}>
          <div onClick={(e) => e.stopPropagation()} className="card" style={{ width: 420, maxWidth: '92vw', padding: '22px 24px' }}>
            <div style={{ fontWeight: 700, fontSize: 17, marginBottom: 4 }}>{t('settings.resetPassword')}</div>
            <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 18 }}>{resetUser.name} · {resetUser.email}</div>
            {!resetResult ? (
              <>
                <div style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.5 }}>
                  {t('settings.resetPasswordDesc')}
                </div>
                {resetErr && <div style={{ marginTop: 12, fontSize: 12.5, color: '#f87171' }}>{resetErr}</div>}
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 20 }}>
                  <button className="btn btn-sm" onClick={() => setResetUser(null)}>{t('common.cancel')}</button>
                  <button className="btn btn-primary btn-sm" onClick={doReset} disabled={resetting}>
                    {resetting ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Key size={13} />} {t('settings.generate')}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 8 }}>{t('settings.newTempPassword')}</div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <code className="mono" style={{ flex: 1, background: 'var(--surface-2)', borderRadius: 10, padding: '12px 14px', fontSize: 15, fontWeight: 600, letterSpacing: '.04em', userSelect: 'all', wordBreak: 'break-all' }}>{resetResult.password}</code>
                  <button className="btn btn-sm" title={t('settings.copy')} onClick={() => { try { navigator.clipboard?.writeText(resetResult.password); } catch {} setCopied(true); setTimeout(() => setCopied(false), 1500); }} style={{ flexShrink: 0 }}>
                    {copied ? <Check size={14} /> : <Copy size={14} />}
                  </button>
                </div>
                <div style={{ marginTop: 12, fontSize: 12.5, color: resetResult.emailed ? 'var(--green)' : 'var(--muted)' }}>
                  {resetResult.emailed ? t('settings.resetPasswordEmailed') : t('settings.resetPasswordManual')}
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
                  <button className="btn btn-primary btn-sm" onClick={() => setResetUser(null)}>{t('settings.done')}</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
