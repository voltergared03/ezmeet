import { prisma } from './prisma';
import { readConfig, publicBaseUrl } from './config';
import { decryptSecret } from './twofactor';
import { getTranslator, workspaceLocale } from './i18n-server';

/**
 * Outbound chat notifications — deliver Garely events (a meeting AI report is
 * ready, a meeting is starting) into the team's chat. One connector, four
 * providers: Telegram (bot token + chat id) and Slack / Mattermost / Discord
 * (incoming-webhook URL). Opt-in, non-blocking, fail-soft — never throws into the
 * caller. System text renders in the workspace (admin-chosen) locale, like emails.
 */

export type ChatProvider = 'telegram' | 'slack' | 'mattermost' | 'discord';

export interface ChatConfig {
  provider: ChatProvider;
  botToken: string; // telegram
  chatId: string; // telegram
  webhookUrl: string; // slack | mattermost | discord
}

const TIMEOUT_MS = 12_000;
const MAX_LEN = 3500; // safe across Telegram(4096)/Slack/Discord(2000-4000)

/** Stored secrets are AES-GCM ciphertext (v1.…); tolerate a raw value too. */
function dec(stored: string | null | undefined): string {
  const raw = (stored || '').trim();
  if (!raw) return '';
  if (raw.startsWith('v1.')) { try { return decryptSecret(raw); } catch { return ''; } }
  return raw;
}

async function loadChat(ignoreEnabled: boolean): Promise<ChatConfig | null> {
  const m = await readConfig(['CHAT_ENABLED', 'CHAT_PROVIDER', 'CHAT_BOT_TOKEN', 'CHAT_CHAT_ID', 'CHAT_WEBHOOK_URL']);
  if (!ignoreEnabled && m.CHAT_ENABLED !== 'true') return null;
  const provider = (['telegram', 'slack', 'mattermost', 'discord'] as ChatProvider[]).includes(m.CHAT_PROVIDER as ChatProvider)
    ? (m.CHAT_PROVIDER as ChatProvider) : 'telegram';
  const cfg: ChatConfig = { provider, botToken: dec(m.CHAT_BOT_TOKEN), chatId: (m.CHAT_CHAT_ID || '').trim(), webhookUrl: dec(m.CHAT_WEBHOOK_URL) };
  if (provider === 'telegram') return cfg.botToken && cfg.chatId ? cfg : null;
  return cfg.webhookUrl ? cfg : null;
}

/** Read + decrypt the chat config. Returns null when disabled or unconfigured. */
export async function getChatConfig(): Promise<ChatConfig | null> {
  return loadChat(false);
}

/** Whether a chat is configured (used by the settings status — no secrets). */
export async function isChatConfigured(): Promise<boolean> {
  return (await getChatConfig()) !== null;
}

// ─────────────────────────── transport ───────────────────────────

/** POST one plain-text message to the configured provider. Never throws. */
export async function sendChatMessage(cfg: ChatConfig, text: string): Promise<{ ok: boolean; error?: string }> {
  const body = text.length > MAX_LEN ? text.slice(0, MAX_LEN - 1) + '…' : text;
  try {
    if (cfg.provider === 'telegram') {
      const res = await fetch(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: cfg.chatId, text: body, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) return { ok: false, error: `Telegram ${res.status}: ${(await res.text().catch(() => '')).slice(0, 160)}` };
      return { ok: true };
    }
    // Slack / Mattermost (Slack-compatible) use { text }; Discord uses { content }.
    const payload = cfg.provider === 'discord' ? { content: body } : { text: body };
    const res = await fetch(cfg.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, error: `${cfg.provider} ${res.status}: ${(await res.text().catch(() => '')).slice(0, 120)}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Send a "Garely is connected" test message (works even before the toggle is on). */
export async function chatTest(): Promise<{ ok: boolean; error?: string }> {
  const cfg = await loadChat(true);
  if (!cfg) return { ok: false, error: 'not_configured' };
  const t = getTranslator(await workspaceLocale(), 'chat');
  return sendChatMessage(cfg, t('test'));
}

// ─────────────────────────── event messages (called from app flows) ───────────────────────────

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
}

/** Post a meeting's freshly-generated AI report (summary + decisions + link). */
export async function notifyChatReportReady(meetingId: string): Promise<void> {
  try {
    const cfg = await getChatConfig();
    if (!cfg) return;
    const meeting = await prisma.meeting.findUnique({
      where: { id: meetingId },
      select: { title: true, reports: { orderBy: { generatedAt: 'desc' }, take: 1, select: { summary: true, decisions: true } } },
    });
    if (!meeting) return;
    const rep = meeting.reports[0];
    const t = getTranslator(await workspaceLocale(), 'chat');
    const base = await publicBaseUrl();

    const lines: string[] = [t('reportReady', { title: meeting.title })];
    if (rep?.summary) lines.push('', truncate(rep.summary, 600));
    const decisions = Array.isArray(rep?.decisions)
      ? (rep!.decisions as unknown[]).filter((d): d is string => typeof d === 'string' && !!d.trim()).slice(0, 6)
      : [];
    if (decisions.length) { lines.push('', `${t('decisionsLabel')}:`); for (const d of decisions) lines.push(`• ${truncate(d, 160)}`); }
    if (base) lines.push('', `${base}/meetings/${meetingId}/report`);

    await sendChatMessage(cfg, lines.join('\n'));
  } catch (e) {
    console.error('[chat] report-ready send failed:', (e as Error).message);
  }
}

/** Post a "meeting starting soon" reminder. */
export async function notifyChatMeetingReminder(meetingId: string, title: string, time: string): Promise<void> {
  try {
    const cfg = await getChatConfig();
    if (!cfg) return;
    const t = getTranslator(await workspaceLocale(), 'chat');
    const base = await publicBaseUrl();
    const lines = [t('reminder', { title, time })];
    if (base) lines.push('', `${base}/lobby/${meetingId}`);
    await sendChatMessage(cfg, lines.join('\n'));
  } catch (e) {
    console.error('[chat] reminder send failed:', (e as Error).message);
  }
}
