// Grounded meeting chat — answers questions about ONE meeting using only its
// transcript, and streams the answer back token-by-token. History is ephemeral
// (the client keeps it in memory and replays it on each turn); nothing is stored.
//
// The chat ALWAYS uses the fast model (deepseek-v4-flash) regardless of the
// configured report model: chat must feel snappy, while a reasoning model would
// add minutes of latency per message.
import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { getDeepSeekConfig } from '@/lib/config';
import { sseJsonChunks, chunkDelta } from '@/lib/sse';
import { workspaceLocale } from '@/lib/i18n-server';

export const maxDuration = 120;

const MAX_TRANSCRIPT_CHARS = 60000; // keep the prompt well within the model's window
const MAX_HISTORY = 12; // last N turns sent back as context
const MAX_MSG_CHARS = 4000; // clamp any single message

type ChatMsg = { role: 'user' | 'assistant'; content: string };

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: meetingId } = await params;

  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const userId = session.user.id;
  const userRole = session.user.role;

  // Same access rule as GET /api/meetings/:id — admin, creator or participant.
  const meeting = await prisma.meeting.findUnique({
    where: { id: meetingId },
    select: {
      id: true,
      title: true,
      scheduledAt: true,
      createdById: true,
      participants: { select: { userId: true, guestName: true, user: { select: { name: true } } } },
    },
  });
  if (!meeting) {
    return NextResponse.json({ error: 'Meeting not found' }, { status: 404 });
  }
  if (userRole !== 'admin') {
    const isCreator = meeting.createdById === userId;
    const isParticipant = meeting.participants.some((p) => p.userId === userId);
    if (!isCreator && !isParticipant) {
      return NextResponse.json({ error: 'Meeting not found' }, { status: 404 });
    }
  }

  const body = await req.json().catch(() => ({}));
  const history: ChatMsg[] = (Array.isArray(body.messages) ? body.messages : [])
    .filter(
      (m: any) =>
        m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim()
    )
    .slice(-MAX_HISTORY)
    .map((m: any) => ({ role: m.role, content: String(m.content).slice(0, MAX_MSG_CHARS) }));
  if (history.length === 0 || history[history.length - 1].role !== 'user') {
    return NextResponse.json({ error: 'Last message must be from the user' }, { status: 400 });
  }

  const segments = await prisma.transcriptSegment.findMany({
    where: { meetingId },
    orderBy: { startTime: 'asc' },
    select: { speakerName: true, content: true },
  });
  if (segments.length === 0) {
    return NextResponse.json({ error: 'No transcript for this meeting' }, { status: 422 });
  }

  const ds = await getDeepSeekConfig();
  if (!ds.apiKey) {
    return NextResponse.json({ error: 'DeepSeek API key not configured' }, { status: 500 });
  }

  const wsLoc = await workspaceLocale();
  const langName = wsLoc === 'uk' ? 'Ukrainian' : 'English';

  // 1-based numbered transcript — MUST match the client's transcript order
  // (both are ordered by startTime asc) so cited line numbers map to the right
  // moment when the user clicks a citation chip.
  let numbered = segments.map((s, i) => `${i + 1}. ${s.speakerName || '?'}: ${s.content}`).join('\n');
  let truncated = false;
  if (numbered.length > MAX_TRANSCRIPT_CHARS) {
    numbered = numbered.slice(0, MAX_TRANSCRIPT_CHARS);
    truncated = true;
  }

  const attendees = Array.from(
    new Set(
      [
        ...meeting.participants.map((p) => p.user?.name || p.guestName || ''),
        ...segments.map((s) => s.speakerName || ''),
      ].filter(Boolean)
    )
  ).join(', ');

  const dateStr = meeting.scheduledAt ? new Date(meeting.scheduledAt).toISOString().slice(0, 10) : 'unknown';

  const system = `You are an assistant that answers questions about ONE specific meeting, grounded ONLY in its transcript.

Meeting title: "${meeting.title}".
Date: ${dateStr}.
Attendees: ${attendees || 'unknown'}.

Rules:
- Reply in ${langName}, unless the user clearly writes in another language — then match the user's language.
- Use ONLY information present in the transcript below. If the answer is not in the transcript, say plainly that it was not discussed in this meeting. NEVER invent facts, names, numbers or decisions.
- Whenever you state something from the meeting, cite the supporting transcript line number(s) in square brackets — use specific single line numbers like [12] or [12, 15], NOT ranges like [12-18]. Cite precisely; never fabricate a line number.
- Be concise and well-structured. Use plain text — you may use **bold** for key terms and short "-" bullet lists. Do NOT use markdown headings, tables, code fences or images.
${truncated ? '- NOTE: the transcript was truncated for length; answer from what is available and say so if a detail might be missing.\n' : ''}
TRANSCRIPT (numbered, "speaker: text"):
${numbered}`;

  let upstream: Response;
  try {
    upstream = await fetch(`${ds.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ds.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ds.model,
        messages: [{ role: 'system', content: system }, ...history],
        temperature: 0.3,
        max_tokens: Math.min(8000, ds.maxTokens ?? 8000),
        stream: true,
      }),
    });
  } catch (e: any) {
    return NextResponse.json({ error: `DeepSeek request failed: ${e?.message || 'unknown error'}` }, { status: 502 });
  }
  if (!upstream.ok || !upstream.body) {
    const txt = upstream.ok ? '' : await upstream.text().catch(() => '');
    return NextResponse.json({ error: `DeepSeek ${upstream.status}: ${txt.slice(0, 200)}` }, { status: 502 });
  }

  // Re-stream the OpenAI-compatible SSE as plain text deltas to the client.
  const encoder = new TextEncoder();
  const reader = upstream.body.getReader();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of sseJsonChunks(reader)) {
          const delta = chunkDelta(chunk);
          if (delta) controller.enqueue(encoder.encode(delta));
        }
      } catch {
        /* upstream aborted — just close */
      } finally {
        controller.close();
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    },
  });
}
