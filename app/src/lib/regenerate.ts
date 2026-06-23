// Report generation (standard summary + extended topic-structured report with
// transcript citations) and single-speaker re-transcription.
//
// generateMeetingReport() runs server-side, so it is not constrained by the
// LiveKit agent's shutdown window and controls its own token budget (some
// configured models are reasoning models that need a large max_tokens). It is
// triggered by the agent on room end (notify=true) and by the report
// "fix language & regenerate" flow (notify=false).
import fs from 'node:fs/promises';
import { Prisma } from '@prisma/client';
import { prisma } from './prisma';
import { readConfig, getDeepSeekConfig } from './config';
import { sseJsonChunks, chunkDelta } from './sse';
import { workspaceLocale } from './i18n-server';
import { notify } from './notify';
import { sendReportEmail } from './report-email';
import { provisionSystemTasksTable } from './system-tasks-table';
import { provisionSystemDecisionsTable } from './system-decisions-table';
import { createTaskFromAI, aiCellsFromModel, AI_FILLABLE_TYPES } from './tasks';
import { pushMeetingTasksToClickUp, type ClickUpPushItem } from './clickup';
import { pushMeetingTasksToLinear } from './linear';
import { notifyChatReportReady } from './chat-notify';
import { notifyWebhookReportReady } from './webhooks';
import { coerceRowData } from './base-rows';

export interface ReTranscribedSegment {
  content: string;
  start: number;
  end: number;
  confidence: number;
}

/** Re-transcribe a single speaker's WAV file in a specific language. */
export async function transcribeSpeakerFile(
  filePath: string,
  language: string
): Promise<ReTranscribedSegment[]> {
  const cfg = await readConfig(['DEEPGRAM_API_KEY']);
  const key = cfg.DEEPGRAM_API_KEY || process.env.DEEPGRAM_API_KEY || '';
  if (!key) throw new Error('Deepgram API key not configured');

  const audio = await fs.readFile(filePath);

  const url = new URL('https://api.deepgram.com/v1/listen');
  url.searchParams.set('model', 'nova-2');
  url.searchParams.set('language', language);
  url.searchParams.set('smart_format', 'true');
  url.searchParams.set('punctuate', 'true');
  url.searchParams.set('utterances', 'true');

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Token ${key}`, 'Content-Type': 'audio/wav' },
    body: new Uint8Array(audio),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Deepgram ${res.status}: ${txt.slice(0, 200)}`);
  }
  const data: any = await res.json();

  const out: ReTranscribedSegment[] = [];
  for (const u of data?.results?.utterances || []) {
    const content = String(u.transcript || '').trim();
    if (content) {
      out.push({
        content,
        start: Number(u.start) || 0,
        end: Number(u.end) || 0,
        confidence: Number(u.confidence) || 0,
      });
    }
  }
  if (out.length === 0) {
    const alt = data?.results?.channels?.[0]?.alternatives?.[0];
    const t = String(alt?.transcript || '').trim();
    if (t) out.push({ content: t, start: 0, end: 0, confidence: Number(alt?.confidence) || 0 });
  }
  return out;
}

function parseDueDate(desc: string): Date | null {
  const now = new Date();
  const lower = desc.toLowerCase();
  if (lower.includes('завтра') || lower.includes('tomorrow')) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    return d;
  }
  if (lower.includes('тижн') || lower.includes('week')) {
    const d = new Date(now);
    d.setDate(d.getDate() + 7);
    return d;
  }
  if (lower.includes('місяц') || lower.includes('month')) {
    const d = new Date(now);
    d.setMonth(d.getMonth() + 1);
    return d;
  }
  if (lower.includes("п'ятниц") || lower.includes('friday')) {
    const d = new Date(now);
    const daysUntilFriday = (5 - d.getDay() + 7) % 7 || 7;
    d.setDate(d.getDate() + daysUntilFriday);
    return d;
  }
  return null;
}

