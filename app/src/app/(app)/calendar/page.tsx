'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { useSession } from 'next-auth/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronLeft, ChevronRight, Plus, RefreshCw, Building2 } from 'lucide-react';
import { useIsMobile } from '@/lib/use-is-mobile';
import { Select } from '@/components/ui/select';
import type { Meeting, CalTask } from './lib/types';
import { startOfWeek } from './lib/dates';
import { WeekView } from './components/WeekView';
import { MonthView } from './components/MonthView';
import { DayModal } from './components/DayModal';
import { MeetingDetailModal } from './components/MeetingDetailModal';
import { CalendarEditModal } from './components/CalendarEditModal';
import { AgendaView } from './components/AgendaView';

/* ------------------------------------------------------------------ */
/*  CalendarPage (default export)                                     */
/* ------------------------------------------------------------------ */

type ViewMode = 'week' | 'month';

export default function CalendarPage() {
  const router = useRouter();
  const t = useTranslations();
  const locale = useLocale();
  const isMobile = useIsMobile();
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [tasks, setTasks] = useState<CalTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<ViewMode>('week');
  const [cursor, setCursor] = useState<Date>(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  });
  const [modal, setModal] = useState<{ date: Date; meetings: Meeting[]; tasks: CalTask[] } | null>(null);
  const [selectedMeeting, setSelectedMeeting] = useState<Meeting | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [editMeeting, setEditMeeting] = useState<Meeting | null>(null);
  const { data: session } = useSession();
  const isAdmin = session?.user?.role === 'admin';
  const [departments, setDepartments] = useState<{ id: string; name: string; color: string | null; members: { userId: string }[] }[]>([]);
  const [filterDept, setFilterDept] = useState('all');

  // Recomputed at midnight, not once at mount. On a phone this view lives in a tab
  // for days, and a frozen `today` relabels everything after midnight: yesterday's
  // meetings keep saying "Today" and today's say "Tomorrow" — and, since the agenda
  // now starts at today, yesterday would refuse to leave the list.
  const [today, setToday] = useState<Date>(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  });

  useEffect(() => {
    const midnight = () => {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      // Only re-render when the day actually turned.
      setToday((prev) => (prev.getTime() === d.getTime() ? prev : d));
    };
    // A timer alone is not enough: a backgrounded mobile tab is frozen and the timer
    // fires late or not at all, so the day is also re-checked whenever the tab is
    // brought back — which is exactly when someone looks at it.
    const onVisible = () => { if (document.visibilityState === 'visible') midnight(); };
    document.addEventListener('visibilitychange', onVisible);

    const next = new Date();
    next.setHours(24, 0, 0, 0);
    let interval: ReturnType<typeof setInterval> | undefined;
    const timeout = setTimeout(() => {
      midnight();
      interval = setInterval(midnight, 86400000);
    }, next.getTime() - Date.now() + 1000);

    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      clearTimeout(timeout);
      if (interval) clearInterval(interval);
    };
  }, []);

  const weekStart = useMemo(() => startOfWeek(cursor), [cursor]);
  const currentYear = cursor.getFullYear();
  const currentMonth = cursor.getMonth();

  const monthLabel = useMemo(() => {
    const name = new Intl.DateTimeFormat(locale, { month: 'long' }).format(
      new Date(currentYear, currentMonth, 1),
    );
    const capitalized = name.charAt(0).toUpperCase() + name.slice(1);
    return `${capitalized} ${currentYear}`;
  }, [locale, currentYear, currentMonth]);

  /* ---- Fetch meetings ---- */
  const fetchMeetings = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/meetings');
      if (res.ok) {
        const data: Meeting[] = await res.json();
        // Keep ALL meetings on the calendar, including past/ended ones — they render
        // greyed (eventAccent) so history stays visible. The Archive remains the
        // dedicated list of ended meetings.
        setMeetings(data);
      }
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchMeetings();
  }, [fetchMeetings]);

  /* ---- Fetch task deadlines (accessible tasks that have a due date) ---- */
  // includeSubtasks=1 so subtask due dates show too; role-scoping (own +
  // department + collaborations, or everything for admins) is enforced by the API.
  useEffect(() => {
    fetch('/api/tasks?scope=all&includeSubtasks=1')
      .then((r) => (r.ok ? r.json() : []))
      .then((data: CalTask[]) => {
        if (Array.isArray(data)) {
          // Only tasks with a deadline; completed ones are dropped (a past
          // deadline that's already done just clutters the calendar).
          setTasks(data.filter((tk) => tk.dueDate && tk.status !== 'done'));
        }
      })
      .catch(() => {});
    fetch('/api/departments')
      .then((r) => (r.ok ? r.json() : []))
      .then((d: { id: string; name: string; color: string | null; members?: { userId: string }[] }[]) => {
        if (Array.isArray(d)) setDepartments(d.map((x) => ({ id: x.id, name: x.name, color: x.color ?? null, members: Array.isArray(x.members) ? x.members.map((m) => ({ userId: m.userId })) : [] })));
      })
      .catch(() => {});
  }, []);

  // Effective department of a task = explicit department, else the assignee's
  // department (mirrors the tasks board), enabling the admin department filter.
  const userDept = useMemo(() => {
    const m: Record<string, { id: string; name: string; color: string | null }> = {};
    for (const d of departments) for (const mem of d.members) if (!m[mem.userId]) m[mem.userId] = { id: d.id, name: d.name, color: d.color };
    return m;
  }, [departments]);

  const visibleTasks = useMemo(() => {
    if (filterDept === 'all') return tasks;
    return tasks.filter((tk) => {
      const eff = tk.department?.id ?? tk.departmentId ?? (tk.assigneeId ? userDept[tk.assigneeId]?.id : undefined) ?? null;
      return eff === filterDept;
    });
  }, [tasks, filterDept, userDept]);

  /* ---- Navigation ---- */
  const goToday = () => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    setCursor(d);
  };

  const goPrev = () => {
    setCursor((prev) => {
      const d = new Date(prev);
      d.setDate(d.getDate() - (view === 'week' ? 7 : 30));
      return d;
    });
  };

  const goNext = () => {
    setCursor((prev) => {
      const d = new Date(prev);
      d.setDate(d.getDate() + (view === 'week' ? 7 : 30));
      return d;
    });
  };

  /* ---- Meeting click handler ---- */
  const handleMeetingClick = useCallback(
    (m: Meeting) => {
      setSelectedMeeting(m);
    },
    [],
  );

  /* ---- Task deadline click → open that task's modal in the hub ---- */
  const handleTaskClick = useCallback(
    (tk: CalTask) => {
      router.push(`/tasks?task=${tk.id}`);
    },
    [router],
  );

  const handleDeleteMeeting = useCallback(async (m: Meeting) => {
    if (!confirm(t('calendar.deleteConfirm'))) return;
    setDeleting(true);
    try {
      const res = await fetch('/api/meetings/' + m.id, { method: 'DELETE' });
      if (res.ok) {
        setSelectedMeeting(null);
        fetchMeetings();
      }
    } catch (e) { console.error(e); }
    finally { setDeleting(false); }
  }, [fetchMeetings, t]);

  const handleEditSave = useCallback((updated: Meeting) => {
    setEditMeeting(null);
    setSelectedMeeting(null);
    fetchMeetings();
  }, [fetchMeetings]);

  /* ---- Day click in month view ---- */
  const handleDayClick = useCallback(
    (date: Date, dayMeetings: Meeting[], dayTasks: CalTask[]) => {
      setModal({ date, meetings: dayMeetings, tasks: dayTasks });
    },
    [],
  );

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        height: '100%',
      }}
    >
      {/* ============ HEADER BAR ============ */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexWrap: 'wrap',
          padding: '14px clamp(14px, 4vw, 28px)',
          borderBottom: '1px solid var(--border)',
          flexShrink: 0,
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 600 }}>
          {isMobile ? t('nav.calendar') : monthLabel}
        </div>

        {!isMobile && (
          <div style={{ display: 'flex', gap: 6, marginLeft: 14 }}>
            <button
              className="btn btn-icon"
              onClick={goPrev}
              title={t('calendar.previous')}
            >
              <ChevronLeft size={15} />
            </button>
            <button
              className="btn btn-sm"
              onClick={goToday}
              style={{ fontWeight: 600 }}
            >
              {t('common.today')}
            </button>
            <button
              className="btn btn-icon"
              onClick={goNext}
              title={t('calendar.next')}
            >
              <ChevronRight size={15} />
            </button>
          </div>
        )}

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          {/* Department filter (admins only — members are already scoped server-side) */}
          {isAdmin && departments.length > 0 && (
            <Select
              value={filterDept}
              onChange={setFilterDept}
              icon={<Building2 size={14} />}
              options={[{ value: 'all', label: t('departments.filterAll') }, ...departments.map((d) => ({ value: d.id, label: d.name }))]}
            />
          )}
          {/* View toggle (desktop only — mobile uses the agenda list) */}
          {!isMobile && (
            <div
              style={{
                display: 'flex',
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: 10,
                padding: 3,
              }}
            >
              {(['week', 'month'] as ViewMode[]).map((v) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  className="btn btn-sm"
                  style={{
                    background:
                      view === v ? 'var(--surface-3)' : 'transparent',
                    border: 'none',
                    borderRadius: 7,
                    fontWeight: view === v ? 600 : 500,
                  }}
                >
                  {v === 'week' ? t('calendar.week') : t('calendar.month')}
                </button>
              ))}
            </div>
          )}

          <Link
            href="/schedule"
            className="btn btn-primary"
            style={{ textDecoration: 'none', gap: 5 }}
          >
            <Plus size={15} /> {t('calendar.create')}
          </Link>
        </div>
      </div>

      {/* ============ CONTENT ============ */}
      {loading ? (
        <div
          style={{
            flex: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--muted)',
            gap: 8,
          }}
        >
          <RefreshCw
            size={16}
            style={{ animation: 'spin 1s linear infinite' }}
          />
          <span style={{ fontSize: 13 }}>{t('common.loading')}</span>
        </div>
      ) : isMobile ? (
        <AgendaView
          meetings={meetings}
          tasks={visibleTasks}
          today={today}
          onMeetingClick={handleMeetingClick}
          onTaskClick={handleTaskClick}
        />
      ) : view === 'week' ? (
        <WeekView
          weekStart={weekStart}
          meetings={meetings}
          tasks={visibleTasks}
          today={today}
          onMeetingClick={handleMeetingClick}
          onTaskClick={handleTaskClick}
        />
      ) : (
        <MonthView
          year={currentYear}
          month={currentMonth}
          meetings={meetings}
          tasks={visibleTasks}
          today={today}
          onDayClick={handleDayClick}
          onTaskClick={handleTaskClick}
        />
      )}

      {/* ============ DAY MODAL ============ */}
      {modal && (
        <DayModal
          date={modal.date}
          meetings={modal.meetings}
          tasks={modal.tasks}
          onClose={() => setModal(null)}
          onMeetingClick={(m) => {
            setModal(null);
            handleMeetingClick(m);
          }}
          onTaskClick={(tk) => {
            setModal(null);
            handleTaskClick(tk);
          }}
        />
      )}

      {selectedMeeting && !editMeeting && (
        <MeetingDetailModal
          meeting={selectedMeeting}
          onClose={() => setSelectedMeeting(null)}
          onJoin={(m) => { setSelectedMeeting(null); }}
          onEdit={(m) => { setEditMeeting(m); }}
          onDelete={handleDeleteMeeting}
          deleting={deleting}
        />
      )}

      {editMeeting && (
        <CalendarEditModal
          meeting={editMeeting}
          onClose={() => setEditMeeting(null)}
          onSave={handleEditSave}
        />
      )}

      <style>{`
        @keyframes fadeIn {
          from { opacity: 0; transform: scale(.96); }
          to   { opacity: 1; transform: scale(1); }
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
