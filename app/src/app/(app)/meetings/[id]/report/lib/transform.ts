import type { Meeting } from './types';

/* ─── Transform API data to page interfaces ─────────────────────── */
export function transformApiData(data: any): Meeting {
  // Transform transcripts: content -> text, startTime -> timestamp
  const transcripts = (data.transcripts || []).map((t: any) => ({
    id: t.id,
    speakerName: t.speakerName || t.speaker?.name || 'Unknown',
    speakerImage: t.speaker?.image || null,
    language: (t.language || 'uk').toLowerCase().replace('uk', 'ua') as 'ua' | 'en' | 'ru',
    timestamp: formatTimestamp(t.startTime || 0),
    startTime: Number(t.startTime) || 0,
    text: t.content || t.text || '',
  }));

  // Transform reports
  const reports = (data.reports || []).map((r: any) => {
    // Tasks come as r.tasks from the API (Prisma relation), map to actionItems
    const actionItems = (r.tasks || r.actionItems || []).map((t: any) => {
      // Full assignee set from the TaskAssignment join; fall back to the single
      // lead (registered or guest) when there are no join rows.
      const assignees = Array.isArray(t.assignees) && t.assignees.length
        ? t.assignees.map((a: any) => ({
            id: a.user?.id ?? a.userId ?? null,
            name: a.user?.name || '',
            image: a.user?.image || null,
            registered: true,
          }))
        : (t.assigneeName || t.assignee?.name)
          ? [{
              id: t.assigneeId || t.assignee?.id || null,
              name: t.assigneeName || t.assignee?.name || '',
              image: t.assignee?.image || null,
              registered: !!(t.assigneeId || t.assignee?.id),
            }]
          : [];
      return {
        id: t.id,
        text: t.title || t.text || '',
        assignee: assignees[0]?.name || t.assigneeName || t.assignee?.name || t.assignee || '',
        assigneeImage: assignees[0]?.image ?? t.assignee?.image ?? null,
        assigneeRegistered: assignees[0] ? assignees[0].registered : !!(t.assigneeId || t.assignee?.id),
        assignees,
        dueDate: t.dueDate || null,
        priority: (t.priority || 'medium') as 'high' | 'medium' | 'low',
        status: (t.status === 'in_progress' || t.status === 'done' ? t.status : 'open') as 'open' | 'in_progress' | 'done',
        done: t.status === 'done' || t.done || false,
        clickupManaged: !!t.clickupManaged,
        clickupUrl: t.clickupUrl ?? null,
      };
    });

    return {
      id: r.id,
      summary: r.summary || '',
      actionItems,
      decisions: Array.isArray(r.decisions) ? r.decisions : [],
      followUps: Array.isArray(r.followUps) ? r.followUps : [],
      topics: Array.isArray(r.topics) ? r.topics : [],
      analytics: r.analytics || null,
      recording: r.recording || null,
    };
  });

  // Actual meeting length. The scheduled/created time is unreliable — a meeting
  // can start earlier or later than planned, so `endedAt − scheduledAt` can be
  // wildly off (even negative). Prefer the real speech span from transcript
  // timestamps (seconds), then a sanity-guarded elapsed time, then the planned
  // duration as a last resort.
  const meetStart = data.scheduledAt || data.createdAt;
  let durationMin = 0;
  const segEnds = (data.transcripts || []).map((t: any) => Number(t.endTime ?? t.startTime ?? 0)).filter((n: number) => n > 0);
  const segStarts = (data.transcripts || []).map((t: any) => Number(t.startTime ?? 0)).filter((n: number) => n >= 0);
  if (segEnds.length && segStarts.length) {
    const spanSec = Math.max(...segEnds) - Math.min(...segStarts);
    if (spanSec > 0) durationMin = Math.round(spanSec / 60);
  }
  if (!durationMin && meetStart && data.endedAt) {
    const diff = Math.round((new Date(data.endedAt).getTime() - new Date(meetStart).getTime()) / 60000);
    if (diff > 0) durationMin = diff;
  }
  if (!durationMin) durationMin = data.durationMin || 0;

  return {
    id: data.id,
    title: data.title || 'Мітинг',
    scheduledAt: data.scheduledAt,
    createdAt: data.createdAt,
    endedAt: data.endedAt,
    durationMin,
    status: data.status,
    participants: data.participants || [],
    transcripts,
    reports,
  };
}

export function formatTimestamp(seconds: number): string {
  const totalSec = Math.floor(seconds);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}
