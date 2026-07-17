// Server-side translation for non-request contexts (emails, cron jobs, push
// notifications). Uses next-intl's standalone `createTranslator` with the full
// message catalogs, so it works anywhere — no request scope needed. Each
// message is rendered in the *recipient's* locale, resolved from their saved
// preference → workspace default → 'en'.
import { createTranslator } from 'next-intl';
import en from '@/messages/en.json';
import uk from '@/messages/uk.json';
import { prisma } from './prisma';
import { readConfig, CONFIG_DEFAULTS } from './config';
import { DEFAULT_LOCALE, isLocale, type Locale } from '@/i18n/locales';

const MESSAGES: Record<Locale, Record<string, unknown>> = { en, uk };

/** A translator bound to a specific locale (+ optional namespace). */
export function getTranslator(locale: string, namespace?: string) {
  const loc: Locale = isLocale(locale) ? locale : DEFAULT_LOCALE;
  return createTranslator({ locale: loc, messages: MESSAGES[loc] as any, namespace });
}

// ─────────────────────────── AI output language ───────────────────────────
// A DIFFERENT axis from the UI locale: which language the AI writes generated prose in
// (meeting reports, task titles, decisions, summaries, live notes). Kept separate from the
// UI `Locale` set on purpose — reports can be Russian while the interface stays Ukrainian,
// and adding a language here never requires a message catalog. Only ever fed into DeepSeek
// prompts as a language NAME, never used to render UI strings.

export const REPORT_LANGUAGES = ['en', 'uk', 'ru'] as const;
export type ReportLanguage = (typeof REPORT_LANGUAGES)[number];
const LANGUAGE_NAMES: Record<ReportLanguage, string> = { en: 'English', uk: 'Ukrainian', ru: 'Russian' };

/** A language code → the English name of that language, for injecting into an AI prompt. */
export function languageName(code: string): string {
  return LANGUAGE_NAMES[code as ReportLanguage] ?? 'English';
}

/** The AI-output language: WS_REPORT_LANGUAGE → WS_LANGUAGE (back-compat) → 'en'. */
export async function reportLocale(): Promise<ReportLanguage> {
  try {
    const cfg = await readConfig(['WS_REPORT_LANGUAGE', 'WS_LANGUAGE']);
    const v = (cfg.WS_REPORT_LANGUAGE || cfg.WS_LANGUAGE || '').trim();
    if ((REPORT_LANGUAGES as readonly string[]).includes(v)) return v as ReportLanguage;
  } catch {
    /* DB down → default */
  }
  return 'en';
}

/** Workspace default UI language (WS_LANGUAGE) → 'en'. */
export async function workspaceLocale(): Promise<Locale> {
  try {
    const cfg = await readConfig(['WS_LANGUAGE']);
    const ws = cfg.WS_LANGUAGE || CONFIG_DEFAULTS.WS_LANGUAGE;
    if (isLocale(ws)) return ws;
  } catch {
    /* DB down → default */
  }
  return DEFAULT_LOCALE;
}

/** A user's saved UI language (preferences.language) → workspace default → 'en'. */
export async function resolveUserLocale(userId: string): Promise<Locale> {
  try {
    const u = await prisma.user.findUnique({
      where: { id: userId },
      select: { preferences: true },
    });
    const pref = (u?.preferences as any)?.language;
    if (isLocale(pref)) return pref;
  } catch {
    /* fall through */
  }
  return workspaceLocale();
}

/** Resolve locales for many users at once (single query). Returns a map uid → locale. */
export async function resolveUserLocales(userIds: string[]): Promise<Record<string, Locale>> {
  const out: Record<string, Locale> = {};
  const wsDefault = await workspaceLocale();
  try {
    const users = await prisma.user.findMany({
      where: { id: { in: [...new Set(userIds)] } },
      select: { id: true, preferences: true },
    });
    for (const u of users) {
      const pref = (u.preferences as any)?.language;
      out[u.id] = isLocale(pref) ? pref : wsDefault;
    }
  } catch {
    /* fall through — callers default below */
  }
  for (const id of userIds) if (!out[id]) out[id] = wsDefault;
  return out;
}
