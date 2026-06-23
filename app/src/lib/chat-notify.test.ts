import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockReset } from 'vitest-mock-extended';
import { prisma as prismaMock } from '@/lib/__mocks__/prisma';
import { readConfig } from '@/lib/config';
import { getChatConfig, sendChatMessage, notifyChatReportReady, type ChatConfig } from '@/lib/chat-notify';

vi.mock('@/lib/prisma');
vi.mock('@/lib/config', () => ({
  readConfig: vi.fn(async () => ({})),
  publicBaseUrl: vi.fn(async () => 'https://meet.example.com'),
  writeConfig: vi.fn(async () => {}),
}));
vi.mock('@/lib/twofactor', () => ({ decryptSecret: vi.fn((x: string) => x), encryptSecret: vi.fn((x: string) => x) }));
vi.mock('@/lib/i18n-server', () => ({
  getTranslator: vi.fn(() => (k: string, v?: Record<string, unknown>) => (v?.title ? `${k}:${v.title}` : k)),
  workspaceLocale: vi.fn(async () => 'en'),
}));

const mockReadConfig = vi.mocked(readConfig);

function installFetch() {
  const calls: { url: string; body: any }[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' } as Response;
  });
  vi.stubGlobal('fetch', fetchMock as any);
  return { calls, fetchMock };
}

beforeEach(() => { mockReset(prismaMock); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('getChatConfig', () => {
  it('is null when disabled', async () => {
    mockReadConfig.mockResolvedValue({ CHAT_ENABLED: 'false' } as any);
    expect(await getChatConfig()).toBeNull();
  });
  it('telegram requires bot token AND chat id', async () => {
    mockReadConfig.mockResolvedValue({ CHAT_ENABLED: 'true', CHAT_PROVIDER: 'telegram', CHAT_BOT_TOKEN: 'tok', CHAT_CHAT_ID: '' } as any);
    expect(await getChatConfig()).toBeNull();
    mockReadConfig.mockResolvedValue({ CHAT_ENABLED: 'true', CHAT_PROVIDER: 'telegram', CHAT_BOT_TOKEN: 'tok', CHAT_CHAT_ID: '123' } as any);
    expect(await getChatConfig()).toMatchObject({ provider: 'telegram', botToken: 'tok', chatId: '123' });
  });
  it('webhook providers require a URL', async () => {
    mockReadConfig.mockResolvedValue({ CHAT_ENABLED: 'true', CHAT_PROVIDER: 'slack', CHAT_WEBHOOK_URL: 'https://hook' } as any);
    expect((await getChatConfig())?.webhookUrl).toBe('https://hook');
    mockReadConfig.mockResolvedValue({ CHAT_ENABLED: 'true', CHAT_PROVIDER: 'discord', CHAT_WEBHOOK_URL: '' } as any);
    expect(await getChatConfig()).toBeNull();
  });
});

describe('sendChatMessage', () => {
  it('telegram → bot sendMessage with chat_id + text', async () => {
    const { calls } = installFetch();
    await sendChatMessage({ provider: 'telegram', botToken: 'TOK', chatId: '123', webhookUrl: '' }, 'hello');
    expect(calls[0].url).toContain('/botTOK/sendMessage');
    expect(calls[0].body).toMatchObject({ chat_id: '123', text: 'hello' });
  });
  it('discord uses { content }, slack/mattermost use { text }', async () => {
    const { calls } = installFetch();
    await sendChatMessage({ provider: 'discord', botToken: '', chatId: '', webhookUrl: 'https://d' }, 'x');
    await sendChatMessage({ provider: 'slack', botToken: '', chatId: '', webhookUrl: 'https://s' }, 'y');
    await sendChatMessage({ provider: 'mattermost', botToken: '', chatId: '', webhookUrl: 'https://m' }, 'z');
    expect(calls[0].body).toEqual({ content: 'x' });
    expect(calls[1].body).toEqual({ text: 'y' });
    expect(calls[2].body).toEqual({ text: 'z' });
  });
  it('reports a non-2xx as a failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => 'bad' }) as Response));
    const cfg: ChatConfig = { provider: 'slack', botToken: '', chatId: '', webhookUrl: 'https://s' };
    const r = await sendChatMessage(cfg, 'x');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('401');
  });
});

describe('notifyChatReportReady', () => {
  it('posts title + summary + decisions + report link', async () => {
    mockReadConfig.mockResolvedValue({ CHAT_ENABLED: 'true', CHAT_PROVIDER: 'telegram', CHAT_BOT_TOKEN: 'TOK', CHAT_CHAT_ID: '123' } as any);
    prismaMock.meeting.findUnique.mockResolvedValue({ title: 'Standup', reports: [{ summary: 'We shipped X.', decisions: ['Use Postgres', 'Ship Friday'] }] } as any);
    const { calls } = installFetch();

    await notifyChatReportReady('m1');

    const text = calls[0].body.text as string;
    expect(text).toContain('Standup');
    expect(text).toContain('We shipped X.');
    expect(text).toContain('Use Postgres');
    expect(text).toContain('https://meet.example.com/meetings/m1/report');
  });
  it('is a no-op when chat is not configured', async () => {
    mockReadConfig.mockResolvedValue({ CHAT_ENABLED: 'false' } as any);
    const { fetchMock } = installFetch();
    await notifyChatReportReady('m1');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
