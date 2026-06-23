import { NextRequest, NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { auth } from '@/lib/auth';
import { getLlmConfig, LLM_PRESETS, type LlmProvider } from '@/lib/config';

const PROVIDERS = Object.keys(LLM_PRESETS) as LlmProvider[];

function normBase(u: string): string {
  return (u || '').trim().replace(/\/+$/, '').replace(/\/v1$/i, '').replace(/\/+$/, '');
}

type ModelInfo = { id: string; maxOutput: number | null; contextLength: number | null };

/**
 * Best-effort known output/context limits for common models, since most provider
 * `/v1/models` endpoints return ids only (OpenRouter is the exception and its API
 * values always win). Matched on the id's last path segment, most-specific first.
 * A convenience for the picker — admins can still override the token field.
 */
const KNOWN_LIMITS: { match: RegExp; maxOutput: number; contextLength: number }[] = [
  { match: /claude-(opus-4|fable-5|mythos-5)/, maxOutput: 128000, contextLength: 1000000 },
  { match: /claude-sonnet-4/, maxOutput: 64000, contextLength: 1000000 },
  { match: /claude-haiku-4/, maxOutput: 64000, contextLength: 200000 },
  { match: /claude-3-5-haiku/, maxOutput: 8192, contextLength: 200000 },
  { match: /claude-3/, maxOutput: 8192, contextLength: 200000 },
  { match: /deepseek-(v4|chat|reasoner)/, maxOutput: 65536, contextLength: 1000000 },
  { match: /gpt-4\.1/, maxOutput: 32768, contextLength: 1000000 },
  { match: /gpt-4o/, maxOutput: 16384, contextLength: 128000 },
  { match: /^(o1|o3|o4)/, maxOutput: 100000, contextLength: 200000 },
  { match: /gpt-4/, maxOutput: 4096, contextLength: 128000 },
  { match: /gpt-3\.5/, maxOutput: 4096, contextLength: 16385 },
];

function knownLimits(id: string): { maxOutput: number | null; contextLength: number | null } {
  const base = id.toLowerCase().split('/').pop() || '';
  const hit = KNOWN_LIMITS.find((k) => k.match.test(base));
  return hit ? { maxOutput: hit.maxOutput, contextLength: hit.contextLength } : { maxOutput: null, contextLength: null };
}

// POST /api/settings/ai/models — list the provider's available models for the
// dropdown. Uses the values typed in the modal (provider/baseUrl/apiKey) when given,
// else the saved config. Only OpenRouter exposes per-model token limits; for the
// rest the admin sets max output manually.
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const errT = await getTranslations('errors');
  const body = await req.json().catch(() => ({}));

  const saved = await getLlmConfig();
  const provider: LlmProvider = PROVIDERS.includes(body.provider) ? body.provider : saved.provider;
  const preset = LLM_PRESETS[provider];
  const base = normBase(typeof body.baseUrl === 'string' && body.baseUrl.trim() ? body.baseUrl : (saved.baseUrl || preset.baseUrl));
  // A real (non-masked) key typed in the modal wins; else the saved decrypted key.
  const typed = typeof body.apiKey === 'string' && body.apiKey.trim() && !/^[•*]+$/.test(body.apiKey.trim()) ? body.apiKey.trim() : '';
  const apiKey = typed || saved.apiKey;

  if (!base) return NextResponse.json({ error: errT('notConfigured') }, { status: 400 });
  if (!apiKey && !preset.keyless) return NextResponse.json({ error: errT('deepseekKeyMissing') }, { status: 400 });

  // Anthropic's model list is the native endpoint (x-api-key + version); the rest
  // are OpenAI-compatible (Bearer). Ollama needs no key.
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (provider === 'anthropic') {
    if (apiKey) headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  try {
    const res = await fetch(`${base}/v1/models`, { method: 'GET', headers, signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return NextResponse.json({ error: `${preset.label} ${res.status}: ${t.slice(0, 140)}` }, { status: 502 });
    }
    const json = await res.json().catch(() => ({}));
    const rows: any[] = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];
    const seen = new Set<string>();
    const models: ModelInfo[] = [];
    for (const m of rows) {
      const id = typeof m?.id === 'string' ? m.id : (typeof m?.name === 'string' ? m.name : '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      // API value wins (OpenRouter); fall back to the curated map for the rest.
      const known = knownLimits(id);
      const maxOutput = (Number(m?.top_provider?.max_completion_tokens ?? m?.max_completion_tokens ?? m?.max_output_tokens) || null) ?? null;
      const contextLength = (Number(m?.context_length ?? m?.top_provider?.context_length ?? m?.context_window) || null) ?? null;
      models.push({ id, maxOutput: maxOutput ?? known.maxOutput, contextLength: contextLength ?? known.contextLength });
    }
    models.sort((a, b) => a.id.localeCompare(b.id));
    return NextResponse.json({ models: models.slice(0, 1000) });
  } catch (e: any) {
    return NextResponse.json({ error: (e?.message || errT('connectionFailed')).slice(0, 200) }, { status: 502 });
  }
}
