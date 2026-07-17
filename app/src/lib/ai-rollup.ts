// AI weekly rollup (Phase 4.3) — turns a user's open-task list into a short,
// friendly "where to focus this week" summary for the weekly digest email.
//
// Strictly best-effort: any missing key / error / timeout returns null and the
// digest falls back to its plain task list. It never throws and never blocks
// the digest. Summarizes only the recipient's OWN tasks (no cross-user data).
import { getDeepSeekConfig } from './config';
import { sseJsonChunks, chunkDelta } from './sse';

export async function aiWeeklyRollup(input: {
  name: string | null;
  taskTitles: string[];
  meetingCount: number;
  langName: string; // English name of the AI-output language, e.g. 'Ukrainian' | 'Russian' | 'English'
}): Promise<string | null> {
  try {
    const ds = await getDeepSeekConfig();
    if (!ds.apiKey || input.taskTitles.length === 0) return null;

    const list = input.taskTitles.slice(0, 25).map((t, i) => `${i + 1}. ${t}`).join('\n');
    const prompt = `Write a SHORT (2-3 sentences) weekly work rollup for ${input.name || 'a teammate'} in ${input.langName}. This week they attended ${input.meetingCount} meeting(s) and have these open tasks:\n${list}\n\nIn a warm, professional tone, tell them where to focus: group or prioritise the work, call out the few highest-impact items, and end with a brief encouraging note. Plain text only — no markdown, no bullet lists, no preamble, just the 2-3 sentence summary.`;

    const res = await fetch(`${ds.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ds.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: ds.model,
        messages: [
          { role: 'system', content: 'You write concise, friendly weekly work summaries. Plain text only.' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.5,
        max_tokens: 2000,
        stream: true,
      }),
      // Hard 8s bound: the digest cron loops over users, so an unbounded call
      // would blow the cron's request timeout. On timeout → reject → null → the
      // digest sends its plain task list.
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok || !res.body) return null;

    let content = '';
    for await (const chunk of sseJsonChunks(res.body.getReader())) content += chunkDelta(chunk);
    const text = content.trim();
    return text ? text.slice(0, 800) : null;
  } catch {
    return null; // never let the rollup break the digest
  }
}
