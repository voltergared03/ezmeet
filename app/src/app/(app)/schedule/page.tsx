'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Select } from '@/components/ui/select';
import { useSession } from 'next-auth/react';
import {
  ChevronLeft, Calendar, Clock, Globe, RefreshCw, Building2,
  Users, Plus, Search, X, Sparkles, Send, AlertCircle,
  CheckCircle, Link2, Copy, Wand2, ListChecks, Loader2, Trash2, GripVertical,
} from 'lucide-react';
import { Avatar } from '@/components/ui/avatar';
import { useIsMobile } from '@/lib/use-is-mobile';

interface WsUser {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
  role: string;
}

export default function SchedulePage() {
  const router = useRouter();
  const t = useTranslations();
  const { data: session } = useSession();
  const isMobile = useIsMobile();
  const [created, setCreated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({
    title: '',
    date: new Date().toISOString().slice(0, 10),
    time: '14:00',
    duration: 30,
    timezone: 'Europe/Kyiv',
    recurring: 'none',
    description: '',
    transcription: true,
    aiReport: true,
    taskCreation: true,
    allowGuests: true,
    departmentId: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [agenda, setAgenda] = useState<string[]>([]);
  const [newItem, setNewItem] = useState('');
  const [aiAgendaLoading, setAiAgendaLoading] = useState(false);
  const [createdId, setCreatedId] = useState('');
  const [departments, setDepartments] = useState<{ id: string; name: string }[]>([]);

  // Participants
  const [allUsers, setAllUsers] = useState<WsUser[]>([]);
  const [selectedUsers, setSelectedUsers] = useState<WsUser[]>([]);
  const [userSearch, setUserSearch] = useState('');
  const [showUserDropdown, setShowUserDropdown] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch('/api/users')
      .then(r => r.json())
      .then(data => { if (Array.isArray(data)) setAllUsers(data); })
      .catch(console.error);
    fetch('/api/departments')
      .then(r => (r.ok ? r.json() : []))
      .then(data => { if (Array.isArray(data)) setDepartments(data.map((d: { id: string; name: string }) => ({ id: d.id, name: d.name }))); })
      .catch(() => {});
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setShowUserDropdown(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const currentUserId = session?.user?.id;
  const filteredUsers = allUsers.filter(u => {
    if (u.id === currentUserId) return false; // exclude self (already host)
    if (selectedUsers.some(s => s.id === u.id)) return false;
    if (!userSearch.trim()) return true;
    const q = userSearch.toLowerCase();
    return (u.name?.toLowerCase().includes(q) || u.email?.toLowerCase().includes(q));
  });

  const addUser = (u: WsUser) => {
    setSelectedUsers(prev => [...prev, u]);
    setUserSearch('');
    setShowUserDropdown(false);
  };

  const removeUser = (id: string) => {
    setSelectedUsers(prev => prev.filter(u => u.id !== id));
  };

  const set = (k: string, v: any) => setForm((p) => ({ ...p, [k]: v }));

  const generateAgenda = async () => {
    if (aiAgendaLoading || form.title.trim().length < 3) return;
    setAiAgendaLoading(true);
    try {
      const res = await fetch('/api/meetings/ai-agenda', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: form.title.trim(),
          description: form.description.trim() || null,
          currentAgenda: agenda.length > 0 ? agenda : null,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.agenda && data.agenda.length > 0) setAgenda(data.agenda);
      }
    } catch (e) { console.error('AI agenda failed:', e); }
    finally { setAiAgendaLoading(false); }
  };

  const addAgendaItem = () => {
    const item = newItem.trim();
    if (!item) return;
    setAgenda(prev => [...prev, item]);
    setNewItem('');
  };

  const removeAgendaItem = (idx: number) => {
    setAgenda(prev => prev.filter((_, i) => i !== idx));
  };

  const updateAgendaItem = (idx: number, val: string) => {
    setAgenda(prev => prev.map((item, i) => i === idx ? val : item));
  };

  const validate = () => {
    const e: Record<string, string> = {};
    if (!form.title.trim()) e.title = t('schedule.errorTitleRequired');
    if (form.title.length > 0 && form.title.length < 3) e.title = t('schedule.errorTitleTooShort');
    if (!form.date) e.date = t('schedule.errorDateRequired');
    if (!form.time) e.time = t('schedule.errorTimeRequired');
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const submit = async () => {
    if (!validate()) return;
    setLoading(true);
    try {
      const scheduledAt = zonedWallTimeToUtcISO(form.date, form.time, form.timezone);
      const res = await fetch('/api/meetings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: form.title,
          description: form.description || null,
          scheduledAt,
          durationMin: form.duration,
          recurrence: form.recurring !== 'none' ? { type: form.recurring } : null,
          transcriptionEnabled: form.transcription,
          aiReportEnabled: form.aiReport,
          taskCreationEnabled: form.taskCreation,
          allowGuests: form.allowGuests,
          departmentId: form.departmentId || null,
          participants: selectedUsers.map(u => ({ userId: u.id })),
          agenda: agenda.length > 0 ? agenda : null,
        }),
      });
      if (!res.ok) throw new Error('Failed to create meeting');
      const meeting = await res.json();
      setCreatedId(meeting.id);
      setCreated(true);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  if (created) {
    return (
      <div style={{ flex: 1, overflowY: 'auto' }}>
        <div style={{ maxWidth: 620, margin: '60px auto', padding: '0 28px' }}>
          <div className="card fade-in" style={{ textAlign: 'center', padding: '48px 40px' }}>
            <div
              style={{
                width: 64, height: 64, borderRadius: '50%',
                background: 'color-mix(in oklab, var(--green) 18%, transparent)',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', marginBottom: 18,
              }}
            >
              <CheckCircle size={32} style={{ color: 'var(--green)' }} />
            </div>
            <div style={{ fontSize: 22, fontWeight: 700, marginBottom: 8 }}>{t('schedule.createdTitle')}</div>
            <div style={{ color: 'var(--text-2)', marginBottom: 24, fontSize: 14 }}>
              &laquo;{form.title}&raquo; &mdash; {form.date}, {form.time}
              {selectedUsers.length > 0 && (
                <span> &bull; {t('common.participants', { count: selectedUsers.length })}</span>
              )}
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
              <button className="btn" onClick={() => router.push('/calendar')}>{t('schedule.toCalendar')}</button>
              <button className="btn btn-primary" onClick={() => router.push('/')}>{t('schedule.toDashboard')}</button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto' }}>
      <div className='page-container' style={{ maxWidth: 760, margin: '0 auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
          <button className="btn btn-ghost btn-icon" onClick={() => router.push('/')}>
            <ChevronLeft size={16} />
          </button>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 700, letterSpacing: '-0.01em' }}>{t('nav.newMeeting')}</h1>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {/* Title */}
          <div className="card" style={{ padding: '18px 22px' }}>
            <input
              className="field"
              placeholder={t('schedule.titlePlaceholder')}
              value={form.title}
              onChange={(e) => set('title', e.target.value)}
              style={{ fontSize: 18, fontWeight: 600, background: 'transparent', border: 'none', padding: '4px 0', borderRadius: 0 }}
            />
            {errors.title && <Err msg={errors.title} />}
            <textarea
              className="field"
              rows={2}
              placeholder={t('schedule.descriptionPlaceholder')}
              value={form.description}
              onChange={(e) => set('description', e.target.value)}
              style={{ background: 'transparent', border: 'none', resize: 'none', padding: '8px 0 0', fontSize: 13.5 }}
            />
          </div>

          {/* Agenda checklist */}
          <div className="card" style={{ padding: '18px 22px' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <ListChecks size={15} style={{ color: 'var(--accent)' }} />
                <div style={{ fontWeight: 600, fontSize: 14 }}>{t('schedule.agendaHeading')}</div>
                {agenda.length > 0 && (
                  <span style={{ fontSize: 11, color: 'var(--muted)', background: 'var(--surface-2)', padding: '1px 7px', borderRadius: 6 }}>
                    {agenda.length}
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={generateAgenda}
                disabled={aiAgendaLoading || form.title.trim().length < 3}
                style={{
                  display: 'flex', alignItems: 'center', gap: 5,
                  padding: '6px 12px', borderRadius: 8, border: 'none', cursor: aiAgendaLoading || form.title.trim().length < 3 ? 'not-allowed' : 'pointer',
                  background: 'color-mix(in oklab, var(--accent) 12%, transparent)',
                  color: form.title.trim().length < 3 ? 'var(--muted)' : 'var(--accent)',
                  fontSize: 12, fontWeight: 600, transition: 'all .15s',
                  opacity: form.title.trim().length < 3 ? 0.5 : 1,
                }}
              >
                {aiAgendaLoading ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Wand2 size={13} />}
                {agenda.length > 0 ? t('schedule.regenerate') : t('schedule.generateAi')}
              </button>
            </div>

            {agenda.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 10 }}>
                {agenda.map((item, idx) => (
                  <div key={idx} style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '8px 10px', background: 'var(--surface)', borderRadius: 8,
                    border: '1px solid var(--border)',
                  }}>
                    <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 700, minWidth: 18, textAlign: 'center' }}>
                      {idx + 1}
                    </span>
                    <input
                      value={item}
                      onChange={e => updateAgendaItem(idx, e.target.value)}
                      style={{
                        flex: 1, background: 'transparent', border: 'none', outline: 'none',
                        fontSize: 13, color: 'var(--text)', padding: 0,
                      }}
                    />
                    <button type="button" onClick={() => removeAgendaItem(idx)}
                      style={{
                        width: 24, height: 24, borderRadius: 6, border: 'none',
                        background: 'transparent', color: 'var(--muted)', cursor: 'pointer',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        transition: 'all .15s', flexShrink: 0,
                      }}
                      onMouseEnter={e => { e.currentTarget.style.background = 'color-mix(in oklab, var(--red) 15%, transparent)'; e.currentTarget.style.color = '#fca5a5'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--muted)'; }}
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8 }}>
              <input
                className="field"
                placeholder={t('meetingForm.addAgendaItem')}
                value={newItem}
                onChange={e => setNewItem(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addAgendaItem(); } }}
                style={{ flex: 1, fontSize: 13 }}
              />
              <button type="button" className="btn" onClick={addAgendaItem}
                disabled={!newItem.trim()}
                style={{ flexShrink: 0 }}>
                <Plus size={14} /> {t('schedule.addItem')}
              </button>
            </div>

            {agenda.length === 0 && (
              <div style={{ textAlign: 'center', color: 'var(--muted)', fontSize: 12, marginTop: 10, padding: '8px 0' }}>
                {t('schedule.agendaEmptyHint')}
              </div>
            )}
          </div>

          {/* Date / time / duration — each field on its own row on mobile (3 cols on desktop) */}
          <div className='card schedule-grid-3' style={{ padding: '18px 22px', display: 'grid', gap: 14 }}>
            <Field label={t('meetingForm.date')} icon={Calendar} error={errors.date}>
              <input className="field" type="date" value={form.date} onChange={(e) => set('date', e.target.value)} style={{ textAlign: 'left' }} />
            </Field>
            <Field label={t('schedule.start')} icon={Clock} error={errors.time}>
              <input className="field" type="time" value={form.time} onChange={(e) => set('time', e.target.value)} style={{ textAlign: 'left' }} />
            </Field>
            <Field label={t('meetingForm.duration')} error={errors.duration}>
              <Select value={String(form.duration)} onChange={(v) => set('duration', parseInt(v))}
                options={[15, 30, 45, 60, 90, 120].map((d) => ({ value: String(d), label: t('common.minutes', { count: d }) }))} />
            </Field>
            <Field label={t('schedule.timezone')} icon={Globe}>
              <Select value={form.timezone} onChange={(v) => set('timezone', v)} options={[
                { value: 'Europe/Kyiv', label: 'Europe/Kyiv' },
                { value: 'Europe/Warsaw', label: 'Europe/Warsaw' },
                { value: 'Europe/London', label: 'Europe/London' },
                { value: 'America/New_York', label: 'America/New_York' },
                { value: 'America/Los_Angeles', label: 'America/Los_Angeles' },
              ]} />
            </Field>
            <Field label={t('schedule.recurrence')} icon={RefreshCw}>
              <Select value={form.recurring} onChange={(v) => set('recurring', v)} options={[
                { value: 'none', label: t('schedule.recurrenceNone') },
                { value: 'daily', label: t('schedule.recurrenceDaily') },
                { value: 'weekly', label: t('schedule.recurrenceWeekly') },
                { value: 'biweekly', label: t('schedule.recurrenceBiweekly') },
                { value: 'monthly', label: t('schedule.recurrenceMonthly') },
              ]} />
            </Field>
            {departments.length > 0 && (
              <Field label={t('departments.label')} icon={Building2}>
                <Select value={form.departmentId} onChange={(v) => set('departmentId', v)} options={[
                  { value: '', label: t('departments.none') },
                  ...departments.map((d) => ({ value: d.id, label: d.name })),
                ]} />
              </Field>
            )}
          </div>

          {/* Participants */}
          <div className="card" style={{ padding: '18px 22px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
              <Users size={15} style={{ color: 'var(--accent)' }} />
              <div style={{ fontWeight: 600, fontSize: 14 }}>{t('meetingForm.participants')}</div>
              <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                {t('schedule.participantsCountWithYou', { count: selectedUsers.length + 1 })}
              </span>
            </div>

            {/* Host (current user) */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px',
              background: 'var(--surface)', borderRadius: 8, marginBottom: 10,
            }}>
              <Avatar name={session?.user?.name || 'U'} image={session?.user?.image || null} size="sm" />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{session?.user?.name || t('schedule.you')}</div>
                <div style={{ fontSize: 11, color: 'var(--muted)' }}>{session?.user?.email}</div>
              </div>
              <span className="chip" style={{ fontSize: 10 }}>{t('common.host')}</span>
            </div>

            {/* Selected participants */}
            {selectedUsers.map(u => (
              <div key={u.id} style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px',
                background: 'var(--surface)', borderRadius: 8, marginBottom: 6,
              }}>
                <Avatar name={u.name || 'U'} image={u.image} size="sm" />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{u.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--muted)' }}>{u.email}</div>
                </div>
                <button className="btn btn-ghost btn-icon" style={{ width: 26, height: 26 }}
                  onClick={() => removeUser(u.id)}>
                  <X size={12} />
                </button>
              </div>
            ))}

            {/* User search */}
            <div ref={searchRef} style={{ position: 'relative', marginTop: 8 }}>
              <div style={{ position: 'relative' }}>
                <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
                <input
                  className="field"
                  placeholder={t('meetingForm.addParticipant')}
                  value={userSearch}
                  onChange={e => { setUserSearch(e.target.value); setShowUserDropdown(true); }}
                  onFocus={() => setShowUserDropdown(true)}
                  style={{ paddingLeft: 32, fontSize: 13 }}
                />
              </div>
              {showUserDropdown && filteredUsers.length > 0 && (
                <div style={{
                  position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 4,
                  background: 'var(--surface-2)', border: '1px solid var(--border)',
                  borderRadius: 10, maxHeight: 220, overflowY: 'auto', zIndex: 50,
                  boxShadow: '0 8px 24px rgba(0,0,0,.3)',
                }}>
                  {filteredUsers.slice(0, 8).map(u => (
                    <button key={u.id} onClick={() => addUser(u)}
                      style={{
                        width: '100%', display: 'flex', alignItems: 'center', gap: 10,
                        padding: '10px 12px', background: 'transparent', border: 'none',
                        cursor: 'pointer', textAlign: 'left', color: 'var(--text)',
                        transition: 'background .1s',
                      }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface-3)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    >
                      <Avatar name={u.name || 'U'} image={u.image} size="sm" />
                      <div>
                        <div style={{ fontSize: 13, fontWeight: 500 }}>{u.name}</div>
                        <div style={{ fontSize: 11, color: 'var(--muted)' }}>{u.email}</div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
              {showUserDropdown && userSearch && filteredUsers.length === 0 && (
                <div style={{
                  position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 4,
                  background: 'var(--surface-2)', border: '1px solid var(--border)',
                  borderRadius: 10, padding: '14px 16px', zIndex: 50,
                  boxShadow: '0 8px 24px rgba(0,0,0,.3)',
                  fontSize: 13, color: 'var(--muted)', textAlign: 'center',
                }}>
                  {t('schedule.noUsersFound')}
                </div>
              )}
            </div>
          </div>

          {/* AI options */}
          <div className="card" style={{ padding: '18px 22px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <Sparkles size={15} style={{ color: 'var(--accent)' }} />
              <div style={{ fontWeight: 600, fontSize: 14 }}>{t('schedule.aiSectionTitle')}</div>
            </div>
            <Toggle label={t('schedule.toggleTranscription')} value={form.transcription} onChange={(v) => set('transcription', v)} />
            <Toggle label={t('schedule.toggleAiReport')} value={form.aiReport} onChange={(v) => set('aiReport', v)} />
            <Toggle label={t('schedule.toggleTaskCreation')} value={form.taskCreation} onChange={(v) => set('taskCreation', v)} />
            <Toggle label={t('schedule.toggleAllowGuests')} value={form.allowGuests} onChange={(v) => set('allowGuests', v)} />
          </div>

          <div style={{ display: 'flex', flexDirection: isMobile ? 'column' : 'row', justifyContent: 'flex-end', gap: 10 }}>
            <button className="btn" onClick={() => router.push('/')}
              style={isMobile ? { width: '100%', justifyContent: 'center', padding: '13px' } : undefined}>{t('common.cancel')}</button>
            <button className="btn btn-primary" onClick={submit} disabled={loading}
              style={{ fontWeight: 600, gap: 8, ...(isMobile ? { width: '100%', justifyContent: 'center', padding: '14px' } : {}) }}>
              <Send size={14} /> {loading ? t('schedule.creating') : t('schedule.submit')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Convert a wall-clock date+time entered in `tz` (IANA) into a UTC ISO string.
function zonedWallTimeToUtcISO(dateStr: string, timeStr: string, tz: string): string {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = timeStr.split(':').map(Number);
  const utcGuess = Date.UTC(y, (mo || 1) - 1, d || 1, h || 0, mi || 0);
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const parts: Record<string, string> = {};
    for (const p of dtf.formatToParts(new Date(utcGuess))) parts[p.type] = p.value;
    const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
    const offset = asUtc - utcGuess; // tz offset at that instant
    return new Date(utcGuess - offset).toISOString();
  } catch {
    return new Date(`${dateStr}T${timeStr}:00`).toISOString();
  }
}

function Field({ label, icon: Icon, error, children, style }: { label: string; icon?: any; error?: string; children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <div style={style}>
      <label className="field-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {Icon && <Icon size={12} />}{label}
      </label>
      {children}
      {error && <Err msg={error} />}
    </div>
  );
}

function Err({ msg }: { msg: string }) {
  return (
    <div style={{ marginTop: 6, fontSize: 11.5, color: 'var(--danger-fg)', display: 'flex', alignItems: 'center', gap: 5 }}>
      <AlertCircle size={12} /> {msg}
    </div>
  );
}

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 0', borderBottom: '1px solid var(--border)', cursor: 'pointer', gap: 14,
      }}
    >
      <span style={{ fontSize: 13.5, color: 'var(--text-2)' }}>{label}</span>
      <button
        type="button"
        onClick={() => onChange(!value)}
        style={{
          width: 38, height: 22, borderRadius: 999, border: 'none', position: 'relative',
          background: value ? 'var(--accent)' : 'var(--surface-3)', transition: 'background .15s', flexShrink: 0, cursor: 'pointer',
        }}
      >
        <span
          style={{
            position: 'absolute', top: 3, left: value ? 19 : 3,
            width: 16, height: 16, borderRadius: '50%',
            background: '#fff', transition: 'left .15s', boxShadow: '0 1px 3px rgba(0,0,0,.3)',
          }}
        />
      </button>
    </label>
  );
}
