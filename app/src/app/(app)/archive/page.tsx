'use client';

import { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { Search, X, Sparkles, ChevronRight, RefreshCw, Users, Trash2 } from 'lucide-react';
import { useSession } from 'next-auth/react';
import { useTranslations, useLocale } from 'next-intl';
import { AvatarStack } from '@/components/ui/avatar';
import { fmtTime, fmtRelative, zonedFormFields } from '@/lib/utils';
import { useWorkspaceTz } from '@/hooks/use-workspace-tz';
import { useIsMobile } from '@/lib/use-is-mobile';

interface Participant {
  user: { id: string; name: string | null; image: string | null } | null;
  guestName: string | null;
}

interface TranscriptMatch {
  language: string;
  snippets: string[];
}

interface Meeting {
  id: string;
  title: string;
  scheduledAt: string | null;
  durationMin: number;
  status: string;
  recurrence?: any;
  createdBy: { id: string; name: string | null; image: string | null };
  participants: Participant[];
  reports?: { id: string }[];
  transcriptMatches?: TranscriptMatch[];
}

type FilterTab = 'all' | 'my' | 'recurring';

const FILTER_TABS: { key: FilterTab; labelKey: string }[] = [
  { key: 'all', labelKey: 'archive.filterAll' },
  { key: 'my', labelKey: 'archive.filterMy' },
  { key: 'recurring', labelKey: 'archive.filterRecurring' },
];

function groupByDay(meetings: Meeting[], locale: string, tz: string): { label: string; date: Date; meetings: Meeting[] }[] {
  const groups = new Map<string, { label: string; date: Date; meetings: Meeting[] }>();

  for (const m of meetings) {
    if (!m.scheduledAt) continue;
    const d = new Date(m.scheduledAt);
    // Group by the calendar day in the workspace zone (not the browser's).
    const dayKey = zonedFormFields(d, tz).date;
    if (!groups.has(dayKey)) {
      groups.set(dayKey, { label: fmtRelative(d, locale, tz), date: d, meetings: [] });
    }
    groups.get(dayKey)!.meetings.push(m);
  }

  return Array.from(groups.values()).sort((a, b) => b.date.getTime() - a.date.getTime());
}

function getUsers(m: Meeting) {
  return m.participants.map((p) => ({
    name: p.user?.name || p.guestName || 'Guest',
    image: p.user?.image || null,
  }));
}

function highlightMatch(text: string, query: string): React.ReactNode {
  if (!query.trim()) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(${escaped})`, 'gi');
  const parts = text.split(re);
  return parts.map((part, i) =>
    re.test(part) ? (
      <mark
        key={i}
        style={{
          background: 'color-mix(in oklab, var(--accent) 30%, transparent)',
          color: 'inherit',
          borderRadius: 2,
          padding: '0 2px',
        }}
      >
        {part}
      </mark>
    ) : (
      part
    )
  );
}

export default function ArchivePage() {
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<FilterTab>('all');
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Meeting | null>(null);
  // When the meeting can't be deleted because it has a saved recording, the API
  // returns 409 — surface that (instead of failing silently) and offer to remove
  // the recording too.
  const [recBlocked, setRecBlocked] = useState(false);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === 'admin';
  const isMobile = useIsMobile();
  const t = useTranslations();
  const locale = useLocale();
  const tz = useWorkspaceTz();

  const closeConfirm = () => { setConfirmDelete(null); setRecBlocked(false); setDeleteErr(null); };

  const handleDelete = async () => {
    if (!confirmDelete) return;
    setDeletingId(confirmDelete.id);
    setDeleteErr(null);
    try {
      const res = await fetch('/api/meetings/' + confirmDelete.id, { method: 'DELETE' });
      if (res.ok) {
        setMeetings(prev => prev.filter(m => m.id !== confirmDelete.id));
        closeConfirm();
      } else if (res.status === 409) {
        // Blocked because a recording is attached — keep the dialog open and offer
        // to delete the recording along with the meeting.
        setRecBlocked(true);
      } else {
        const d = await res.json().catch(() => ({}));
        setDeleteErr(d.error || t('archive.deleteFailed'));
      }
    } catch (e) {
      console.error(e);
      setDeleteErr(t('archive.deleteFailed'));
    } finally {
      setDeletingId(null);
    }
  };

  // Delete the saved recording first (the meeting-delete guard refuses while one
  // exists), then the meeting itself.
  const handleDeleteWithRecording = async () => {
    if (!confirmDelete) return;
    setDeletingId(confirmDelete.id);
    setDeleteErr(null);
    try {
      const recRes = await fetch(`/api/meetings/${confirmDelete.id}/recording`, { method: 'DELETE' });
      if (!recRes.ok && recRes.status !== 404) {
        const d = await recRes.json().catch(() => ({}));
        setDeleteErr(d.error || t('archive.deleteFailed'));
        return;
      }
      const res = await fetch('/api/meetings/' + confirmDelete.id, { method: 'DELETE' });
      if (res.ok) {
        setMeetings(prev => prev.filter(m => m.id !== confirmDelete.id));
        closeConfirm();
      } else {
        const d = await res.json().catch(() => ({}));
        setDeleteErr(d.error || t('archive.deleteFailed'));
      }
    } catch (e) {
      console.error(e);
      setDeleteErr(t('archive.deleteFailed'));
    } finally {
      setDeletingId(null);
    }
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch('/api/meetings?status=ended')
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled) {
          setMeetings(Array.isArray(data) ? data : data.meetings ?? []);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const filtered = useMemo(() => {
    let list = meetings;

    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter((m) => m.title.toLowerCase().includes(q));
    }

    if (filter === 'recurring') {
      list = list.filter((m) => m.recurrence);
    }

    return list;
  }, [meetings, search, filter]);

  const groups = useMemo(() => groupByDay(filtered, locale, tz), [filtered, locale, tz]);

  return (
    <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
      <div className='page-container' style={{ maxWidth: 1100, margin: '0 auto' }}>
        {/* Header */}
        <div style={{ marginBottom: 24 }}>
          <h1
            style={{
              fontSize: 24,
              fontWeight: 700,
              letterSpacing: '-0.02em',
              margin: '0 0 6px',
            }}
          >
            {t('archive.title')}
          </h1>
          <p style={{ margin: 0, color: 'var(--muted)', fontSize: 14, lineHeight: 1.5 }}>
            {t('archive.subtitle')}
          </p>
        </div>

        {/* Search + Filter */}
        <div className='archive-filter-bar' style={{ display: 'flex', gap: 12, marginBottom: 24, alignItems: 'center' }}>
          {/* Search input */}
          <div
            className="field"
            style={{
              flex: 1,
              minWidth: 240,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              position: 'relative',
            }}
          >
            <Search size={15} style={{ color: 'var(--muted)', flexShrink: 0 }} />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('archive.searchPlaceholder')}
              style={{
                flex: 1,
                background: 'transparent',
                border: 'none',
                outline: 'none',
                color: 'var(--text)',
                fontSize: 14,
              }}
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                aria-label={t('common.clear')}
                className="btn-icon"
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: 'var(--muted)',
                  padding: 4,
                  display: 'flex',
                  alignItems: 'center',
                  borderRadius: 6,
                }}
              >
                <X size={14} />
              </button>
            )}
          </div>

          {/* Segmented filter */}
          <div
            style={{
              display: 'flex',
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 10,
              padding: 3,
              gap: 2,
            }}
          >
            {FILTER_TABS.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setFilter(tab.key)}
                style={{
                  padding: '6px 14px',
                  fontSize: 13,
                  fontWeight: filter === tab.key ? 600 : 400,
                  borderRadius: 8,
                  border: 'none',
                  cursor: 'pointer',
                  transition: 'all .15s',
                  background: filter === tab.key ? 'var(--surface-2)' : 'transparent',
                  color: filter === tab.key ? 'var(--text)' : 'var(--muted)',
                  boxShadow: filter === tab.key ? '0 1px 3px rgba(0,0,0,.12)' : 'none',
                }}
              >
                {t(tab.labelKey)}
              </button>
            ))}
          </div>
        </div>

        {/* Loading */}
        {loading && (
          <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--muted)' }}>
            <RefreshCw
              size={24}
              style={{ animation: 'spin 1s linear infinite', marginBottom: 12, opacity: 0.5 }}
            />
            <div style={{ fontSize: 14 }}>{t('common.loading')}</div>
            <style>{`@keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }`}</style>
          </div>
        )}

        {/* Empty state */}
        {!loading && groups.length === 0 && (
          <div
            className="card"
            style={{
              textAlign: 'center',
              padding: '60px 40px',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 12,
            }}
          >
            <Search size={48} style={{ color: 'var(--muted)', opacity: 0.3 }} />
            <div style={{ fontSize: 16, fontWeight: 600 }}>
              {search.trim() ? t('archive.emptySearchTitle') : t('archive.emptyTitle')}
            </div>
            <div style={{ color: 'var(--muted)', fontSize: 14, maxWidth: 360 }}>
              {search.trim()
                ? t('archive.emptySearchDesc', { query: search })
                : t('archive.emptyDesc')}
            </div>
          </div>
        )}

        {/* Delete confirm modal */}
        {confirmDelete && (
          <div style={{
            position: 'fixed', inset: 0, background: 'var(--overlay)', zIndex: 1000,
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
          }} onClick={closeConfirm}>
            <div className="card" style={{ maxWidth: 420, width: '100%', padding: '28px 24px' }}
              onClick={e => e.stopPropagation()}>
              <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>
                {recBlocked ? t('archive.deleteHasRecordingTitle') : t('archive.deleteConfirmTitle')}
              </div>
              <div style={{ color: 'var(--text-2)', fontSize: 14, marginBottom: deleteErr ? 12 : 20, lineHeight: 1.5 }}>
                {recBlocked
                  ? t('archive.deleteHasRecordingBody', { title: confirmDelete.title })
                  : t('archive.deleteConfirmBody', { title: confirmDelete.title })}
              </div>
              {deleteErr && (
                <div style={{ color: 'var(--danger-fg)', fontSize: 13, marginBottom: 18, lineHeight: 1.5 }}>{deleteErr}</div>
              )}
              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
                <button className="btn" onClick={closeConfirm}>{t('common.cancel')}</button>
                <button className="btn" onClick={recBlocked ? handleDeleteWithRecording : handleDelete} disabled={!!deletingId}
                  style={{ background: 'color-mix(in oklab, var(--red) 22%, var(--surface))', color: 'var(--danger-fg)', borderColor: 'color-mix(in oklab, var(--red) 40%, var(--border))' }}>
                  <Trash2 size={14} /> {deletingId ? t('archive.deleting') : (recBlocked ? t('archive.deleteWithRecording') : t('common.delete'))}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Results grouped by day */}
        {!loading &&
          groups.map((group, gi) => (
            <div key={gi} style={{ marginBottom: 28 }}>
              {/* Day header */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  marginBottom: 12,
                }}
              >
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: 'var(--text-2)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {group.label}
                </span>
                <div
                  style={{
                    flex: 1,
                    height: 1,
                    background: 'var(--border)',
                  }}
                />
                <span
                  style={{
                    fontSize: 11.5,
                    color: 'var(--muted)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {t('common.meetings', { count: group.meetings.length })}
                </span>
              </div>

              {/* Meeting rows */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {group.meetings.map((m) => (
                  <MeetingRow key={m.id} meeting={m} searchQuery={search} isAdmin={isAdmin} onDelete={() => { setRecBlocked(false); setDeleteErr(null); setConfirmDelete(m); }} mobile={isMobile} tz={tz} />
                ))}
              </div>
            </div>
          ))}
      </div>
    </div>
  );
}

function MeetingRow({ meeting, searchQuery, isAdmin, onDelete, mobile, tz }: { meeting: Meeting; searchQuery: string; isAdmin: boolean; onDelete: () => void; mobile?: boolean; tz: string }) {
  const t = useTranslations();
  const [hovered, setHovered] = useState(false);
  const start = meeting.scheduledAt ? new Date(meeting.scheduledAt) : null;
  const end = start ? new Date(start.getTime() + meeting.durationMin * 60000) : null;
  const users = getUsers(meeting);
  const hasReport = meeting.reports && meeting.reports.length > 0;
  const matches = meeting.transcriptMatches;
  const hasTranscriptMatches = matches && matches.length > 0;
  const totalSnippets = hasTranscriptMatches
    ? matches.reduce((sum, tm) => sum + tm.snippets.length, 0)
    : 0;

  return (
    <Link
      href={`/meetings/${meeting.id}/report`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '12px 14px',
        background: hovered ? 'var(--surface-2)' : 'transparent',
        border: '1px solid',
        borderColor: hovered ? 'var(--border-2)' : 'var(--border)',
        borderRadius: 12,
        transition: 'all .15s',
        textDecoration: 'none',
        color: 'inherit',
        cursor: 'pointer',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Time + duration — desktop: fixed left column; mobile: folded into the meta row */}
      {!mobile && (
        <>
          <div style={{ width: 52, textAlign: 'center', flexShrink: 0 }}>
            <div className="mono" style={{ fontSize: 13, fontWeight: 600 }}>
              {start ? fmtTime(start, tz) : '--:--'}
            </div>
            <div className="mono" style={{ fontSize: 10.5, color: 'var(--muted)' }}>
              {t('common.minutes', { count: meeting.durationMin })}
            </div>
          </div>
          <div style={{ width: 1, height: 36, background: 'var(--border)', flexShrink: 0 }} />
        </>
      )}

      {/* Title + chips + transcript matches */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
          <span
            style={{
              fontWeight: 600,
              fontSize: 14,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {meeting.title}
          </span>
          {meeting.recurrence && (
            <span
              className="chip"
              style={{ flexShrink: 0 }}
            >
              <RefreshCw size={10} /> {t('archive.recurringBadge')}
            </span>
          )}
          {hasReport && (
            <span
              className="chip"
              style={{
                flexShrink: 0,
                background: 'color-mix(in oklab, var(--accent-2) 15%, transparent)',
                borderColor: 'color-mix(in oklab, var(--accent-2) 30%, transparent)',
                color: 'var(--accent-2)',
              }}
            >
              <Sparkles size={10} /> {t('archive.aiReportBadge')}
            </span>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--muted)', fontSize: 12, minWidth: 0, flexWrap: mobile ? 'wrap' : 'nowrap' }}>
          {mobile && (
            <>
              <span className="mono" style={{ flexShrink: 0 }}>{start ? fmtTime(start, tz) : '--:--'} · {t('common.minutes', { count: meeting.durationMin })}</span>
              <span style={{ flexShrink: 0 }}>&middot;</span>
            </>
          )}
          <span style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
            <Users size={12} />
            {t('common.participants', { count: users.length })}
          </span>
          <span style={{ flexShrink: 0 }}>&middot;</span>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{meeting.createdBy.name || 'Unknown'}</span>
        </div>

        {/* Transcript matches */}
        {hasTranscriptMatches && (
          <div style={{ marginTop: 8 }}>
            <div
              style={{
                fontSize: 11.5,
                color: 'var(--muted)',
                marginBottom: 4,
                fontWeight: 500,
              }}
            >
              {t('archive.foundInTranscript', { count: totalSnippets })}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 4 }}>
              {matches.map((tm) => (
                <span key={tm.language} className="lang-badge">
                  {tm.language}
                </span>
              ))}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              {matches.flatMap((tm) =>
                tm.snippets.slice(0, 2).map((snippet, si) => (
                  <div
                    key={`${tm.language}-${si}`}
                    style={{
                      fontSize: 12,
                      color: 'var(--text-2)',
                      lineHeight: 1.5,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      maxWidth: '100%',
                    }}
                  >
                    &ldquo;...{highlightMatch(snippet, searchQuery)}...&rdquo;
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>

      {/* Avatar stack (hidden on narrow screens — participant count is in the meta row) */}
      <div className="archive-row-avatars" style={{ flexShrink: 0 }}>
        <AvatarStack users={users} max={4} />
      </div>

      {/* Delete (admin only) */}
      {isAdmin && (
        <button
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onDelete(); }}
          className="btn btn-ghost btn-icon archive-del-btn"
          title={t('archive.deleteMeeting')}
          style={{
            width: 30, height: 30, flexShrink: 0, color: 'var(--muted)',
            opacity: hovered ? 1 : 0,
            transition: 'opacity .15s, color .15s',
          }}
          onMouseEnter={e => (e.currentTarget.style.color = '#fca5a5')}
          onMouseLeave={e => (e.currentTarget.style.color = 'var(--muted)')}
        >
          <Trash2 size={14} />
        </button>
      )}

      {/* Chevron */}
      <ChevronRight
        size={16}
        style={{
          color: 'var(--muted)',
          flexShrink: 0,
          opacity: hovered ? 1 : 0.5,
          transition: 'opacity .15s',
        }}
      />
    </Link>
  );
}
