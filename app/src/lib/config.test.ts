import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockReset } from 'vitest-mock-extended';
import { prisma as prismaMock } from '@/lib/__mocks__/prisma';
import { getLlmConfig, getDeepSeekConfig } from '@/lib/config';

vi.mock('@/lib/prisma');
vi.mock('@/lib/twofactor', () => ({
  decryptSecret: vi.fn((x: string) => x.replace(/^v1\./, 'DEC:')),
  encryptSecret: vi.fn((x: string) => `v1.${x}`),
}));

const rows = (obj: Record<string, string>) => Object.entries(obj).map(([key, value]) => ({ key, value }));

beforeEach(() => {
  mockReset(prismaMock);
  for (const k of ['AI_API_KEY', 'AI_BASE_URL', 'AI_MODEL', 'DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_MODEL']) delete process.env[k];
});

describe('getLlmConfig', () => {
  it('defaults to the DeepSeek preset when nothing is configured', async () => {
    prismaMock.systemConfig.findMany.mockResolvedValue([] as any);
    expect(await getLlmConfig()).toMatchObject({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: '' });
  });

  it('falls back to legacy DEEPSEEK_* (back-compat, plaintext key)', async () => {
    prismaMock.systemConfig.findMany.mockResolvedValue(rows({ DEEPSEEK_API_KEY: 'sk-legacy', DEEPSEEK_MODEL: 'deepseek-reasoner' }) as any);
    expect(await getLlmConfig()).toMatchObject({ provider: 'deepseek', apiKey: 'sk-legacy', model: 'deepseek-reasoner' });
  });

  it('honours the selected provider and decrypts an encrypted AI_API_KEY', async () => {
    prismaMock.systemConfig.findMany.mockResolvedValue(rows({ AI_PROVIDER: 'openrouter', AI_API_KEY: 'v1.sk-or', AI_BASE_URL: 'https://openrouter.ai/api', AI_MODEL: 'anthropic/claude-opus-4-8' }) as any);
    expect(await getLlmConfig()).toMatchObject({ provider: 'openrouter', baseUrl: 'https://openrouter.ai/api', model: 'anthropic/claude-opus-4-8', apiKey: 'DEC:sk-or' });
  });

  it('normalizes a trailing /v1 in the base URL (callers append /v1/chat/completions)', async () => {
    prismaMock.systemConfig.findMany.mockResolvedValue(rows({ AI_PROVIDER: 'openai', AI_BASE_URL: 'https://api.openai.com/v1/', AI_MODEL: 'gpt-4o' }) as any);
    expect((await getLlmConfig()).baseUrl).toBe('https://api.openai.com');
  });

  it('AI_* wins over legacy DEEPSEEK_*', async () => {
    prismaMock.systemConfig.findMany.mockResolvedValue(rows({ AI_PROVIDER: 'anthropic', AI_API_KEY: 'v1.k', AI_BASE_URL: 'https://api.anthropic.com', AI_MODEL: 'claude-opus-4-8', DEEPSEEK_API_KEY: 'old', DEEPSEEK_MODEL: 'deepseek-chat' }) as any);
    expect(await getLlmConfig()).toMatchObject({ provider: 'anthropic', model: 'claude-opus-4-8', apiKey: 'DEC:k' });
  });

  it('an invalid AI_PROVIDER falls back to deepseek', async () => {
    prismaMock.systemConfig.findMany.mockResolvedValue(rows({ AI_PROVIDER: 'bogus' }) as any);
    expect((await getLlmConfig()).provider).toBe('deepseek');
  });

  it('getDeepSeekConfig delegates to the active provider (keyless Ollama)', async () => {
    prismaMock.systemConfig.findMany.mockResolvedValue(rows({ AI_PROVIDER: 'ollama', AI_BASE_URL: 'http://localhost:11434', AI_MODEL: 'llama3.1' }) as any);
    expect(await getDeepSeekConfig()).toEqual({ apiKey: '', baseUrl: 'http://localhost:11434', model: 'llama3.1', maxTokens: null });
  });

  it('maxTokens is null when unset and a positive integer when set', async () => {
    prismaMock.systemConfig.findMany.mockResolvedValue([] as any);
    expect((await getLlmConfig()).maxTokens).toBeNull();
    prismaMock.systemConfig.findMany.mockResolvedValue(rows({ AI_MAX_TOKENS: '32000' }) as any);
    expect((await getLlmConfig()).maxTokens).toBe(32000);
    prismaMock.systemConfig.findMany.mockResolvedValue(rows({ AI_MAX_TOKENS: '0' }) as any);
    expect((await getLlmConfig()).maxTokens).toBeNull(); // 0 / invalid → fall back to defaults
  });
});
