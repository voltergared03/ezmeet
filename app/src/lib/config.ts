import { prisma } from './prisma';
import { decryptSecret } from './twofactor';

/** Read multiple SystemConfig keys at once → { key: value }. Missing keys are absent. */
export async function readConfig(keys: string[]): Promise<Record<string, string>> {
  const rows = await prisma.systemConfig.findMany({ where: { key: { in: keys } } });
  const m: Record<string, string> = {};
  for (const r of rows) m[r.key] = r.value ?? '';
  return m;
}

/** Upsert multiple SystemConfig keys. */
export async function writeConfig(updates: Record<string, string>): Promise<void> {
  for (const [key, value] of Object.entries(updates)) {
    await prisma.systemConfig.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });
  }
}

/**
 * Pluggable AI provider. Every option speaks the OpenAI-compatible
 * `/v1/chat/completions` wire format, so the whole app reaches them through the
 * same SSE client — switching provider is config only, no code path changes.
 * `claude` is reached via OpenRouter or Anthropic's OpenAI-compatible endpoint
 * (Garely's AI path is OpenAI-shaped; we don't run the native Anthropic SDK here).
 */
export type LlmProvider = 'deepseek' | 'openrouter' | 'openai' | 'anthropic' | 'ollama' | 'custom';

/** baseUrl carries NO trailing `/v1` — call sites append `/v1/chat/completions`. */
export const LLM_PRESETS: Record<LlmProvider, { label: string; baseUrl: string; model: string; keyless?: boolean }> = {
  deepseek:   { label: 'DeepSeek',                  baseUrl: 'https://api.deepseek.com',  model: 'deepseek-chat' },
  openrouter: { label: 'OpenRouter',                baseUrl: 'https://openrouter.ai/api', model: 'anthropic/claude-opus-4-8' },
  openai:     { label: 'OpenAI',                    baseUrl: 'https://api.openai.com',    model: 'gpt-4o' },
  anthropic:  { label: 'Anthropic (Claude)',        baseUrl: 'https://api.anthropic.com', model: 'claude-opus-4-8' },
  ollama:     { label: 'Ollama (local)',            baseUrl: 'http://localhost:11434',    model: 'llama3.1', keyless: true },
  custom:     { label: 'Custom (OpenAI-compatible)', baseUrl: '',                          model: '' },
};

const LLM_PROVIDERS = Object.keys(LLM_PRESETS) as LlmProvider[];

/** Decrypt a stored secret (AES-GCM `v1.…`); tolerate a legacy plaintext value. */
function decKey(stored: string | null | undefined): string {
  const raw = (stored || '').trim();
  if (!raw) return '';
  if (raw.startsWith('v1.')) { try { return decryptSecret(raw); } catch { return ''; } }
  return raw;
}

/** Normalize a base URL: drop trailing slashes and an accidental trailing `/v1`. */
function normBase(u: string): string {
  return (u || '').trim().replace(/\/+$/, '').replace(/\/v1$/i, '').replace(/\/+$/, '');
}

/**
 * Active LLM provider config. New `AI_*` keys win; falls back to the legacy
 * `DEEPSEEK_*` keys/env so existing installs keep working with zero reconfig.
 */
export async function getLlmConfig(): Promise<{ provider: LlmProvider; apiKey: string; baseUrl: string; model: string }> {
  const m = await readConfig(['AI_PROVIDER', 'AI_API_KEY', 'AI_BASE_URL', 'AI_MODEL', 'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_MODEL']);
  const provider = LLM_PROVIDERS.includes(m.AI_PROVIDER as LlmProvider) ? (m.AI_PROVIDER as LlmProvider) : 'deepseek';
  const preset = LLM_PRESETS[provider];
  return {
    provider,
    apiKey: decKey(m.AI_API_KEY) || m.DEEPSEEK_API_KEY || process.env.AI_API_KEY || process.env.DEEPSEEK_API_KEY || '',
    baseUrl: normBase(m.AI_BASE_URL || m.DEEPSEEK_BASE_URL || process.env.AI_BASE_URL || process.env.DEEPSEEK_BASE_URL || preset.baseUrl),
    model: m.AI_MODEL || m.DEEPSEEK_MODEL || process.env.AI_MODEL || process.env.DEEPSEEK_MODEL || preset.model,
  };
}

/**
 * @deprecated Back-compat shim — resolves the *active* provider (DeepSeek or
 * whatever the admin selected) via {@link getLlmConfig}. Existing AI call sites
 * keep calling this and transparently pick up the configured provider.
 */
export async function getDeepSeekConfig(): Promise<{ apiKey: string; baseUrl: string; model: string }> {
  const { apiKey, baseUrl, model } = await getLlmConfig();
  return { apiKey, baseUrl, model };
}