/** Parse JSON that may be wrapped in markdown fences or surrounded by prose. */
function parseJsonLoose(s: string): any | null {
  if (!s) return null;
  const tryParse = (x: string) => {
    try {
      return JSON.parse(x);
    } catch {
      return null;
    }
  };
  let r = tryParse(s);
  if (r) return r;
  let t = s.trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```$/, '').trim();
    r = tryParse(t);
    if (r) return r;
  }
  const i = t.indexOf('{');
  const j = t.lastIndexOf('}');
  if (i >= 0 && j > i) return tryParse(t.slice(i, j + 1));
  return null;
}

/**
 * Generate the full meeting report — a short summary plus a topic-structured
 * extended report where every decision/task/open question cites the transcript.
 * Topics are the source of truth; the flat agenda/decisions/follow-ups and AI
 * tasks are derived from them. Replaces the previous report + AI tasks atomically
 * (manual tasks are preserved). When notify=true (first generation, from the
 * agent), it also marks the meeting ended, notifies participants and emails the
 * report.
 */
async function generateReportInner(
  meetingId: string,
  opts: { notify?: boolean } = {}
): Promise<{ topics: number }> {
  const segments = await prisma.transcriptSegment.findMany({
    where: { meetingId },
    orderBy: { startTime: 'asc' },
    select: { speakerName: true, speakerId: true, content: true, language: true, startTime: true },
  });
  if (segments.length === 0) return { topics: 0 };

  const ds = await getDeepSeekConfig();
  if (!ds.apiKey) throw new Error('DeepSeek API key not configured');
  const wsLoc = await workspaceLocale();
  const langName = wsLoc === 'uk' ? 'Ukrainian' : 'English';

  // Meeting context for tenant scoping + department auto-routing. Fetched up
  // front so the prompt can list departments (and which attendee is in which)
  // and the persistence step can resolve a department NAME → id.
  const meetingMeta = await prisma.meeting.findUnique({
    where: { id: meetingId },
    select: { departmentId: true, orgId: true, scheduledAt: true },
  });
  if (!meetingMeta) throw new Error('Meeting not found');
  const meetingDeptId = meetingMeta.departmentId ?? null;
  const orgId = meetingMeta.orgId; // non-null: every meeting carries its org
  const decisionDateIso = (meetingMeta.scheduledAt ?? new Date()).toISOString();
  const departments = await prisma.department.findMany({
    where: { orgId },
    select: { id: true, name: true, members: { select: { userId: true } } },
  });
  const deptIdByName = new Map<string, string>();
  for (const d of departments) deptIdByName.set(d.name.trim().toLowerCase(), d.id);
  // userId → first department id (for fallback routing when the model doesn't
  // name a department) and → department names (to hint the model in the prompt).
  const userFirstDeptId = new Map<string, string>();
  const userDeptNames = new Map<string, string[]>();
  for (const d of departments) {
    for (const m of d.members) {
      if (!userFirstDeptId.has(m.userId)) userFirstDeptId.set(m.userId, d.id);
      const arr = userDeptNames.get(m.userId) || [];
      arr.push(d.name);
      userDeptNames.set(m.userId, arr);
    }
  }

  // System Tasks table (Phase 3) — provisioned up front (idempotent) so the
  // prompt can list the org's CUSTOM task fields for the AI to fill (P4.1) and
  // the persistence step can coerce them. `aiFillFields` = custom fields the AI
  // may set (excludes the 6 system fields + non-fillable types).
  const prov = await provisionSystemTasksTable(orgId);
  const taskFields = await prisma.field.findMany({
    where: { tableId: prov.table.id },
    select: { id: true, name: true, type: true, options: true },
  });
  // Decisions registry (P4.2): provision the system Decisions table + load its
  // fields for coercion. Decisions are persisted as Rows in the transaction below.
  const decProv = await provisionSystemDecisionsTable(orgId);
  const decFields = await prisma.field.findMany({ where: { tableId: decProv.table.id }, select: { id: true, type: true, options: true } });
  const systemFieldIds = new Set<string>(Object.values(prov.fieldIds));
  // Custom AI-fillable fields, DEDUPED by lowercased name (field names aren't
  // unique within a table) so the prompt lists each once and a model value maps
  // to exactly one column id; select fields need ≥1 choice to be fillable.
  const aiFillFields = (() => {
    const seen = new Set<string>();
    const out: typeof taskFields = [];
    for (const f of taskFields) {
      if (systemFieldIds.has(f.id) || !AI_FILLABLE_TYPES.has(f.type)) continue;
      if ((f.type === 'singleSelect' || f.type === 'multiSelect') && !((f.options as { choices?: unknown[] } | null)?.choices?.length)) continue;
      const key = f.name.trim().toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(f);
    }
    return out;
  })();

  // Meeting ATTENDEES = registered users (formal participants + any registered
  // transcript speaker) and guests (people who joined by name, with no account —
  // found as participants or as transcript speakers without a speakerId).
  // Auto-assignment is restricted to this list; a guest is assigned by the name
  // they joined with, with id=null (the UI flags them as "not registered").
  type Attendee = { id: string | null; name: string; preferences: any };
  const participantRows = await prisma.meetingParticipant.findMany({
    where: { meetingId },
    include: { user: { select: { id: true, name: true, preferences: true } } },
  });
  const registered = new Map<string, Attendee>();
  const guestNames = new Set<string>();
  for (const p of participantRows) {
    if (p.user) registered.set(p.user.id, { id: p.user.id, name: p.user.name || '', preferences: p.user.preferences });
    else if (p.guestName) guestNames.add(p.guestName);
  }
  for (const s of segments) {
    if (s.speakerId) {
      if (!registered.has(s.speakerId)) registered.set(s.speakerId, { id: s.speakerId, name: s.speakerName || '', preferences: null });
    } else if (s.speakerName) {
      guestNames.add(s.speakerName);
    }
  }
  const regNameSet = new Set(
    [...registered.values()].map((r) => (r.name || '').toLowerCase()).filter(Boolean)
  );
  const attendees: Attendee[] = [
    ...registered.values(),
    ...[...guestNames]
      .filter((g) => g && !regNameSet.has(g.toLowerCase()))
      .map((g) => ({ id: null, name: g, preferences: null })),
  ];
  const matchParticipant = (name: any): Attendee | null => {
    if (!name || typeof name !== 'string') return null;
    const n = name.trim().toLowerCase();
    if (!n) return null;
    for (const a of attendees) {
      const an = (a.name || '').toLowerCase();
      if (an && (an.includes(n) || n.includes(an))) return a;
    }
    return null;
  };
  // Registered attendees by id (for notify preferences during persistence).
  const attendeeById = new Map<string, Attendee>();
  for (const a of attendees) if (a.id) attendeeById.set(a.id, a);
  // Attendee list with a [department] hint so the model can route tasks; the
  // model is told to use the bare name (without the suffix) as the assignee.
  const attendeeLabels = attendees
    .map((a) => {
      if (!a.name) return '';
      const dn = a.id ? userDeptNames.get(a.id) : null;
      return dn && dn.length ? `${a.name} [${dn.join('/')}]` : a.name;
    })
    .filter(Boolean);
  const participantsLine = attendees.length
    ? `\nMeeting attendees (use ONLY these exact names — WITHOUT the [department] suffix — for any assignee/owner, otherwise null): ${attendeeLabels.join(', ')}.\n`
    : '\nNo identifiable attendees — set every assignee and owner to null.\n';
  const departmentsLine = departments.length
    ? `Departments — route EACH task to the single most relevant one by exact name (by the nature of the work and the assignees' [department] hints), or null if none fits: ${departments.map((d) => d.name).join(', ')}.\n`
    : '';
  // Custom task fields the AI may fill (P4.1) — listed for the prompt with a
  // type hint; for select fields the EXACT allowed option names.
  const aiFieldHint = (f: { type: string; options: any }): string => {
    const names = (((f.options?.choices as { name?: string }[]) || []).map((c) => c?.name).filter(Boolean) as string[]);
    switch (f.type) {
      case 'number': case 'currency': case 'percent': case 'rating': return '(a number)';
      case 'checkbox': return '(true or false)';
      case 'singleSelect': return `(exactly one of: ${names.join(', ')})`;
      case 'multiSelect': return `(an array, any of: ${names.join(', ')})`;
      default: return '(text)';
    }
  };
  const customFieldsLine = aiFillFields.length
    ? `Custom task fields — for EACH task you MAY also fill a "fields" object with these EXTRA fields, but ONLY when the transcript clearly states a value (otherwise omit that field, or the whole "fields" object — NEVER invent a value, and NEVER use an option that is not listed):\n${aiFillFields.map((f) => `  • "${f.name}" ${aiFieldHint(f)}`).join('\n')}\n`
    : '';
  const customFieldsShape = aiFillFields.length
    ? `, "fields": { "field name": "value per the Custom task fields list — omit fields you don't know" }`
    : '';

  const numbered = segments
    .map((s, i) => `${i + 1}. [${(s.language || '??').toUpperCase()}] ${s.speakerName || '?'}: ${s.content}`)
    .join('\n');

  const prompt = `You are a meeting documentarian. From the NUMBERED transcript below, produce a DETAILED, well-structured report.
Rules:
- Organise the report by TOPIC — create a SEPARATE topic for EACH distinct theme or agenda item actually discussed. A substantive meeting usually has 5-10 topics; do NOT consolidate everything into 2-3 broad topics. Prefer more, finer-grained topics, and within each capture every decision, task and open question raised.
- For EVERY decision, task and open question, include a "cites" array with the exact transcript line numbers that support it.
- NEVER invent facts that are not present in the transcript.
- Write all textual content in ${langName}.
- Extract ALL decisions, tasks and open questions that were discussed — never omit an item, even when nobody is clearly responsible for it.
- Be EXHAUSTIVE with tasks: capture every distinct action item, commitment, request or "I will / we need to / let's …" as its OWN separate task. Do not merge different tasks into one.
- A task's "title" (and a decision's "text") must state ONLY the action or outcome, in imperative form — NEVER include the responsible person's name, because tasks can be reassigned. e.g. write "Develop native apps for Android, iOS, Mac and Windows", NOT "Vitaliy will develop native apps". The people go ONLY in the separate "assignees" / "owner" field.
- Be EQUALLY EXHAUSTIVE with DECISIONS: capture every conclusion, choice, agreement or settled direction ("we'll go with X", "let's use Y", "decided to…", "agreed that…", "the plan is…") as its own decision.
- Be EQUALLY EXHAUSTIVE with OPEN QUESTIONS / follow-ups: capture everything left unresolved, deferred or to revisit ("we still need to figure out…", "to be decided", "let's come back to this", any unanswered question or risk raised).
- Classify by intent and POPULATE ALL THREE categories — a typical working meeting has SEVERAL tasks, several decisions and a few open questions, so do not leave tasks (or any category) empty when the transcript contains them:
    • TASK = actionable work someone should do or build going forward ("develop…", "send…", "automate…", "I will…", "we need to…"). Keep it as a TASK even if it was also agreed upon — do not turn every action into a decision.
    • DECISION = a settled conclusion, choice, policy or direction (no direct action by itself).
    • OPEN QUESTION = anything unresolved, deferred or to revisit.
- Write rich, SPECIFIC content: include concrete details, names, numbers, examples and reasoning from the transcript — not vague generalities. The result should read like thorough, well-organised minutes.
- A task's "assignees" is an ARRAY of attendee names: include EVERY person the transcript makes responsible for it — when work is shared ("Anna and Boris will…", "the design team will…") list ALL of them, not just one. Use attendees' exact names (from the list below — it includes guests who joined by name) ONLY when the transcript attributes the work to them; use [] when nobody is clearly responsible. A decision's "owner" stays a single name or null. Never invent a name, never use a name that is not a listed attendee, and never drop an item just because its owner is unknown.
- Break a task into "subtasks" when it has clearly distinct steps or deliverables that different people/teams own (e.g. "Launch the landing page" → "Write the copy" (Anna), "Build the page" (Boris), "Set up analytics" (Carol)). Each subtask is itself { title (imperative, no name), assignees (array), priority, due }. Only create subtasks that are genuinely separable sub-steps — do NOT split atomic tasks, and do NOT duplicate the parent as its own subtask. Most tasks have no subtasks; use them where they add real structure.
- "department": route EACH task (and its subtasks inherit it) to the single most relevant department by EXACT name from the Departments list below — infer it from the nature of the work and from the assignees' [department] hints. Use null when no department clearly fits or none are defined.
- Respond with valid JSON only, in exactly this shape:
{
  "summary": "2-3 paragraph TL;DR of the whole meeting in ${langName}",
  "topics": [
    {
      "title": "short topic title in ${langName}",
      "discussion": "a thorough multi-sentence narrative of this topic in ${langName} — the context, the main points raised, who said what, and the reasoning / outcome",
      "decisions": [ { "text": "decision in ${langName}", "owner": "person name or null", "cites": [1, 2] } ],
      "tasks": [ { "title": "the action only, imperative, in ${langName} — NO person name", "assignees": ["attendee name", "..."], "department": "department name or null", "priority": "high|medium|low", "due": "timeframe or null", "cites": [3], "subtasks": [ { "title": "sub-step, imperative, in ${langName} — NO person name", "assignees": ["attendee name"], "priority": "high|medium|low", "due": "timeframe or null" } ]${customFieldsShape} } ],
      "open_questions": [ { "text": "open question in ${langName}", "cites": [4] } ],
      "cites": [1, 2, 3, 4]
    }
  ]
}
${participantsLine}${departmentsLine}${customFieldsLine}
TRANSCRIPT:
${numbered}`;

  const res = await fetch(`${ds.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ds.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: ds.model,
      messages: [
        { role: 'system', content: 'You are a meeting analysis assistant. Always respond with valid JSON.' },
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2,
      // Large headroom: reasoning models spend much of the budget on hidden
      // reasoning before the JSON, and a detailed report can be long.
      max_tokens: Math.min(64000, ds.maxTokens ?? 64000), // configured value is a CEILING, never a floor (don't starve the report)
      // Stream the response so a multi-minute generation doesn't trip fetch's
      // header/idle timeouts (the full JSON only arrives at the very end).
      stream: true,
      stream_options: { include_usage: true },
    }),
  });
  if (!res.ok || !res.body) {
    const txt = res.ok ? '(no response body)' : await res.text().catch(() => '');
    throw new Error(`DeepSeek ${res.status}: ${txt.slice(0, 200)}`);
  }

  // Accumulate the streamed completion (OpenAI-compatible SSE).
  let content = '';
  let usage: any = {};
  for await (const chunk of sseJsonChunks(res.body.getReader())) {
    content += chunkDelta(chunk);
    if (chunk.usage) usage = chunk.usage;
  }

  const rep = parseJsonLoose(content);
  if (!rep) throw new Error('DeepSeek returned no parseable JSON');

  // Map a 1-based transcript line number -> that segment's start time (seconds),
  // so the UI can jump to the cited moment. Drop out-of-range (fabricated) cites.
  const citeTimes = (cs: any): number[] => {
    if (!Array.isArray(cs)) return [];
    const out: number[] = [];
    for (const c of cs) {
      const i = typeof c === 'number' ? c : parseInt(c, 10);
      if (Number.isFinite(i) && i >= 1 && i <= segments.length) out.push(segments[i - 1].startTime);
    }
    return out;
  };

  // Collect attendee NAMES from a model "assignees" array (falling back to a
  // legacy single "assignee" string), keeping only listed attendees and de-duping.
  const normalizeNames = (arr: any, single?: any): string[] => {
    const raw = Array.isArray(arr) ? arr.slice() : [];
    if (raw.length === 0 && single != null) raw.push(single);
    const out: string[] = [];
    const seen = new Set<string>();
    for (const v of raw) {
      const m = matchParticipant(v);
      if (!m || !m.name) continue;
      const key = m.id || `g:${m.name.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(m.name);
    }
    return out;
  };
  // Resolve attendee names → { lead, registered ids }. The lead (denormalised
  // MeetingTask.assigneeId) is the first REGISTERED attendee if any, else the
  // first named (guest); registered ids drive the TaskAssignment join rows.
  const resolveSet = (names: string[]): { leadId: string | null; leadName: string | null; regIds: string[] } => {
    const all = names.map((n) => matchParticipant(n)).filter((a): a is Attendee => !!a);
    const lead = all.find((a) => a.id) ?? all[0] ?? null;
    const regIds = [
      ...(lead?.id ? [lead.id] : []),
      ...all.filter((a) => a.id && a.id !== lead?.id).map((a) => a.id as string),
    ];
    return { leadId: lead?.id ?? null, leadName: lead?.name ?? null, regIds: [...new Set(regIds)] };
  };
  // Route a task to a department: explicit model name → lead's department → meeting's.
  const resolveDept = (deptName: any, leadId: string | null): string | null => {
    if (typeof deptName === 'string' && deptName.trim()) {
      const id = deptIdByName.get(deptName.trim().toLowerCase());
      if (id) return id;
    }
    if (leadId && userFirstDeptId.has(leadId)) return userFirstDeptId.get(leadId) as string;
    return meetingDeptId;
  };

  const rawTopics = Array.isArray(rep.topics) ? rep.topics : [];
  const topics = rawTopics.map((t: any) => ({
    title: String(t.title || '').trim(),
    discussion: String(t.discussion || '').trim(),
    decisions: (Array.isArray(t.decisions) ? t.decisions : []).map((d: any) => ({
      text: String(d.text || '').trim(),
      owner: matchParticipant(d.owner)?.name ?? null,
      cites: citeTimes(d.cites),
    })),
    tasks: (Array.isArray(t.tasks) ? t.tasks : []).map((k: any) => {
      const assignees = normalizeNames(k.assignees, k.assignee);
      const priority = ['high', 'medium', 'low'].includes(k.priority) ? k.priority : 'medium';
      return {
        title: String(k.title || '').trim(),
        // `assignee` (singular, the lead) kept for the report UI / back-compat;
        // `assignees` (the full set) + `department` + `subtasks` are additive.
        assignee: assignees[0] ?? null,
        assignees,
        department: typeof k.department === 'string' && k.department.trim() ? k.department.trim() : null,
        priority,
        due: k.due || null,
        cites: citeTimes(k.cites),
        subtasks: (Array.isArray(k.subtasks) ? k.subtasks : []).map((s: any) => ({
          title: String(s.title || '').trim(),
          assignees: normalizeNames(s.assignees, s.assignee),
          priority: ['high', 'medium', 'low'].includes(s.priority) ? s.priority : priority,
          due: s.due || null,
        })).filter((s: any) => s.title),
        // AI-filled custom-field cells (P4.1), engine-shaped (id→value); subtasks have none.
        cells: aiCellsFromModel(aiFillFields, k.fields),
      };
    }),
    openQuestions: (Array.isArray(t.open_questions) ? t.open_questions : []).map((q: any) => ({
      text: String(q.text || '').trim(),
      cites: citeTimes(q.cites),
    })),
    cites: citeTimes(t.cites),
  }));

  const agenda = topics.map((t: any) => t.title).filter(Boolean);
  const decisions = topics.flatMap((t: any) => t.decisions.map((d: any) => d.text)).filter(Boolean);
  const followUps = topics.flatMap((t: any) => t.openQuestions.map((q: any) => q.text)).filter(Boolean);

  // Whether a registered assignee wants action-item notifications (default yes).
  const notifyOn = (uid: string): boolean => {
    const prefs = attendeeById.get(uid)?.preferences as any;
    return !prefs || prefs.actionItemNotif !== false;
  };
  // Resolve each topic task into a persistable shape: a lead (the denormalised
  // MeetingTask.assigneeId), the full registered-assignee id set (→ TaskAssignment
  // join rows), an auto-routed department, and likewise-resolved subtasks.
  const resolvedTasks = topics.flatMap((t: any) => t.tasks).map((k: any) => {
    const { leadId, leadName, regIds } = resolveSet(k.assignees || []);
    return {
      title: k.title || '(untitled)',
      leadId,
      leadName,
      regIds,
      priority: k.priority,
      dueDate: k.due ? parseDueDate(String(k.due)) : null,
      departmentId: resolveDept(k.department, leadId),
      cells: (k.cells && typeof k.cells === 'object') ? k.cells as Record<string, unknown> : undefined,
      subtasks: (k.subtasks || []).map((s: any) => {
        const r = resolveSet(s.assignees || []);
        return {
          title: s.title || '(untitled)',
          leadId: r.leadId,
          leadName: r.leadName,
          regIds: r.regIds,
          priority: s.priority,
          dueDate: s.due ? parseDueDate(String(s.due)) : null,
        };
      }),
    };
  });

  // (`prov` + `taskFields` were provisioned earlier — before the prompt — so the
  // AI could see the org's custom fields.) leadFirst orders the denormalised lead.
  // Flatten decisions across topics for the registry (P4.2). owner = a matched
  // attendee name (or null); re-resolved to a userId at persist time.
  const allDecisions = topics.flatMap((t: any) => t.decisions) as { text: string; owner: string | null }[];
  const leadFirst = (lead: string | null, ids: string[]) => (lead ? [lead, ...ids.filter((x) => x !== lead)] : ids);

  // Collected AFTER commit for the (opt-in, fire-and-forget) ClickUp push. Captured
  // here because the transaction's return value (and the created Row ids) is discarded.
  const clickupItems: ClickUpPushItem[] = [];

  await prisma.$transaction(async (tx) => {
    // Re-derive AI tasks: delete the meeting's AI Rows (cascades TaskRow + Row*).
    const aiRows = await tx.taskRow.findMany({ where: { meetingId, source: 'ai' }, select: { rowId: true } });
    if (aiRows.length) await tx.row.deleteMany({ where: { id: { in: aiRows.map((x) => x.rowId) } } });
    await tx.meetingReport.deleteMany({ where: { meetingId } });
    const created = await tx.meetingReport.create({
      data: {
        meetingId,
        summary: rep.summary || '',
        agenda,
        decisions,
        followUps,
        topics: topics as any,
        modelUsed: ds.model,
        tokensInput: usage.prompt_tokens || 0,
        tokensOutput: usage.completion_tokens || 0,
        rawPrompt: prompt,
        rawResponse: content,
      },
    });
    for (const r of resolvedTasks) {
      const { rowId: parentRowId } = await createTaskFromAI(tx, {
        tableId: prov.table.id,
        fieldIds: prov.fieldIds,
        fields: taskFields,
        meetingId,
        reportId: created.id,
        departmentId: r.departmentId,
        parentRowId: null,
        title: r.title,
        priority: r.priority,
        dueDate: r.dueDate,
        regIds: leadFirst(r.leadId, r.regIds),
        cells: r.cells,
      });
      clickupItems.push({
        rowId: parentRowId, title: r.title, priority: r.priority ?? null, dueDate: r.dueDate,
        departmentId: r.departmentId, assigneeUserIds: leadFirst(r.leadId, r.regIds), parentTitle: null,
      });
      // Subtasks: child rows under the parent, inheriting its department.
      for (const s of r.subtasks) {
        const { rowId: subRowId } = await createTaskFromAI(tx, {
          tableId: prov.table.id,
          fieldIds: prov.fieldIds,
          fields: taskFields,
          meetingId,
          reportId: created.id,
          departmentId: r.departmentId,
          parentRowId,
          title: s.title,
          priority: s.priority,
          dueDate: s.dueDate,
          regIds: leadFirst(s.leadId, s.regIds),
        });
        clickupItems.push({
          rowId: subRowId, title: s.title, priority: s.priority ?? null, dueDate: s.dueDate,
          departmentId: r.departmentId, assigneeUserIds: leadFirst(s.leadId, s.regIds), parentTitle: r.title,
        });
      }
    }

    // Decisions registry (P4.2): re-derive THIS meeting's AI decisions as Rows,
    // delete-then-insert (mirrors the AI-task re-derivation above). The structural
    // Meeting/Source fields in Row.data scope the delete (JSONB path query) and
    // later drive per-decision authz (a user sees a decision only if they can
    // access its meeting). Owner is the source meeting's matched attendee → userId.
    const df = decProv.fieldIds;
    await tx.row.deleteMany({
      where: {
        tableId: decProv.table.id,
        AND: [
          { data: { path: [df.meetingId], equals: meetingId } },
          { data: { path: [df.source], equals: 'ai' } },
        ],
      },
    });
    for (const d of allDecisions) {
      if (!d.text) continue;
      const ownerId = d.owner ? matchParticipant(d.owner)?.id ?? null : null;
      const data = coerceRowData(decFields, {
        [df.text]: d.text,
        [df.owner]: ownerId ?? undefined,
        [df.date]: decisionDateIso,
        [df.meetingId]: meetingId,
        [df.reportId]: created.id,
        [df.source]: 'ai',
      });
      await tx.row.create({ data: { tableId: decProv.table.id, data: data as Prisma.InputJsonValue, position: 0 } });
    }
  }, {
    // Multi-assignee + subtasks mean many more sequential writes than before —
    // give the interactive transaction generous headroom (default is 5s).
    timeout: 30000,
    maxWait: 10000,
  });

  if (opts.notify) {
    try {
      // Notify every registered assignee (parent + subtask) who hasn't opted out,
      // deduped to one notification per (user, task title).
      const seen = new Set<string>();
      const targets: { userId: string; title: string }[] = [];
      const queue = (title: string, regIds: string[]) => {
        for (const uid of regIds) {
          if (!notifyOn(uid)) continue;
          const key = `${uid}::${title}`;
          if (seen.has(key)) continue;
          seen.add(key);
          targets.push({ userId: uid, title });
        }
      };
      for (const r of resolvedTasks) {
        queue(r.title, r.regIds);
        for (const s of r.subtasks) queue(s.title, s.regIds);
      }
      for (const tg of targets) {
        await notify({
          userIds: [tg.userId],
          type: 'task_assigned',
          titleKey: 'taskAssignedTitle',
          body: tg.title,
          link: '/tasks',
          meetingId,
        });
      }
      const meeting = await prisma.meeting.findUnique({
        where: { id: meetingId },
        include: { participants: { where: { userId: { not: null } } } },
      });
      if (meeting) {
        const userIds = meeting.participants
          .map((p) => p.userId)
          .filter((u): u is string => !!u);
        if (userIds.length > 0) {
          await notify({
            userIds,
            type: 'report_ready',
            titleKey: 'reportReadyTitle',
            bodyKey: 'reportReadyBody',
            values: { title: meeting.title },
            link: `/meetings/${meetingId}/report`,
            meetingId,
          });
        }
      }
    } catch (e) {
      console.error('report notify failed:', e);
    }
    try {
      await sendReportEmail(meetingId, { respectPref: true });
    } catch (e) {
      console.error('report email failed:', e);
    }
    // Post the report to the team chat (opt-in; first generation only). Fire-and-forget.
    void notifyChatReportReady(meetingId);
    // Emit the report.ready outbound webhook (opt-in; first generation only). Fire-and-forget.
    void notifyWebhookReportReady(meetingId);
  }

  // ClickUp + Linear push (opt-in, non-blocking, idempotent). Both run on first
  // generation AND regeneration so re-runs UPDATE the external tasks instead of
  // duplicating. Each self-gates on its own config (silent no-op unless enabled),
  // shares the same captured items (identical shape), and never throws.
  try {
    await pushMeetingTasksToClickUp(meetingId, clickupItems);
  } catch (e) {
    console.error('clickup push failed:', e);
  }
  try {
    await pushMeetingTasksToLinear(meetingId, clickupItems);
  } catch (e) {
    console.error('linear push failed:', e);
  }

  return { topics: topics.length };
}

/**
 * Public entry point. Manages the meeting's reportStatus around generation so
 * the UI can show generating / failed / retry, and — on the first generation
 * (notify) — the meeting is ALWAYS marked ended, even when the model fails, so
 * it never hangs in `live` and always lands in the archive.
 */
export async function generateMeetingReport(
  meetingId: string,
  opts: { notify?: boolean } = {}
): Promise<{ topics: number }> {
  await prisma.meeting
    .update({ where: { id: meetingId }, data: { reportStatus: 'generating', reportError: null } })
    .catch(() => {});
  try {
    const result = await generateReportInner(meetingId, opts);
    await prisma.meeting
      .update({
        where: { id: meetingId },
        data: {
          reportStatus: result.topics > 0 ? 'ready' : null,
          ...(opts.notify ? { status: 'ended', endedAt: new Date() } : {}),
        },
      })
      .catch(() => {});
    return result;
  } catch (e) {
    const message = (e instanceof Error ? e.message : String(e)).slice(0, 500);
    await prisma.meeting
      .update({
        where: { id: meetingId },
        data: {
          reportStatus: 'failed',
          reportError: message,
          ...(opts.notify ? { status: 'ended', endedAt: new Date() } : {}),
        },
      })
      .catch(() => {});
    throw e;
  }
}

/**
 * Regenerate the report from the current transcript (e.g. after a manual
 * language fix). No notifications/emails. Thin wrapper over generateMeetingReport.
 */
export async function regenerateMeetingReport(meetingId: string): Promise<void> {
  await generateMeetingReport(meetingId, { notify: false });
}
