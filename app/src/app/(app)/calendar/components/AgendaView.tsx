'use client';

import { useMemo } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { Calendar, ListChecks } from 'lucide-react';
import { AvatarStack } from '@/components/ui/avatar';
import { fmtTime } from '@/lib/utils';
import type { Meeting, CalTask } from '../lib/types';
import { taskAccent } from '../lib/dates';

/* ------------------------------------------------------------------ */
/*  AgendaView (mobile) — chronological upcoming meetings as cards     */
/* ------------------------------------------------------------------ */
export function AgendaView({ meetings, tasks, today, onMeetingClick, onTaskClick }: {
  meetings: Meeting[];
  tasks: CalTask[];
  today: Date;
  onMeetingClick: (m: Meeting) => void;
  onTaskClick: (t: CalTask) => void;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const groups = useMemo(() => {
    const map = new Map<string, { date: Date; meetings: Meeting[]; tasks: CalTask[] }>();
    const bucket = (d0: Date) => {
      const d = new Date(d0);
      d.setHours(0, 0, 0, 0);
      const key = d.toISOString().slice(0, 10);
      if (!map.has(key)) map.set(key, { date: d, meetings: [], tasks: [] });
      return map.get(key)!;
    };
    for (const m of meetings) {
      if (m.scheduledAt) bucket(new Date(m.scheduledAt)).meetings.push(m);
    }
    for (const tk of tasks) {
      if (tk.dueDate) bucket(new Date(tk.dueDate)).tasks.push(tk);
    }
    const arr = Array.from(map.values());
    arr.sort((a, b) => a.date.getTime() - b.date.getTime());
    for (const g of arr) {
      g.meetings.sort((a, b) => new Date(a.scheduledAt!).getTime() - new Date(b.scheduledAt!).getTime());
    }
    return arr;
  }, [meetings, tasks]);

  const dayLabel = (d: Date) => {
    const diff = Math.round((d.getTime() - today.getTime()) / 86400000);
    if (diff === 0) return t('common.today');
    if (diff === 1) return t('common.tomorrow');
    if (diff === -1) return t('common.yesterday');
    return d.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' });
  };

  if (groups.length === 0) {
    return (
      <div style={{ flex: 1, overflowY: 'auto', padding: '48px 24px', textAlign: 'center', color: 'var(--muted)' }}>
        <Calendar size={40} style={{ opacity: 0.3, marginBottom: 12 }} />
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)', marginBottom: 6 }}>{t('calendar.noScheduledMeetings')}</div>
        <div style={{ fontSize: 13, lineHeight: 1.5 }}>{t('calendar.emptyHint')}</div>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '16px clamp(14px, 4vw, 28px) 90px' }}>
      {groups.map((g) => {
        const isToday = g.date.getTime() === today.getTime();
        return (
          <div key={g.date.toISOString()} style={{ marginBottom: 22 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: isToday ? 'var(--accent)' : 'var(--text-2)', textTransform: 'capitalize' }}>{dayLabel(g.date)}</span>
              <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
              <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>{g.meetings.length + g.tasks.length}</span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {g.meetings.map((m) => {
                const start = new Date(m.scheduledAt!);
                const users = m.participants.map((p) => ({ name: p.user?.name || p.guestName || 'Guest', image: p.user?.image || null }));
                return (
                  <button key={m.id} onClick={() => onMeetingClick(m)} className="card" style={{
                    textAlign: 'left', cursor: 'pointer', display: 'flex', gap: 14, alignItems: 'center', padding: 16, width: '100%',
                  }}>
                    <div style={{ textAlign: 'center', flexShrink: 0, minWidth: 46 }}>
                      <div className="mono" style={{ fontSize: 15, fontWeight: 700 }}>{fmtTime(start)}</div>
                      <div className="mono" style={{ fontSize: 10.5, color: 'var(--muted)' }}>{t('calendar.durationMinShort', { count: m.durationMin })}</div>
                    </div>
                    <div style={{ width: 1, alignSelf: 'stretch', background: 'var(--border)', minHeight: 34 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 14.5, marginBottom: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.title}</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <AvatarStack users={users} max={4} />
                        {m.status === 'live' && (
                          <span className="chip" style={{ background: 'color-mix(in oklab, var(--red) 18%, transparent)', color: 'var(--danger-fg)', borderColor: 'color-mix(in oklab, var(--red) 35%, transparent)' }}>● {t('calendar.live')}</span>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })}
              {g.tasks.map((tk) => {
                const accent = taskAccent(tk.priority);
                return (
                  <button key={tk.id} onClick={() => onTaskClick(tk)} className="card" style={{
                    textAlign: 'left', cursor: 'pointer', display: 'flex', gap: 14, alignItems: 'center', padding: 16, width: '100%',
                    borderLeft: `3px solid ${accent}`,
                  }}>
                    <div style={{ width: 46, flexShrink: 0, display: 'flex', justifyContent: 'center' }}>
                      <ListChecks size={20} style={{ color: accent }} />
                    </div>
                    <div style={{ width: 1, alignSelf: 'stretch', background: 'var(--border)', minHeight: 34 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 600, fontSize: 14.5, marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tk.title}</div>
                      <div style={{ fontSize: 11.5, color: 'var(--muted)', display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ textTransform: 'uppercase', letterSpacing: '.04em', color: accent, fontWeight: 600, fontSize: 10.5 }}>{t('calendar.deadline')}</span>
                        {tk.meeting?.title && <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>· {tk.meeting.title}</span>}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
