import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { readConfig, writeConfig, getLlmConfig, LLM_PRESETS, type LlmProvider } from '@/lib/config';
import { encryptSecret } from '@/lib/twofactor';

const PROVIDERS = Object.keys(LLM_PRESETS) as LlmProvider[];

// GET /api/settings/ai — active provider config (the API key itself is never returned).
export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const cfg = await getLlmConfig();
  const raw = await readConfig(['AI_API_KEY', 'DEEPSEEK_API_KEY']);
  return NextResponse.json({
    provider: cfg.provider,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    apiKeySet: !!((raw.AI_API_KEY || raw.DEEPSEEK_API_KEY || process.env.AI_API_KEY || process.env.DEEPSEEK_API_KEY || '').trim()),
    presets: LLM_PRESETS,
  });
}

// PATCH /api/settings/ai — save provider, base URL, model; API key is encrypted at rest.
export async function PATCH(req: NextRequest) {
  const session = await auth();
  if (!session?.user || session.user.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }
  const body = await req.json().catch(() => ({}));

  const provider = body.provider as LlmProvider;
  if (!PROVIDERS.includes(provider)) {
    return NextResponse.json({ error: 'Invalid provider' }, { status: 400 });
  }
  const preset = LLM_PRESETS[provider];

  const updates: Record<string, string> = {
    AI_PROVIDER: provider,
    // Blank base/model fall back to the provider preset — and writing them
    // explicitly keeps a stale legacy DEEPSEEK_* value from leaking through.
    AI_BASE_URL: (typeof body.baseUrl === 'string' && body.baseUrl.trim()) ? body.baseUrl.trim() : preset.baseUrl,
    AI_MODEL: (typeof body.model === 'string' && body.model.trim()) ? body.model.trim() : preset.model,
  };
  // Only overwrite the key when a real value (not a masked placeholder) is supplied.
  const real = (v: unknown) => typeof v === 'string' && !!v.trim() && !/^[•*]+$/.test(v.trim());
  if (real(body.apiKey)) updates.AI_API_KEY = encryptSecret((body.apiKey as string).trim());

  await writeConfig(updates);
  return NextResponse.json({ success: true, updated: Object.keys(updates) });
}
