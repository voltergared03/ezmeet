'use client';

import { useState, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import {
  X,
  Plus,
  Calendar,
  Users as UsersIcon,
  Loader2,
  Save,
  Search,
  Wand2,
  ListChecks as ListChecksIcon,
} from 'lucide-react';
import { Select } from '@/components/ui/select';
import { Avatar } from '@/components/ui/avatar';
import type { Meeting, WsUser } from '../lib/types';

/* ------------------------------------------------------------------ */
/*  CalendarEditModal                                                 */
/* ------------------------------------------------------------------ */

export function CalendarEditModal({ meeting, onClose, onSave }: {
  meeting: Meeting;
  onClose: () => void;
  onSave: (m: Meeting) => void;
}) {
  const t = useTranslations();
  const schedAt = meeting.scheduledAt ? new Date(meeting.scheduledAt) : null;
  const [title, setTitle] = useState(meeting.title);
  const [description, setDescription] = useState(meeting.description || '');
  const [date, setDate] = useState(schedAt ? schedAt.toISOString().slice(0, 10) : '');
  const [time, setTime] = useState(schedAt ? schedAt.toTimeString().slice(0, 5) : '14:00');
  const [duration, setDuration] = useState(meeting.durationMin);
  const [saving, setSaving] = useState(false);
  const [agenda, setAgenda] = useState<string[]>(Array.isArray(meeting.agenda) ? meeting.agenda : []);
  const [newAgendaItem, setNewAgendaItem] = useState('');
  const [aiAgendaLoading, setAiAgendaLoading] = useState(false);

  // Participants
  const [allUsers, setAllUsers] = useState<WsUser[]>([]);
  const [selectedUsers, setSelectedUsers] = useState<WsUser[]>([]);
  const [userSearch, setUserSearch] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch('/api/users')
      .then(r => r.json())
      .then(data => {
        if (!Array.isArray(data)) return;
        setAllUsers(data);
        const participantUserIds = meeting.participants
          .filter((p: any) => p.role !== 'host' && p.user)
          .map((p: any) => p.user!.id);
        const selected = data.filter((u: WsUser) => participantUserIds.includes(u.id));
        setSelectedUsers(selected);
      })
      .catch(console.error);
  }, [meeting.participants]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) {
        setShowDropdown(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const hostId = meeting.createdBy?.id;
  const filteredUsers = allUsers.filter(u => {
    if (u.id === hostId) return false;
    if (selectedUsers.some(s => s.id === u.id)) return false;
    if (!userSearch.trim()) return true;
    const q = userSearch.toLowerCase();
    return (u.name?.toLowerCase().includes(q) || u.email?.toLowerCase().includes(q));
  });

  const generateAgenda = async () => {
    if (aiAgendaLoading || title.trim().length < 3) return;
    setAiAgendaLoading(true);
    try {
      const res = await fetch('/api/meetings/ai-agenda', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim() || null,
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

  const save = async () => {
    if (!title.trim()) return;
    setSaving(true);
    try {
      const scheduledAt = date && time ? new Date(`${date}T${time}:00`).toISOString() : null;
      const res = await fetch(`/api/meetings/${meeting.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          description: description || null,
          scheduledAt,
          durationMin: duration,
          agenda: agenda.length > 0 ? agenda : null,
          participants: selectedUsers.map(u => ({ userId: u.id })),
        }),
      });
      if (res.ok) {
        const updated = await res.json();
        onSave(updated);
      }
    } catch (e) { console.error(e); }
    finally { setSaving(false); }
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'var(--overlay)', zIndex: 110,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      overflowY: 'auto',
    }} onClick={onClose}>
      <div className="card" style={{ maxWidth: 560, width: '100%', padding: '24px 22px', maxHeight: '90vh', overflowY: 'auto', animation: 'fadeIn .15s' }}
        onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
          <div style={{ fontSize: 18, fontWeight: 700 }}>{t('calendar.editMeeting')}</div>
          <button className="btn btn-ghost btn-icon" onClick={onClose}><X size={16} /></button>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label className="field-label">{t('meetingForm.title')}</label>
            <input className="field" value={title} onChange={e => setTitle(e.target.value)} />
          </div>
          <div>
            <label className="field-label">{t('meetingForm.description')}</label>
            <textarea className="field" rows={2} value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder={t('meetingForm.descriptionPlaceholder')} style={{ resize: 'none' }} />
          </div>

          {/* Agenda */}
          <div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
              <label className="field-label" style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 5 }}>
                <ListChecksIcon size={11} /> {t('calendar.agendaCount', { count: agenda.length })}
              </label>
              <button type="button" onClick={generateAgenda}
                disabled={aiAgendaLoading || title.trim().length < 3}
                style={{
                  display: 'flex', alignItems: 'center', gap: 4, padding: '3px 8px',
                  borderRadius: 6, border: 'none', fontSize: 11, fontWeight: 600,
                  background: 'color-mix(in oklab, var(--accent) 12%, transparent)',
                  color: title.trim().length < 3 ? 'var(--muted)' : 'var(--accent)',
                  cursor: aiAgendaLoading || title.trim().length < 3 ? 'not-allowed' : 'pointer',
                  opacity: title.trim().length < 3 ? 0.5 : 1,
                }}>
                {aiAgendaLoading ? <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} /> : <Wand2 size={11} />}
                AI
              </button>
            </div>
            {agenda.map((item, idx) => (
              <div key={idx} style={{
                display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4,
                padding: '5px 8px', background: 'var(--surface)', borderRadius: 6,
                border: '1px solid var(--border)',
              }}>
                <span style={{ fontSize: 11, color: 'var(--muted)', fontWeight: 700, minWidth: 14, textAlign: 'center' }}>{idx + 1}</span>
                <input value={item} onChange={e => setAgenda(prev => prev.map((x, i) => i === idx ? e.target.value : x))}
                  style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', fontSize: 12.5, color: 'var(--text)', padding: 0 }} />
                <button type="button" onClick={() => setAgenda(prev => prev.filter((_, i) => i !== idx))}
                  style={{ width: 20, height: 20, borderRadius: 4, border: 'none', background: 'transparent',
                    color: 'var(--muted)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  <X size={10} />
                </button>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
              <input className="field" placeholder={t('meetingForm.addAgendaItem')} value={newAgendaItem}
                onChange={e => setNewAgendaItem(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); if (newAgendaItem.trim()) { setAgenda(p => [...p, newAgendaItem.trim()]); setNewAgendaItem(''); } } }}
                style={{ flex: 1, fontSize: 12, padding: '6px 10px' }} />
              <button type="button" className="btn btn-sm" onClick={() => { if (newAgendaItem.trim()) { setAgenda(p => [...p, newAgendaItem.trim()]); setNewAgendaItem(''); } }}
                disabled={!newAgendaItem.trim()} style={{ flexShrink: 0 }}>
                <Plus size={12} />
              </button>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
            <div style={{ minWidth: 0 }}>
              <label className="field-label"><Calendar size={11} /> {t('meetingForm.date')}</label>
              <input className="field" type="date" value={date} onChange={e => setDate(e.target.value)} style={{ minWidth: 0 }} />
            </div>
            <div style={{ minWidth: 0 }}>
              <label className="field-label">{t('meetingForm.time')}</label>
              <input className="field" type="time" value={time} onChange={e => setTime(e.target.value)} style={{ minWidth: 0 }} />
            </div>
            <div style={{ minWidth: 0 }}>
              <label className="field-label">{t('meetingForm.duration')}</label>
              <Select value={String(duration)} onChange={(v) => setDuration(parseInt(v))} style={{ minWidth: 0 }}
                options={[15, 30, 45, 60, 90, 120].map(d => ({ value: String(d), label: t('common.minutes', { count: d }) }))} />
            </div>
          </div>

          {/* Participants */}
          <div>
            <label className="field-label"><UsersIcon size={11} /> {t('calendar.participantsCount', { count: selectedUsers.length + 1 })}</label>
            {meeting.createdBy && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '6px 8px',
                background: 'var(--surface)', borderRadius: 8, marginBottom: 6, marginTop: 6,
              }}>
                <Avatar name={meeting.createdBy.name || 'U'} image={meeting.createdBy.image} size="sm" />
                <div style={{ flex: 1, fontSize: 13, fontWeight: 500 }}>{meeting.createdBy.name}</div>
                <span className="chip" style={{ fontSize: 10 }}>{t('calendar.organizer')}</span>
              </div>
            )}

            {selectedUsers.map(u => (
              <div key={u.id} style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '6px 8px',
                background: 'var(--surface)', borderRadius: 8, marginBottom: 4,
              }}>
                <Avatar name={u.name || 'U'} image={u.image} size="sm" />
                <div style={{ flex: 1, fontSize: 13 }}>{u.name}</div>
                <button className="btn btn-ghost btn-icon" style={{ width: 24, height: 24 }}
                  onClick={() => setSelectedUsers(p => p.filter(x => x.id !== u.id))}>
                  <X size={11} />
                </button>
              </div>
            ))}

            <div ref={searchRef} style={{ position: 'relative', marginTop: 6 }}>
              <div style={{ position: 'relative' }}>
                <Search size={13} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted)' }} />
                <input className="field" placeholder={t('meetingForm.addParticipant')}
                  value={userSearch} onChange={e => { setUserSearch(e.target.value); setShowDropdown(true); }}
                  onFocus={() => setShowDropdown(true)}
                  style={{ paddingLeft: 30, fontSize: 13 }} />
              </div>
              {showDropdown && filteredUsers.length > 0 && (
                <div style={{
                  position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 4,
                  background: 'var(--surface-2)', border: '1px solid var(--border)',
                  borderRadius: 10, maxHeight: 180, overflowY: 'auto', zIndex: 60,
                  boxShadow: '0 8px 24px rgba(0,0,0,.3)',
                }}>
                  {filteredUsers.slice(0, 6).map(u => (
                    <button key={u.id} onClick={() => { setSelectedUsers(p => [...p, u]); setUserSearch(''); setShowDropdown(false); }}
                      style={{
                        width: '100%', display: 'flex', alignItems: 'center', gap: 10,
                        padding: '9px 12px', background: 'transparent', border: 'none',
                        cursor: 'pointer', textAlign: 'left', color: 'var(--text)',
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
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 20 }}>
          <button className="btn" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-primary" onClick={save} disabled={saving || !title.trim()}>
            <Save size={14} /> {saving ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