/** Google OAuth credentials — DB first (set via /setup), env fallback. */
export async function getGoogleConfig(): Promise<{ clientId: string; clientSecret: string }> {
  const m = await readConfig(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET']);
  return {
    clientId: m.GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: m.GOOGLE_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || '',
  };
}

/**
 * Public-facing base URL for links in user-facing emails (invites, password
 * setup, reports, reminders, digests). It is CRITICAL not to use APP_URL on its
 * own: that is the INTERNAL Docker address (e.g. http://eam-meet:3000) the app
 * and agent use to call each other, and it is unreachable for email recipients.
 * Priority: configured workspace domain → public env URLs → (last resort) APP_URL.
 * Returns '' when nothing is configured (callers then omit the link).
 */
export async function publicBaseUrl(): Promise<string> {
  const m = await readConfig(['WS_DOMAIN']);
  const dom = (m.WS_DOMAIN || '').trim();
  if (dom) {
    const url = /^https?:\/\//i.test(dom) ? dom : `https://${dom}`;
    return url.replace(/\/+$/, '');
  }
  const env =
    process.env.PUBLIC_URL ||
    process.env.NEXTAUTH_URL ||
    process.env.AUTH_URL ||
    process.env.APP_URL ||
    '';
  return env.replace(/\/+$/, '');
}

export interface AuthConfig {
  googleEnabled: boolean;
  passwordEnabled: boolean;
  selfReg: boolean; // self-registration with admin approval (requires passwordEnabled)
  selfRegDomains: string[]; // allowlist; empty = any domain
  requestTtlDays: number; // self-reg request lifetime
}

/**
 * Which sign-in methods are active. BACKWARD-COMPATIBLE: existing deployments
 * have no AUTH_* keys, so Google stays on iff its credentials exist, while
 * password + self-registration default OFF. Nothing changes until an admin
 * toggles them in /setup or Settings.
 */
export async function getAuthConfig(): Promise<AuthConfig> {
  const m = await readConfig([
    'AUTH_GOOGLE_ENABLED',
    'AUTH_PASSWORD_ENABLED',
    'AUTH_SELFREG',
    'AUTH_SELFREG_DOMAINS',
    'AUTH_REQUEST_TTL_DAYS',
  ]);
  const google = await getGoogleConfig();
  const hasGoogleCreds = !!(google.clientId && google.clientSecret);

  const googleEnabled =
    m.AUTH_GOOGLE_ENABLED !== undefined && m.AUTH_GOOGLE_ENABLED !== ''
      ? m.AUTH_GOOGLE_ENABLED === 'true'
      : hasGoogleCreds; // legacy default: on when Google is configured

  const passwordEnabled = m.AUTH_PASSWORD_ENABLED === 'true';
  const selfReg = passwordEnabled && m.AUTH_SELFREG === 'true';
  const selfRegDomains = (m.AUTH_SELFREG_DOMAINS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const ttl = parseInt(m.AUTH_REQUEST_TTL_DAYS || '', 10);
  const requestTtlDays = Number.isFinite(ttl) && ttl > 0 ? ttl : 3;

  return { googleEnabled, passwordEnabled, selfReg, selfRegDomains, requestTtlDays };
}

/** Is this email permitted to self-register? (Empty allowlist = any domain.) */
export function emailAllowedForSelfReg(email: string, domains: string[]): boolean {
  if (!domains.length) return true;
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  return domains.includes(email.slice(at + 1).toLowerCase());
}

/** The product/platform brand name (constant — the hosted SaaS + self-host build).
 *  Decoupled from WS_NAME, which is the per-workspace/tenant label (e.g. "EAM").
 *  Use this for product chrome: page title, PWA name, auth screens, email from-name. */
export const PRODUCT_NAME = 'Garely';

/** Defaults for workspace + pricing config (used when a key is not set). */
export const CONFIG_DEFAULTS: Record<string, string> = {
  WS_NAME: 'Garely',
  WS_DOMAIN: '',
  WS_TIMEZONE: 'Europe/Kyiv',
  WS_LANGUAGE: 'en',
  WS_GUEST_ACCESS: 'true',
  WS_AI_SUMMARY: 'true',
  WS_LIVE_TRANSCRIPTION: 'true',
  WS_RECORD_ALL: 'false',
  WS_REQUIRE_2FA: 'false',
  WS_MAX_PARTICIPANTS: '20',
  WS_MAX_DURATION_MIN: '240',
  WS_RETENTION_DAYS: '0',
  PRICE_DEEPSEEK_IN: '0.27',
  PRICE_DEEPSEEK_OUT: '1.10',
  PRICE_DEEPGRAM_MIN: '0.0043',
  EMAIL_LIMIT: '3000',
};

/** Read a numeric config value with default fallback. */
export function num(map: Record<string, string>, key: string): number {
  const v = map[key];
  const n = v !== undefined && v !== '' ? Number(v) : Number(CONFIG_DEFAULTS[key]);
  return Number.isFinite(n) ? n : Number(CONFIG_DEFAULTS[key]) || 0;
}
