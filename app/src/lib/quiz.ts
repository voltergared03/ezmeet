import { prisma } from './prisma';
import { getDeepSeekConfig } from './config';
import { workspaceLocale } from './i18n-server';

// Stored question shape (Quiz.questions Json):
//   { id, prompt, type: 'single'|'multi', options: [{id,text}], correctOptionIds: string[], cites: number[] }
export interface QuizOption {
  id: string;
  text: string;
}
export interface QuizQuestion {
  id: string;
  prompt: string;
  type: 'single' | 'multi';
  options: QuizOption[];
  correctOptionIds: string[];
  cites: number[];
}

/** Robustly parse an LLM JSON reply (handles ```fences``` and surrounding prose). */
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

/** Normalize a raw AI question into the stored shape, or null if unusable. */
function normalizeQuestion(raw: any): Omit<QuizQuestion, 'id'> | null {
  const prompt = String(raw?.prompt ?? raw?.question ?? '').trim();
  const rawOpts = Array.isArray(raw?.options) ? raw.options : [];
  const options: QuizOption[] = rawOpts
    .map((o: any, j: number) => ({
      id: `o${j + 1}`,
      text: String(typeof o === 'string' ? o : (o?.text ?? '')).trim(),
    }))
    .filter((o: QuizOption) => o.text);
  if (!prompt || options.length < 2) return null;

  // "correct" may be an index, an array of indices, or option text(s).
  const c = raw?.correct ?? raw?.correctIndex ?? raw?.answer ?? raw?.correctOptionIndex;
  const arr = Array.isArray(c) ? c : [c];
  const correctIdx: number[] = [];
  for (const v of arr) {
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < options.length) {
      correctIdx.push(v);
    } else if (typeof v === 'string') {
      const k = options.findIndex((o) => o.text.toLowerCase() === v.trim().toLowerCase());
      if (k >= 0) correctIdx.push(k);
    }
  }
  const uniq = [...new Set(correctIdx)];
  if (uniq.length < 1) return null;
  const correctOptionIds = uniq.map((n) => `o${n + 1}`);
  const type: 'single' | 'multi' =
    raw?.type === 'multi' || correctOptionIds.length > 1 ? 'multi' : 'single';
  return { prompt, type, options, correctOptionIds, cites: [] };
}

/**
 * Generate multiple-choice comprehension questions from a meeting's report.
 * Grounds ONLY on the (already distilled, accurate) report summary + topics.
 * Returns the stored question shape. Throws 'no_report' / 'no_ai_key' /
 * 'ai_no_questions' on failure.
 */
export async function generateQuizQuestions(meetingId: string, count = 5): Promise<QuizQuestion[]> {
  const report = await prisma.meetingReport.findFirst({
    where: { meetingId },
    orderBy: { generatedAt: 'desc' },
    select: { summary: true, topics: true },
  });
  if (!report || (!report.summary && !report.topics)) throw new Error('no_report');

  const loc = await workspaceLocale();
  const langName = loc === 'uk' ? 'Ukrainian' : 'English';
  const grounding = JSON.stringify({ summary: report.summary, topics: report.topics }).slice(0, 24000);

  const prompt = `You are creating a short comprehension quiz to verify that meeting attendees actually understood the meeting. Using ONLY the meeting report below, write ${count} multiple-choice questions in ${langName}.
Rules:
- Cover the main topics, decisions and open questions — test understanding, not trivia.
- Each question has 2-4 answer options. Most should be single-answer; include a multi-answer question only when genuinely appropriate.
- Base every question and every option ONLY on facts present in the report. Do NOT invent facts.
- Make wrong options plausible but clearly incorrect per the report.
- Write ALL text (questions and options) in ${langName}.
- Respond with valid JSON only, in exactly this shape:
{"questions":[{"prompt":"...","type":"single","options":["A","B","C","D"],"correct":[0]}]}
("correct" is an array of 0-based indices into that question's "options".)

MEETING REPORT (JSON):
${grounding}`;

  const ds = await getDeepSeekConfig();
  if (!ds.apiKey) throw new Error('no_ai_key');

  const res = await fetch(`${ds.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ds.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: ds.model,
      messages: [
        { role: 'system', content: 'You are a meeting comprehension quiz generator. Always respond with valid JSON.' },
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3,
      // The configured model may be a reasoning model that spends tokens on
      // hidden reasoning before emitting `content`; keep a generous budget so
      // the JSON answer isn't truncated (the report generator uses 64000).
      max_tokens: Math.min(16000, ds.maxTokens ?? 16000),
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error('[quiz] deepseek http', res.status, body.slice(0, 300));
    throw new Error(`ai_http_${res.status}`);
  }
  const data = await res.json();
  const content: string = data?.choices?.[0]?.message?.content ?? '';
  const parsed = parseJsonLoose(content);
  const rawQs = Array.isArray(parsed?.questions) ? parsed.questions : [];

  const questions: QuizQuestion[] = rawQs
    .map((q: any) => normalizeQuestion(q))
    .filter((q: Omit<QuizQuestion, 'id'> | null): q is Omit<QuizQuestion, 'id'> => !!q)
    .map((q: Omit<QuizQuestion, 'id'>, i: number) => ({ id: `q${i + 1}`, ...q }));

  if (questions.length === 0) {
    console.error(
      '[quiz] no questions parsed — finish_reason=',
      data?.choices?.[0]?.finish_reason,
      'contentLen=',
      content.length,
    );
    throw new Error('ai_no_questions');
  }
  return questions;
}

/**
 * Grade a set of answers against a quiz's questions.
 * `answers` maps questionId → selected optionIds. A question is correct when the
 * selected set EXACTLY equals the correct set (order-independent).
 */
export function gradeQuiz(
  questions: QuizQuestion[],
  answers: Record<string, string[]>,
): { score: number; maxScore: number } {
  let score = 0;
  for (const q of questions) {
    const sel = new Set((answers?.[q.id] ?? []).map(String));
    const correct = new Set(q.correctOptionIds.map(String));
    if (sel.size === correct.size && [...correct].every((c) => sel.has(c))) score++;
  }
  return { score, maxScore: questions.length };
}
