'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  Home, Calendar, ListChecks, Gavel, MoreHorizontal,
  Database, Server, Archive, Settings, Plus, Video,
} from 'lucide-react';
import { useQuizPending } from '@/hooks/use-quiz-pending';

// iOS 26 Liquid Glass tab bar (Apple Music layout): a translucent floating
// capsule of four tabs + a DETACHED CIRCULAR accessory button (their search
// slot → our More/Ще). Tapping More morphs the four tabs between the primary
// set and the More set. The bar persists everywhere → bidirectional nav. It
// minimizes (labels collapse) on scroll-down and expands on scroll-up.
const PRIMARY = [
  { id: '/', key: 'home', icon: Home },
  { id: '/calendar', key: 'calendar', icon: Calendar },
  { id: '/tasks', key: 'tasks', icon: ListChecks },
  { id: '/decisions', key: 'decisions', icon: Gavel },
] as const;

const MORE = [
  { id: '/database', key: 'database', icon: Database },
  { id: '/servers', key: 'servers', icon: Server },
  { id: '/archive', key: 'archive', icon: Archive },
  { id: '/settings', key: 'settings', icon: Settings },
] as const;

const isActive = (path: string, id: string) =>
  id === '/' ? path === '/' : path === id || path.startsWith(id + '/');
const inMore = (path: string) => MORE.some((m) => isActive(path, m.id));

const fabItem: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none',
  color: 'var(--text)', background: 'var(--surface)', border: '1px solid var(--border)',
  borderRadius: 999, padding: '8px 8px 8px 16px', boxShadow: '0 8px 24px rgba(0,0,0,.35)',
  fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap',
};
const fabItemIcon = (bg: string): CSSProperties => ({
  width: 36, height: 36, borderRadius: '50%', background: bg, color: 'var(--on-accent)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
});

export function MobileNav() {
  const pathname = usePathname();
  const t = useTranslations('nav');
  const tr = useTranslations();
  const pendingQuiz = useQuizPending();
  const [compose, setCompose] = useState(false);
  const [showMore, setShowMore] = useState(() => inMore(pathname));
  const [minimized, setMinimized] = useState(false);

  useEffect(() => { setShowMore(inMore(pathname)); setCompose(false); setMinimized(false); }, [pathname]);

  // Scroll-down minimizes the bar (labels collapse), scroll-up expands it —
  // Apple's tabBarMinimizeBehavior(.onScrollDown). Capture-phase listener so it
  // sees whichever nested element actually scrolls. Skipped under Reduce Motion.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    let lastY = 0;
    let lastTarget: EventTarget | null = null;
    let ticking = false;
    const onScroll = (e: Event) => {
      const el = e.target as HTMLElement | null;
      const y = el?.scrollTop ?? 0;
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        ticking = false;
        if (el !== lastTarget) { lastTarget = el; lastY = y; return; }
        const dy = y - lastY;
        if (y < 40) setMinimized(false);
        else if (dy > 8) setMinimized(true);
        else if (dy < -8) setMinimized(false);
        lastY = y;
      });
    };
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => document.removeEventListener('scroll', onScroll, { capture: true } as EventListenerOptions);
  }, []);

  const items = showMore ? MORE : PRIMARY;
  const activeIndex = items.findIndex((it) => isActive(pathname, it.id));

  return (
    <>
      <div className={'lg-navwrap' + (minimized ? ' min' : '')}>
        {/* Main translucent capsule — the four current tabs */}
        <nav className="lg-tabbar" aria-label="Primary">
          <span
            className="lg-tab-pill"
            aria-hidden
            style={{ transform: `translateX(calc(${Math.max(0, activeIndex)} * 100%))`, opacity: activeIndex < 0 ? 0 : 1 }}
          />
          <div className="lg-tabs" key={showMore ? 'more' : 'primary'}>
            {items.map((it) => {
              const Icon = it.icon;
              const act = isActive(pathname, it.id);
              return (
                <Link
                  key={it.id}
                  href={it.id}
                  className={'lg-tab' + (act ? ' active' : '')}
                  aria-label={t(it.key)}
                  aria-current={act ? 'page' : undefined}
                >
                  <span style={{ position: 'relative', display: 'inline-flex' }}>
                    <Icon size={18} strokeWidth={act ? 2.4 : 1.9} />
                    {it.id === '/tasks' && pendingQuiz > 0 && (
                      <span className="lg-tab-badge">{pendingQuiz}</span>
                    )}
                  </span>
                  <span>{t(it.key)}</span>
                </Link>
              );
            })}
          </div>
        </nav>

        {/* Detached CIRCULAR accessory — toggles which set the capsule shows */}
        <button
          type="button"
          className={'lg-morebtn' + (showMore ? ' active' : '')}
          aria-label={t('more')}
          aria-pressed={showMore}
          onClick={() => setShowMore((s) => !s)}
        >
          <MoreHorizontal size={20} strokeWidth={showMore ? 2.4 : 1.9} />
        </button>
      </div>

      {/* ── Compose speed-dial: quick meeting / schedule ── */}
      {compose && (
        <div
          onClick={() => setCompose(false)}
          aria-hidden
          style={{ position: 'fixed', inset: 0, zIndex: 54, background: 'rgba(0,0,0,0.4)', backdropFilter: 'blur(2px)' }}
        />
      )}
      {compose && (
        <div style={{
          position: 'fixed', right: 16, zIndex: 56,
          bottom: 'calc(env(safe-area-inset-bottom, 0px) + 94px + 52px + 12px)',
          display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 12,
        }}>
          <Link href="/lobby/quick" onClick={() => setCompose(false)} style={fabItem}>
            <span>{tr('sidebar.quickMeeting')}</span>
            <span style={fabItemIcon('var(--accent)')}><Video size={18} /></span>
          </Link>
          <Link href="/schedule" onClick={() => setCompose(false)} style={fabItem}>
            <span>{tr('dashboard.scheduleMeeting')}</span>
            <span style={fabItemIcon('var(--green, var(--success))')}><Plus size={18} /></span>
          </Link>
        </div>
      )}
      <button
        onClick={() => setCompose((o) => !o)}
        className="mobile-nav-fab"
        aria-label={t('newMeeting')}
        aria-expanded={compose}
        style={{ border: 'none', cursor: 'pointer', padding: 0, zIndex: compose ? 56 : undefined }}
      >
        <Plus size={24} strokeWidth={2.5} style={{ transition: 'transform .18s', transform: compose ? 'rotate(45deg)' : 'none' }} />
      </button>
    </>
  );
}
