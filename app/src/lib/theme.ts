/**
 * Theme preference — 'system' | 'light' | 'dark'.
 *
 * The value is written to `<html data-theme="…">`, and that single attribute
 * re-resolves the whole palette: every colour token in globals.css is declared as
 * `light-dark(<light>, <dark>)`, which reads the computed `color-scheme` that the
 * attribute sets. So there is no class to toggle on components and no second
 * palette to keep in sync.
 *
 * Stored per device in localStorage, not on the user record: it is a property of
 * the screen you are sitting at, not of the account. Someone on a bright monitor at
 * the office and a dark laptop at home wants different answers.
 */

export type Theme = 'system' | 'light' | 'dark';

export const THEMES: Theme[] = ['system', 'light', 'dark'];
export const THEME_KEY = 'garely-theme';

/** Default is dark, NOT system: this app shipped dark-only, and an upgrade must not
 *  silently repaint the product for everyone whose OS happens to be in light mode.
 *  Following the OS is opt-in, one click away in the switch. */
export const DEFAULT_THEME: Theme = 'dark';

export function isTheme(v: unknown): v is Theme {
  return v === 'system' || v === 'light' || v === 'dark';
}

export function readStoredTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return isTheme(v) ? v : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME; // private mode / storage blocked
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    /* preference just won't survive the reload */
  }
}

/**
 * Runs BEFORE first paint, inlined in <head>. Without it the document renders at
 * the default theme and then flips once React hydrates — a white flash on every
 * navigation for anyone who chose light, which is exactly the audience that notices.
 * Kept dependency-free and tiny because it blocks parsing.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem('${THEME_KEY}');if(t!=='light'&&t!=='dark'&&t!=='system')t='${DEFAULT_THEME}';document.documentElement.dataset.theme=t;}catch(e){document.documentElement.dataset.theme='${DEFAULT_THEME}';}})();`;
