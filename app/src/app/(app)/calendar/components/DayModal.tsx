'use client';

import { useTranslations, useLocale } from 'next-intl';
import Link from 'next/link';
import { X, Calendar, Plus, RefreshCw, Video, ListChecks } from 'lucide-react';
import { AvatarStack } from '@/components/ui/avatar';
import { fmtTime, fmtDateLong } from '@/lib/utils';
import type { Meeting, CalTask } from '../lib/types';
import { eventAccent, taskAccent, getParticipantNames } from '../lib/dates';

/* ------------------------------------------------------------------ */
/*  DayModal                                                          */
/* ------------------------------------------------------------------ */

export function DayModal({
  date,
  meetings,
  tasks,
  onClose,
  onMeetingClick,
  onTaskClick,
}: {
  date: Date;
  meetings: Meeting[];
  tasks: CalTask[];
  onClose: () => void;
  onMeetingClick: (m: Meeting) => void;
  onTaskClick: (t: CalTask) => void;
}) {
  const t = useTranslations();
  const locale = useLocale();

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 100,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--overlay)',
        backdropFilter: 'blur(4px)',
      }}
      onClick={onClose}
    >
      <div
        className="card"
        style={{
          width: 520,
          maxWidth: 'calc(100vw - 24px)',
          maxHeight: '80vh',
          overflow: 'auto',
          padding: 0,
          animation: 'fadeIn .15s',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ padding: '22px 24px 24px' }}>
          {/* Modal header */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'flex-start',
              marginBottom: 14,
            }}
          >
            <div>
              <div
                style={{
                  fontSize: 11.5,
                  color: 'var(--muted)',
                  textTransform: 'uppercase',
                  letterSpacing: '.06em',
                }}
              >
                {new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(date)}
              </div>
              <div
                style={{
                  fontSize: 22,
                  fontWeight: 700,
                  letterSpacing: '-0.01em',
                }}
              >
                {fmtDateLong(date, locale)}
              </div>
            </div>
            <button
              className="btn btn-ghost btn-icon"
              onClick={onClose}
              style={{ flexShrink: 0 }}
            >
              <X size={16} />
            </button>
          </div>

          {/* Meetings + deadlines */}
          {meetings.length === 0 && tasks.length === 0 ? (
            <div
              style={{
                padding: '32px 0',
                textAlign: 'center',
                color: 'var(--muted)',
              }}
            >
              <Calendar
                size={28}
                style={{ opacity: 0.5, marginBottom: 10 }}
              />
              <div style={{ marginBottom: 12 }}>{t('calendar.noMeetings')}</div>
              <Link
                href="/schedule"
                className="btn btn-primary btn-sm"
                style={{ textDecoration: 'none', gap: 5 }}
                onClick={onClose}
              >
                <Plus size={13} /> {t('nav.newMeeting')}
              </Link>
            </div>
          ) : (
            <>
            {meetings.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {meetings
                .sort((a, b) => {
                  const ta = a.scheduledAt ? new Date(a.scheduledAt).getTime() : 0;
                  const tb = b.scheduledAt ? new Date(b.scheduledAt).getTime() : 0;
                  return ta - tb;
                })
                .map((m) => {
                  const start = m.scheduledAt ? new Date(m.scheduledAt) : null;
                  const end =
                    start ? new Date(start.getTime() + m.durationMin * 60000) : null;
                  const accent = eventAccent(m);
                  const users = getParticipantNames(m);

                  return (
                    <div
                      key={m.id}
                      onClick={() => onMeetingClick(m)}
                      style={{
                        display: 'flex',
                        gap: 12,
                        padding: '12px 14px',
                        borderRadius: 10,
                        border: '1px solid var(--border)',
                        borderLeft: `3px solid ${accent}`,
                        background: `color-mix(in oklab, ${accent} 5%, var(--surface))`,
                        cursor: 'pointer',
                        transition: 'filter .15s',
                      }}
                      onMouseEnter={(e) => {
                        (e.currentTarget as HTMLElement).style.filter = 'brightness(1.1)';
                      }}
                      onMouseLeave={(e) => {
                        (e.currentTarget as HTMLElement).style.filter = 'none';
                      }}
                    >
                      <div style={{ width: 50, flexShrink: 0, textAlign: 'center' }}>
                        <div className="mono" style={{ fontSize: 13, fontWeight: 600 }}>
                          {start ? fmtTime(start) : '--:--'}
                        </div>
                        <div className="mono" style={{ fontSize: 10, color: 'var(--muted)' }}>
                          {end ? fmtTime(end) : ''}
                        </div>
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            fontWeight: 600,
                            fontSize: 13.5,
                            marginBottom: 4,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {m.title}
                        </div>
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                          }}
                        >
                          <AvatarStack users={users} max={4} size="sm" />
                          <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                            {t('calendar.participantsShort', { count: users.length })}
                          </span>
                          {m.recurrence && (
                            <span className="chip" style={{ fontSize: 10 }}>
                              <RefreshCw size={9} /> {t('calendar.weekly')}
                            </span>
                          )}
                        </div>
                      </div>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          flexShrink: 0,
                        }}
                      >
                        <Video size={14} style={{ color: 'var(--muted)' }} />
                      </div>
                    </div>
                  );
                })}
            </div>
            )}
            {tasks.length > 0 && (
              <div style={{ marginTop: meetings.length > 0 ? 18 : 0 }}>
                <div
                  style={{
                    fontSize: 11.5,
                    color: 'var(--muted)',
                    textTransform: 'uppercase',
                    letterSpacing: '.06em',
                    marginBottom: 8,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  <ListChecks size={12} /> {t('calendar.deadlines')}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {tasks.map((tk) => {
                    const accent = taskAccent(tk.priority);
                    return (
                      <div
                        key={tk.id}
                        onClick={() => onTaskClick(tk)}
                        style={{
                          display: 'flex',
                          gap: 12,
                          alignItems: 'center',
                          padding: '12px 14px',
                          borderRadius: 10,
                          border: '1px solid var(--border)',
                          borderLeft: `3px solid ${accent}`,
                          background: `color-mix(in oklab, ${accent} 5%, var(--surface))`,
                          cursor: 'pointer',
                          transition: 'filter .15s',
                        }}
                        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.filter = 'brightness(1.1)'; }}
                        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.filter = 'none'; }}
                      >
                        <ListChecks size={16} style={{ color: accent, flexShrink: 0 }} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 600, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {tk.title}
                          </div>
                          {tk.meeting?.title && (
                            <div style={{ fontSize: 11, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 2 }}>
                              {tk.meeting.title}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
