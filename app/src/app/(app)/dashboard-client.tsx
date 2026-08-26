'use client';

import Link from 'next/link';
import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations, useLocale } from 'next-intl';
import { SetupChecklist } from './setup-checklist';
import { InstallAppCard } from '@/components/install-app-card';
import { MyQuizzesCard } from './my-quizzes-card';
import {
  Video, Sparkles, FileText, Users, Clock, RefreshCw, MoreHorizontal,
  Pencil, Trash2, X, Search, Send, Calendar as CalendarIcon, Save,
  ListChecks, Check, Plus, CheckCircle, Wand2, Loader2 as Loader2Icon,
} from 'lucide-react';
import { AvatarStack, Avatar } from '@/components/ui/avatar';
import { Select } from '@/components/ui/select';
import { fmtTime, fmtRelative, isToday, dayDiff, zonedHour, zonedFormFields, zonedWallTimeToUtcISO } from '@/lib/utils';

type Tr = ReturnType<typeof useTranslations>;

interface Meeting {
  id: string;
  title: string;
  scheduledAt: string | null;
  durationMin: number;
  status: string;
  description?: string | null;
  recurrence?: any;
  createdBy: { id: string; name: string | null; image: string | null };
  participants: {
    id?: string;
    userId?: string | null;
    user: { id: string; name: string | null; image: string | null } | null;
    guestName: string | null;
    role?: string;
  }[];
  reports?: { id: string }[];
  agenda?: string[] | null;
}

interface WsUser {
  id: string;
  name: string | null;
  email: string | null;
  image: string | null;
}

interface DashTask {
  id: string;
  title: string;
  priority: string;
  status: string;
  dueDate: string | null;
  source?: string;
  meetingId: string;
  assignee: { id: string; name: string | null; image: string | null } | null;
  meeting?: { id: string; title: string; scheduledAt: string | null };
}

// Short "time until" label for the mobile next-meeting hero. `nowMs` is the
// server request time (passed through) so SSR and hydration agree — using
// Date.now() here would differ between the two renders and trip a #418.
function untilLabel(d: string | null, tr: Tr, nowMs: number): string | null {
  if (!d) return null;
  const diff = new Date(d).getTime() - nowMs;
  if (diff <= 60_000) return tr('dashboard.now');
  const mins = Math.round(diff / 60_000);
  if (mins < 60) return tr('dashboard.inMinutes', { count: mins });
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) {
    const rem = mins % 60;
    return rem
      ? tr('dashboard.inHoursMinutes', { hours: hrs, minutes: rem })
      : tr('dashboard.inHours', { hours: hrs });
  }
  return null; // farther out — the date line covers it
}

function dueLabel(d: string | null, locale: string, tr: Tr, tz: string, nowMs: number): { txt: string; overdue: boolean; soon: boolean } | null {
  if (!d) return null;
  const diff = dayDiff(new Date(d), tz, new Date(nowMs));
  if (diff === 0) return { txt: tr('common.today'), overdue: false, soon: true };
  if (diff === 1) return { txt: tr('common.tomorrow'), overdue: false, soon: true };
  if (diff < 0) return { txt: tr('dashboard.overdueDays', { count: -diff }), overdue: true, soon: false };
  if (diff < 7) return { txt: new Date(d).toLocaleDateString(locale, { weekday: 'short', timeZone: tz }), overdue: false, soon: diff < 3 };
  return { txt: new Date(d).toLocaleDateString(locale, { day: 'numeric', month: 'short', timeZone: tz }), overdue: false, soon: false };
}

