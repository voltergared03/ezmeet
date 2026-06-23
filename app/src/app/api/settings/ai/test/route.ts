import { NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { auth } from '@/lib/auth';
import { getLlmConfig, LLM_PRESETS } from '@/lib/config';

// POST /api/settings/ai/test — validate the active provider with a 1-token call.
export async function POST() {
  const session = await auth();
  if (!session?.user || session.user.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const errT = await getTranslations('errors');
  const { provider, apiKey, baseUrl, model } = await getLlmConfig();
  const keyless = !!LLM_PRESETS[provider]?.keyless; // e.g. local Ollama needs no key
  if (!apiKey && !keyless) {
    return NextResponse.json({ error: errT('deepseekKeyMissing') }, { status: 400 });
  }
  if (!baseUrl) {
    return NextResponse.json({ error: errT('notConfigured') }, { status: 400 });
  }
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      return NextResponse.json({ error: `${LLM_PRESETS[provider].label} ${res.status}: ${t.slice(0, 140)}` }, { status: 502 });
    }
    return NextResponse.json({ success: true, model });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || errT('connectionFailed') }, { status: 502 });
  }
}
