'use client';

import { useTranslations, useLocale } from 'next-intl';
import Link from 'next/link';
import {
  Calendar,
  RefreshCw,
  Clock,
  Users as UsersIcon,
  FileText,
  ListChecks,
  Video,
  Trash2,
  Loader2,
  Pencil,
} from 'lucide-react';
import { AvatarStack } from '@/components/ui/avatar';
import { fmtTime, fmtDateLong } from '@/lib/utils';
import { useIsMobile } from '@/lib/use-is-mobile';
import type { Meeting } from '../lib/types';
import { eventAccent, getParticipantNames } from '../lib/dates';

/* ------------------------------------------------------------------ */
/*  MeetingDetailModal                                                */
/* ------------------------------------------------------------------ */

export function MeetingDetailModal({
  meeting: m,
  onClose,
  onJoin,
  onEdit,
  onDelete,
  deleting,
}: {
  meeting: Meeting;
  onClose: () => void;
  onJoin: (m: Meeting) => void;
  onEdit: (m: Meeting) => void;
  onDelete: (m: Meeting) => void;
  deleting: boolean;
}) {
  const start = m.scheduledAt ? new Date(m.scheduledAt) : null;
  const end = start ? new Date(start.getTime() + m.durationMin * 60000) : null;
  const accent = eventAccent(m);
  const users = getParticipantNames(m);
  const hasReport = m.reports && m.reports.length > 0;
  const isCompleted = m.status === 'completed' || m.status === 'ended';
  const agenda = Array.isArray(m.agenda) ? m.agenda : [];
  const isMobile = useIsMobile();
  const t = useTranslations();
  const locale = useLocale();

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 100,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--overlay)', backdropFilter: 'blur(4px)',
      }}
      onClick={onClose}
    >
      <div
        className="card"
        style={{
          width: 540, maxWidth: 'calc(100vw - 24px)', maxHeight: '85vh', overflow: 'auto',
          padding: 0, animation: 'fadeIn .15s',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Header with accent bar */}
        <div style={{
          height: 4, background: accent, borderRadius: '12px 12px 0 0',
        }} />

        <div style={{ padding: '20px 24px 24px' }}>
          {/* Status + time */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            {start && (
              <span className="mono" style={{ fontSize: 13, fontWeight: 600 }}>
                {fmtTime(start)}{end ? ' — ' + fmtTime(end) : ''}
              </span>
            )}
            <span style={{
              fontSize: 10, padding: '2px 8px', borderRadius: 6, fontWeight: 600,
              background: isCompleted
                ? 'color-mix(in oklab, var(--muted) 20%, transparent)'
                : 'color-mix(in oklab, var(--green) 18%, transparent)',
              color: isCompleted ? 'var(--muted)' : 'var(--green)',
            }}>
              {m.status === 'scheduled' ? t('calendar.status.scheduled') : m.status === 'live' ? t('calendar.status.live') : m.status === 'ended' ? t('calendar.status.ended') : m.status}
            </span>
            {m.recurrence && (
              <span className="chip" style={{ fontSize: 10 }}>
                <RefreshCw size={9} /> {t('calendar.recurring')}
              </span>
            )}
          </div>

          {/* Title */}
          <h2 style={{ fontSize: 20, fontWeight: 700, margin: '0 0 6px', letterSpacing: '-0.01em' }}>
            {m.title}
          </h2>

          {/* Description */}
          {m.description && (
            <p style={{ color: 'var(--text-2)', fontSize: 13.5, lineHeight: 1.55, margin: '0 0 14px' }}>
              {m.description}
            </p>
          )}

          {/* Info row */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, marginBottom: 16, fontSize: 12.5, color: 'var(--muted)' }}>
            {start && (
              <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <Calendar size={13} /> {fmtDateLong(start, locale)}
              </span>
            )}
            <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <Clock size={13} /> {t('common.minutes', { count: m.durationMin })}
            </span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <UsersIcon size={13} /> {t('common.participants', { count: m.participants?.length || 0 })}
            </span>
          </div>

          {/* Agenda */}
          {agenda.length > 0 && (
            <div style={{
              padding: '14px 16px', background: 'var(--surface)',
              border: '1px solid var(--border)', borderRadius: 10, marginBottom: 14,
            }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 6,
                fontSize: 12, fontWeight: 600, color: 'var(--text-2)',
                textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 8,
              }}>
                <ListChecks size={13} /> {t('meetingForm.agenda')}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {agenda.map((item: string, idx: number) => (
                  <div key={idx} style={{
                    display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 13, lineHeight: 1.45,
                  }}>
                    <span style={{ color: 'var(--muted)', fontWeight: 600, minWidth: 16, textAlign: 'right', flexShrink: 0 }}>
                      {idx + 1}.
                    </span>
                    <span style={{ color: 'var(--text-2)' }}>{item}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Participants */}
          {users.length > 0 && (
            <div style={{
              padding: '12px 14px', background: 'var(--surface)',
              border: '1px solid var(--border)', borderRadius: 10, marginBottom: 14,
            }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 6,
                fontSize: 12, fontWeight: 600, color: 'var(--text-2)',
                textTransform: 'uppercase', letterSpacing: '.04em', marginBottom: 8,
              }}>
                <UsersIcon size={13} /> {t('meetingForm.participants')}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <AvatarStack users={users} size="md" max={6} />
                <span style={{ fontSize: 12, color: 'var(--muted)' }}>
                  {users.map(u => u.name).join(', ')}
                </span>
              </div>
            </div>
          )}

          {/* Organizer */}
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 18 }}>
            {t('calendar.organizer')}: <strong style={{ color: 'var(--text-2)' }}>{m.createdBy?.name || t('calendar.unknown')}</strong>
          </div>

          {/* Action buttons — wrap on mobile so nothing overflows */}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {isCompleted && hasReport ? (
              <Link
                href={'/meetings/' + m.id + '/report'}
                className="btn btn-primary"
                style={{ textDecoration: 'none', flex: isMobile ? '1 1 100%' : 1, justifyContent: 'center', fontWeight: 600 }}
                onClick={onClose}
              >
                <FileText size={15} /> {t('calendar.viewReport')}
              </Link>
            ) : (
              <Link
                href={'/lobby/' + m.id}
                className="btn btn-primary"
                style={{ textDecoration: 'none', flex: isMobile ? '1 1 100%' : 1, justifyContent: 'center', fontWeight: 600 }}
                onClick={onClose}
              >
                <Video size={15} /> {m.status === 'live' ? t('common.join') : t('calendar.enterMeeting')}
              </Link>
            )}
            {!isCompleted && (
              <button
                className="btn"
                onClick={() => onEdit(m)}
                style={isMobile ? { flex: 1, justifyContent: 'center' } : { flexShrink: 0 }}
              >
                <Pencil size={14} /> {t('common.edit')}
              </button>
            )}
            {!isCompleted && (
              <button
                className="btn"
                onClick={() => onDelete(m)}
                disabled={deleting}
                style={{ color: 'var(--danger-fg)', flexShrink: 0 }}
              >
                {deleting ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Trash2 size={14} />}
              </button>
            )}
            <button className="btn" onClick={onClose} style={isMobile ? { flex: 1, justifyContent: 'center' } : { flexShrink: 0 }}>
              {t('common.close')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