export function DashboardClient({
  userName,
  tz,
  nowMs,
  upcoming: initialUpcoming,
  past: initialPast,
  myTasks: initialMyTasks,
}: {
  userName?: string | null;
  tz: string;
  nowMs: number;
  upcoming: Meeting[];
  past: Meeting[];
  myTasks: DashTask[];
}) {
  const router = useRouter();
  const tr = useTranslations();
  const locale = useLocale();
  // Pinned to the server request instant + workspace zone so every date/time
  // below renders identically on the server and on hydration (no #418).
  const now = new Date(nowMs);
  const [upcoming, setUpcoming] = useState(initialUpcoming);
  const [past, setPast] = useState(initialPast);
  const [myTasks, setMyTasks] = useState(initialMyTasks);
  const overdueCount = myTasks.filter(t => dueLabel(t.dueDate, locale, tr, tz, nowMs)?.overdue).length;
  const hour = zonedHour(now, tz);
  const greetingText = tr(
    `dashboard.${hour < 5 ? 'greetingNight' : hour < 12 ? 'greetingMorning' : hour < 18 ? 'greetingAfternoon' : 'greetingEvening'}`
  );
  const [editMeeting, setEditMeeting] = useState<Meeting | null>(null);
  const [deleteMeeting, setDeleteMeeting] = useState<Meeting | null>(null);
  const [menuOpen, setMenuOpen] = useState<string | null>(null);

  const getParticipantNames = (m: Meeting) =>
    m.participants.map((p) => ({
      name: p.user?.name || p.guestName || 'Guest',
      image: p.user?.image || null,
    }));

  // Hide a meeting once its scheduled END time (scheduledAt + duration) has
  // passed — e.g. a 13:00–13:45 meeting disappears as "next" right after 13:45.
  // An overdue `scheduled` meeting that never started must not surface as next.
  // `live` (in progress) and untimed meetings always stay.
  const stillUpcoming = (m: Meeting) =>
    m.status === 'live' ||
    !m.scheduledAt ||
    new Date(m.scheduledAt).getTime() + (m.durationMin || 60) * 60_000 >= nowMs;
  const visibleUpcoming = upcoming.filter(stillUpcoming);

  const today = visibleUpcoming.filter(
    (m) => m.scheduledAt && isToday(new Date(m.scheduledAt), tz, now)
  );
  const later = visibleUpcoming.filter(
    (m) => !m.scheduledAt || !isToday(new Date(m.scheduledAt), tz, now)
  );

  const nextMeeting = today[0] || visibleUpcoming[0];

  const handleDelete = async () => {
    if (!deleteMeeting) return;
    try {
      const res = await fetch(`/api/meetings/${deleteMeeting.id}`, { method: 'DELETE' });
      if (res.ok) {
        setUpcoming(prev => prev.filter(m => m.id !== deleteMeeting.id));
        setPast(prev => prev.filter(m => m.id !== deleteMeeting.id));
        setDeleteMeeting(null);
      }
    } catch (e) { console.error(e); }
  };

  const handleEditSave = async (updated: Meeting) => {
    setUpcoming(prev => prev.map(m => m.id === updated.id ? { ...m, ...updated } : m));
    setPast(prev => prev.map(m => m.id === updated.id ? { ...m, ...updated } : m));
    setEditMeeting(null);
    router.refresh();
  };

  return (
    <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
      <div className='page-container' style={{ maxWidth: 1100, margin: '0 auto' }}>
        <SetupChecklist />
        <InstallAppCard />
        {/* ── Mobile-redesigned top: greeting + next-meeting hero + quick actions ── */}
        <div className="dash-mobile-top">
          {/* Greeting */}
          <div style={{ marginBottom: 18 }}>
            <h1 style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.02em', margin: 0 }}>
              {greetingText}{userName ? `, ${userName.split(' ')[0]}` : ''}
            </h1>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 3, textTransform: 'capitalize' }}>
              {now.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long', timeZone: tz })}
            </div>
          </div>

          {/* Next meeting */}
          {nextMeeting ? (
            <div className="card" style={{
              position: 'relative', overflow: 'hidden', padding: 20, marginBottom: 14,
              display: 'flex', flexDirection: 'column', gap: 14,
              background: 'linear-gradient(160deg, color-mix(in oklab, var(--accent) 20%, var(--surface)) 0%, var(--surface) 72%)',
              borderColor: 'color-mix(in oklab, var(--accent) 34%, var(--border))',
            }}>
              <div aria-hidden style={{ position: 'absolute', top: -50, right: -40, width: 150, height: 150, borderRadius: '50%', background: 'color-mix(in oklab, var(--accent) 26%, transparent)', filter: 'blur(55px)', pointerEvents: 'none' }} />
              <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                <span className="chip" style={{ background: 'color-mix(in oklab, var(--accent) 22%, transparent)', borderColor: 'color-mix(in oklab, var(--accent) 45%, transparent)', color: 'var(--info-fg)' }}>
                  <Sparkles size={11} /> {tr('dashboard.next')}
                </span>
                {untilLabel(nextMeeting.scheduledAt, tr, nowMs) && (
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--accent)' }}>{untilLabel(nextMeeting.scheduledAt, tr, nowMs)}</span>
                )}
              </div>
              <div style={{ position: 'relative' }}>
                <div style={{ fontSize: 21, fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1.2, marginBottom: 6 }}>{nextMeeting.title}</div>
                {nextMeeting.scheduledAt && (
                  <div style={{ color: 'var(--text-2)', fontSize: 13 }}>
                    {fmtRelative(new Date(nextMeeting.scheduledAt), locale, tz, now)} · {fmtTime(new Date(nextMeeting.scheduledAt), tz)} · {tr('common.minutes', { count: nextMeeting.durationMin })}
                  </div>
                )}
              </div>
              <div style={{ position: 'relative' }}>
                <AvatarStack users={getParticipantNames(nextMeeting)} max={5} size="md" />
              </div>
              <Link href={`/lobby/${nextMeeting.id}`} className="btn btn-primary" style={{ position: 'relative', textDecoration: 'none', width: '100%', justifyContent: 'center', padding: '14px', fontWeight: 600, gap: 8 }}>
                <Video size={16} /> {tr('common.join')}
              </Link>
            </div>
          ) : (
            <div className="card" style={{ padding: 24, marginBottom: 14, display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 10 }}>
              <div style={{ width: 52, height: 52, borderRadius: 16, background: 'color-mix(in oklab, var(--accent) 14%, transparent)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <CalendarIcon size={24} style={{ color: 'var(--accent)' }} />
              </div>
              <div style={{ fontSize: 15, fontWeight: 600 }}>{tr('dashboard.noMeetingsToday')}</div>
              <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.5 }}>{tr('dashboard.noMeetingsTodayHint')}</div>
              <Link href="/schedule" className="btn btn-primary" style={{ textDecoration: 'none', width: '100%', justifyContent: 'center', padding: '13px', marginTop: 4, gap: 8 }}>
                <Plus size={15} /> {tr('dashboard.scheduleMeeting')}
              </Link>
            </div>
          )}

          {/* Quick actions — start now or schedule */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 24 }}>
            <Link href="/lobby/quick" className="card" style={{ textDecoration: 'none', color: 'inherit', padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ width: 38, height: 38, borderRadius: 11, background: 'color-mix(in oklab, var(--accent) 14%, transparent)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Video size={18} style={{ color: 'var(--accent)' }} />
              </div>
              <span style={{ fontSize: 13.5, fontWeight: 600 }}>{tr('sidebar.quickMeeting')}</span>
            </Link>
            <Link href="/schedule" className="card" style={{ textDecoration: 'none', color: 'inherit', padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={{ width: 38, height: 38, borderRadius: 11, background: 'color-mix(in oklab, var(--green) 14%, transparent)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Plus size={18} style={{ color: 'var(--green)' }} />
              </div>
              <span style={{ fontSize: 13.5, fontWeight: 600 }}>{tr('dashboard.scheduleMeeting')}</span>
            </Link>
          </div>
        </div>

        {/* ── Desktop top: original hero (unchanged) ── */}
        <div className="dash-desktop-top">
          <div className='dash-hero' style={{ display: 'grid', gap: 18, marginBottom: 24 }}>
            <div
              className="card"
              style={{
                padding: 24,
                background:
                  'linear-gradient(135deg, color-mix(in oklab, var(--accent) 14%, var(--surface)) 0%, var(--surface) 60%)',
                borderColor: 'color-mix(in oklab, var(--accent) 30%, var(--border))',
                display: 'flex',
                flexDirection: 'column',
                gap: 14,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span
                  className="chip"
                  style={{
                    background: 'color-mix(in oklab, var(--accent) 18%, transparent)',
                    borderColor: 'color-mix(in oklab, var(--accent) 40%, transparent)',
                    color: 'var(--info-fg)',
                  }}
                >
                  <Sparkles size={11} /> {tr('dashboard.nextMeeting')}
                </span>
              </div>
              {nextMeeting ? (
                <>
                  <div>
                    <div style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-0.02em', marginBottom: 6 }}>
                      {nextMeeting.title}
                    </div>
                    {nextMeeting.scheduledAt && (
                      <div style={{ color: 'var(--text-2)', fontSize: 13.5 }}>
                        {fmtRelative(new Date(nextMeeting.scheduledAt), locale, tz, now)} &bull;{' '}
                        {fmtTime(new Date(nextMeeting.scheduledAt), tz)} &bull; {tr('common.minutes', { count: nextMeeting.durationMin })}
                      </div>
                    )}
                  </div>
                  {nextMeeting.description && (
                    <div style={{ color: 'var(--text-2)', fontSize: 13.5, lineHeight: 1.55 }}>
                      {nextMeeting.description}
                    </div>
                  )}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 }}>
                    <AvatarStack users={getParticipantNames(nextMeeting)} max={6} size="md" />
                    <div style={{ display: 'flex', gap: 8 }}>
                      <Link href={`/lobby/${nextMeeting.id}`} className="btn btn-primary" style={{ textDecoration: 'none' }}>
                        <Video size={15} /> {tr('common.join')}
                      </Link>
                    </div>
                  </div>
                </>
              ) : (
                <div style={{ color: 'var(--muted)', padding: '20px 0' }}>{tr('dashboard.noMeetingsTodayDesktop')}</div>
              )}
            </div>
          </div>
        </div>

        {/* My Tasks */}
        <Section title={tr('dashboard.myTasks')} right={
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {overdueCount > 0 && (
              <span style={{ fontSize: 10.5, padding: '2px 6px', borderRadius: 5,
                background: 'color-mix(in oklab, var(--red) 18%, transparent)', color: 'var(--danger-fg)', fontWeight: 600 }}>
                {tr('dashboard.overdue', { count: overdueCount })}
              </span>
            )}
            <Link href="/tasks" className="btn btn-ghost btn-sm" style={{ textDecoration: 'none', color: 'var(--muted)' }}>
              {tr('dashboard.all')} &rarr;
            </Link>
          </div>
        }>
          {myTasks.length === 0 ? (
            <div className="card" style={{ padding: 24, display: 'flex', alignItems: 'center', gap: 12, color: 'var(--muted)', fontSize: 13.5 }}>
              <CheckCircle size={20} style={{ color: 'var(--green)' }} />
              {tr('dashboard.noTasks')}
            </div>
          ) : (
            <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
              {myTasks.slice(0, 5).map((t, i) => {
                const due = dueLabel(t.dueDate, locale, tr, tz, nowMs);
                const isOverdue = due?.overdue;
                return (
                  <Link key={t.id} href="/tasks" style={{
                    display: 'flex', alignItems: 'center', gap: 12, padding: '11px 16px',
                    borderBottom: i === Math.min(4, myTasks.length - 1) ? 'none' : '1px solid var(--border)',
                    borderLeft: isOverdue ? '3px solid var(--red)' : '3px solid transparent',
                    paddingLeft: isOverdue ? 13 : 16,
                    textDecoration: 'none', color: 'inherit', transition: 'background .15s',
                  }}
                    onMouseEnter={(e: any) => (e.currentTarget.style.background = 'var(--surface-2, #2a2a32)')}
                    onMouseLeave={(e: any) => (e.currentTarget.style.background = 'transparent')}
                  >
                    <span style={{
                      width: 18, height: 18, borderRadius: 5, flexShrink: 0,
                      border: `1.5px solid ${t.status === 'in_progress' ? 'var(--amber)' : 'var(--border)'}`,
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      {t.status === 'in_progress' && <span style={{ width: 7, height: 7, borderRadius: 2, background: 'var(--amber)' }} />}
                    </span>
                    <span style={{
                      width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                      background: t.priority === 'high' ? 'var(--red)' : t.priority === 'medium' ? 'var(--amber)' : 'var(--muted)',
                    }} />
                    {t.source === 'ai' && <Sparkles size={11} style={{ color: 'var(--accent)', flexShrink: 0 }} />}
                    <span style={{ flex: 1, minWidth: 0, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
                    {due && (
                      <span style={{
                        fontSize: 11.5, padding: '2px 7px', borderRadius: 5, fontWeight: isOverdue ? 600 : 500,
                        background: isOverdue ? 'color-mix(in oklab, var(--red) 18%, transparent)' : 'transparent',
                        color: isOverdue ? '#fca5a5' : due.soon ? '#fcd34d' : 'var(--muted)',
                      }}>{due.txt}</span>
                    )}
                  </Link>
                );
              })}
              {myTasks.length > 5 && (
                <Link href="/tasks" style={{
                  display: 'block', padding: '10px 16px', background: 'var(--surface-2, #2a2a32)',
                  textDecoration: 'none', color: 'var(--muted)', fontSize: 12.5, textAlign: 'center',
                }}>
                  {tr('dashboard.moreTasks', { count: myTasks.length - 5 })} &rarr;
                </Link>
              )}
            </div>
          )}
        </Section>

        <MyQuizzesCard />

        {/* Today */}
        {today.length > 0 && (
          <Section title={tr('dashboard.today')} right={tr('common.meetings', { count: today.length })}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {today.map((m) => (
                <MeetingRow key={m.id} meeting={m} users={getParticipantNames(m)} tz={tz}
                  menuOpen={menuOpen} setMenuOpen={setMenuOpen}
                  onEdit={() => setEditMeeting(m)} onDelete={() => setDeleteMeeting(m)} />
              ))}
            </div>
          </Section>
        )}

        {/* Upcoming */}
        {later.length > 0 && (
          <Section title={tr('dashboard.upcoming')}>
            <div className='dash-upcoming-grid' style={{ display: 'grid', gap: 14 }}>
              {later.slice(0, 4).map((m) => (
                <MeetingCard key={m.id} meeting={m} users={getParticipantNames(m)} tz={tz} now={now}
                  menuOpen={menuOpen} setMenuOpen={setMenuOpen}
                  onEdit={() => setEditMeeting(m)} onDelete={() => setDeleteMeeting(m)} />
              ))}
            </div>
          </Section>
        )}

        {/* Recent reports */}
        {past.length > 0 && (
          <Section
            title={tr('dashboard.recentReports')}
            right={
              <Link href="/archive" className="btn btn-ghost btn-sm" style={{ textDecoration: 'none' }}>
                {tr('nav.archive')} &rarr;
              </Link>
            }
          >
            <div className='dash-reports-grid' style={{ display: 'grid', gap: 14 }}>
              {past.slice(0, 3).map((m) => (
                <Link
                  key={m.id}
                  href={`/meetings/${m.id}/report`}
                  className="card"
                  style={{
                    textAlign: 'left',
                    cursor: 'pointer',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 10,
                    textDecoration: 'none',
                    color: 'inherit',
                    transition: 'all .15s',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--muted)', fontSize: 11.5 }}>
                    <Sparkles size={12} style={{ color: 'var(--accent-2)' }} />
                    <span className="mono">
                      {m.scheduledAt ? fmtRelative(new Date(m.scheduledAt), locale, tz, now) : ''}
                    </span>
                  </div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{m.title}</div>
                  <AvatarStack users={getParticipantNames(m)} max={5} />
                </Link>
              ))}
            </div>
          </Section>
        )}

        {/* Empty state */}
        {upcoming.length === 0 && past.length === 0 && (
          <div className="card" style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '18px 22px' }}>
            <div style={{ width: 40, height: 40, borderRadius: 10, background: 'color-mix(in oklab, var(--accent) 12%, transparent)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <Video size={18} style={{ color: 'var(--accent)' }} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 2 }}>{tr('dashboard.welcomeTitle')}</div>
              <div style={{ color: 'var(--muted)', fontSize: 12.5 }}>{tr('dashboard.welcomeDesc')}</div>
            </div>
            <Link href="/schedule" className="btn btn-primary btn-sm" style={{ textDecoration: 'none', flexShrink: 0 }}>
              <Video size={13} /> {tr('dashboard.createMeeting')}
            </Link>
          </div>
        )}
      </div>

      {/* Edit Modal */}
      {editMeeting && (
        <EditMeetingModal meeting={editMeeting} tz={tz} onClose={() => setEditMeeting(null)} onSave={handleEditSave} />
      )}

      {/* Delete Confirm */}
      {deleteMeeting && (
        <div style={{
          position: 'fixed', inset: 0, background: 'var(--overlay)', zIndex: 1000,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
        }} onClick={() => setDeleteMeeting(null)}>
          <div className="card" style={{ maxWidth: 420, width: '100%', padding: '28px 24px' }}
            onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>{tr('dashboard.deleteMeetingTitle')}</div>
            <div style={{ color: 'var(--text-2)', fontSize: 14, marginBottom: 20, lineHeight: 1.5 }}>
              {tr('dashboard.deleteMeetingDesc', { title: deleteMeeting.title })}
            </div>
            <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setDeleteMeeting(null)}>{tr('common.cancel')}</button>
              <button className="btn" onClick={handleDelete}
                style={{ background: 'color-mix(in oklab, var(--red) 22%, var(--surface))', color: 'var(--danger-fg)', borderColor: 'color-mix(in oklab, var(--red) 40%, var(--border))' }}>
                <Trash2 size={14} /> {tr('common.delete')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Edit Meeting Modal ─────────────────────── */

function EditMeetingModal({ meeting, tz, onClose, onSave }: {
  meeting: Meeting;
  tz: string;
  onClose: () => void;
  onSave: (m: Meeting) => void;
}) {
  const t = useTranslations();
  const schedAt = meeting.scheduledAt ? new Date(meeting.scheduledAt) : null;
  // Render the date/time inputs as workspace-local wall-clock (not the browser's
  // zone), so editing doesn't silently shift the meeting time across zones.
  const initFields = schedAt ? zonedFormFields(schedAt, tz) : null;
  const [title, setTitle] = useState(meeting.title);
  const [description, setDescription] = useState(meeting.description || '');
  const [date, setDate] = useState(initFields?.date ?? '');
  const [time, setTime] = useState(initFields?.time ?? '14:00');
  const [duration, setDuration] = useState(meeting.durationMin);
  const [saving, setSaving] = useState(false);
  const [agenda, setAgenda] = useState<string[]>(Array.isArray(meeting.agenda) ? meeting.agenda : []);
  const [newAgendaItem, setNewAgendaItem] = useState('');
  const [aiAgendaLoading, setAiAgendaLoading] = useState(false);

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
        // Pre-select current participants (non-host)
        const participantUserIds = meeting.participants
          .filter(p => p.role !== 'host' && p.user)
          .map(p => p.user!.id);
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

  const hostId = meeting.createdBy.id;
  const filteredUsers = allUsers.filter(u => {
    if (u.id === hostId) return false;
    if (selectedUsers.some(s => s.id === u.id)) return false;
    if (!userSearch.trim()) return true;
    const q = userSearch.toLowerCase();
    return (u.name?.toLowerCase().includes(q) || u.email?.toLowerCase().includes(q));
  });

  const save = async () => {
    if (!title.trim()) return;
    setSaving(true);
    try {
      const scheduledAt = date && time ? zonedWallTimeToUtcISO(date, time, tz) : null;
      const res = await fetch(`/api/meetings/${meeting.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          description: description || null,
          scheduledAt,
          durationMin: duration,
          participants: selectedUsers.map(u => ({ userId: u.id })),
          agenda: agenda.length > 0 ? agenda : null,
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
      position: 'fixed', inset: 0, background: 'var(--overlay)', zIndex: 1000,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      overflowY: 'auto',
    }} onClick={onClose}>
      <div className="card" style={{ maxWidth: 560, width: '100%', padding: '24px 22px', maxHeight: '90vh', overflowY: 'auto' }}
        onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
          <div style={{ fontSize: 18, fontWeight: 700 }}>{t('dashboard.editMeeting')}</div>
          <button className="btn btn-ghost btn-icon" aria-label={t('common.close')} onClick={onClose}><X size={16} /></button>
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
                <ListChecks size={11} /> {t('meetingForm.agenda')} ({agenda.length})
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
                {aiAgendaLoading ? <Loader2Icon size={11} style={{ animation: 'spin 1s linear infinite' }} /> : <Wand2 size={11} />}
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
              <label className="field-label"><CalendarIcon size={11} /> {t('meetingForm.date')}</label>
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
            <label className="field-label"><Users size={11} /> {t('meetingForm.participants')} ({selectedUsers.length + 1})</label>

            {/* Host */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '6px 8px',
              background: 'var(--surface)', borderRadius: 8, marginBottom: 6, marginTop: 6,
            }}>
              <Avatar name={meeting.createdBy.name || 'U'} image={meeting.createdBy.image} size="sm" />
              <div style={{ flex: 1, fontSize: 13, fontWeight: 500 }}>{meeting.createdBy.name}</div>
              <span className="chip" style={{ fontSize: 10 }}>{t('common.host')}</span>
            </div>

            {selectedUsers.map(u => (
              <div key={u.id} style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '6px 8px',
                background: 'var(--surface)', borderRadius: 8, marginBottom: 4,
              }}>
                <Avatar name={u.name || 'U'} image={u.image} size="sm" />
                <div style={{ flex: 1, fontSize: 13 }}>{u.name}</div>
                <button className="btn btn-ghost btn-icon" style={{ width: 24, height: 24 }}
                  aria-label={t('common.delete')}
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

/* ── Context Menu ─────────────────────────────── */

function MeetingMenu({ meetingId, menuOpen, setMenuOpen, onEdit, onDelete }: {
  meetingId: string;
  menuOpen: string | null;
  setMenuOpen: (id: string | null) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations();
  const ref = useRef<HTMLDivElement>(null);
  const isOpen = menuOpen === meetingId;

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setMenuOpen(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isOpen, setMenuOpen]);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button className="btn btn-ghost btn-icon" style={{ width: 30, height: 30 }}
        aria-label={t('common.options')}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setMenuOpen(isOpen ? null : meetingId); }}>
        <MoreHorizontal size={15} />
      </button>
      {isOpen && (
        <div style={{
          position: 'absolute', right: 0, top: '100%', marginTop: 4, zIndex: 50,
          background: 'var(--surface-2)', border: '1px solid var(--border)',
          borderRadius: 10, minWidth: 160, overflow: 'hidden',
          boxShadow: '0 8px 24px rgba(0,0,0,.3)',
        }}>
          <button onClick={(e) => { e.preventDefault(); e.stopPropagation(); setMenuOpen(null); onEdit(); }}
            style={{
              width: '100%', display: 'flex', alignItems: 'center', gap: 8,
              padding: '10px 14px', background: 'transparent', border: 'none',
              cursor: 'pointer', color: 'var(--text)', fontSize: 13, textAlign: 'left',
            }}
            onMouseEnter={e => (e.currentTarget.style.background = 'var(--surface-3)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            <Pencil size={13} /> {t('common.edit')}
          </button>
          <button onClick={(e) => { e.preventDefault(); e.stopPropagation(); setMenuOpen(null); onDelete(); }}
            style={{
              width: '100%', display: 'flex', alignItems: 'center', gap: 8,
              padding: '10px 14px', background: 'transparent', border: 'none',
              cursor: 'pointer', color: 'var(--danger-fg)', fontSize: 13, textAlign: 'left',
            }}
            onMouseEnter={e => (e.currentTarget.style.background = 'color-mix(in oklab, var(--red) 10%, transparent)')}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
          >
            <Trash2 size={13} /> {t('common.delete')}
          </button>
        </div>
      )}
    </div>
  );
}

/* ── Shared components ─────────────────────────── */

function Section({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 28 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, margin: 0, letterSpacing: '-0.005em' }}>{title}</h2>
        {right && (typeof right === 'string' ? <span style={{ fontSize: 12, color: 'var(--muted)' }}>{right}</span> : right)}
      </div>
      {children}
    </section>
  );
}

function MeetingRow({ meeting, users, tz, menuOpen, setMenuOpen, onEdit, onDelete }: {
  meeting: Meeting;
  users: { name: string; image: string | null }[];
  tz: string;
  menuOpen: string | null;
  setMenuOpen: (id: string | null) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations();
  const start = meeting.scheduledAt ? new Date(meeting.scheduledAt) : null;
  return (
    <div
      style={{
        width: '100%',
        textAlign: 'left',
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '12px 14px',
        background: 'transparent',
        border: '1px solid var(--border)',
        borderRadius: 12,
        transition: 'all .15s',
        color: 'inherit',
      }}
    >
      <div style={{ width: 46, textAlign: 'center' }}>
        <div className="mono" style={{ fontSize: 13, fontWeight: 600 }}>
          {start ? fmtTime(start, tz) : '--:--'}
        </div>
        <div className="mono" style={{ fontSize: 10.5, color: 'var(--muted)' }}>
          {t('common.minutes', { count: meeting.durationMin })}
        </div>
      </div>
      <div style={{ width: 1, height: 32, background: 'var(--border)' }} />
      <Link href={`/lobby/${meeting.id}`} style={{ flex: 1, minWidth: 0, textDecoration: 'none', color: 'inherit' }}>
        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {meeting.title}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--muted)', fontSize: 12 }}>
          <span>{t('common.participants', { count: users.length })}</span>
        </div>
      </Link>
      <AvatarStack users={users} max={3} />
      <Link href={`/lobby/${meeting.id}`} className="btn btn-sm btn-primary" style={{ textDecoration: 'none', flexShrink: 0 }}>
        <Video size={13} />
      </Link>
      {meeting.status !== 'ended' && (
        <MeetingMenu meetingId={meeting.id} menuOpen={menuOpen} setMenuOpen={setMenuOpen}
          onEdit={onEdit} onDelete={onDelete} />
      )}
    </div>
  );
}

function MeetingCard({ meeting, users, tz, now, menuOpen, setMenuOpen, onEdit, onDelete }: {
  meeting: Meeting;
  users: { name: string; image: string | null }[];
  tz: string;
  now: Date;
  menuOpen: string | null;
  setMenuOpen: (id: string | null) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations();
  const locale = useLocale();
  const start = meeting.scheduledAt ? new Date(meeting.scheduledAt) : null;
  const end = start ? new Date(start.getTime() + meeting.durationMin * 60000) : null;

  return (
    <div className="card" style={{ padding: 18, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span className="mono" style={{ color: 'var(--muted)', fontSize: 11.5 }}>
              {start ? `${fmtTime(start, tz)}–${end ? fmtTime(end, tz) : ''}` : ''}
            </span>
            {meeting.recurrence && (
              <span className="chip">
                <RefreshCw size={11} /> {t('dashboard.weekly')}
              </span>
            )}
          </div>
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>{meeting.title}</div>
          <div style={{ fontSize: 13, color: 'var(--muted)' }}>
            {start ? fmtRelative(start, locale, tz, now) : ''} &bull; {t('common.minutes', { count: meeting.durationMin })}
          </div>
        </div>
        {meeting.status !== 'ended' && (
          <MeetingMenu meetingId={meeting.id} menuOpen={menuOpen} setMenuOpen={setMenuOpen}
            onEdit={onEdit} onDelete={onDelete} />
        )}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <AvatarStack users={users} max={5} />
        <Link href={`/lobby/${meeting.id}`} className="btn btn-sm btn-primary" style={{ textDecoration: 'none' }}>
          <Video size={13} /> {t('common.join')}
        </Link>
      </div>
    </div>
  );
}
