'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { BellRing, X } from 'lucide-react';
import { getPushState, subscribeToPush, type PushState } from '@/lib/push-client';

const DISMISS_KEY = 'eam_push_banner_dismissed';

/**
 * Compact opt-in shown at the top of the notification dropdown when push is
 * supported but not yet enabled on this device. Dismissible (persisted). Renders
 * null in every other state so it never nags a subscribed/denied user.
 */
export function PushOptInBanner() {
  const t = useTranslations();
  const [state, setState] = useState<PushState | 'loading'>('loading');
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(DISMISS_KEY) === '1');
    } catch {
      setDismissed(false);
    }
    getPushState().then(setState);
  }, []);

  const show = !dismissed && (state === 'default' || state === 'unsubscribed');
  if (!show) return null;

  const enable = async () => {
    setBusy(true);
    const r = await subscribeToPush();
    setBusy(false);
    if (r.ok) setState('subscribed');
    else if (r.error === 'denied') setState('denied');
  };

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* ignore */
    }
    setDismissed(true);
  };

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 14px',
        borderBottom: '1px solid var(--border)',
        background: 'rgba(59,130,246,.06)',
        flexShrink: 0,
      }}
    >
      <div
        style={{
          width: 30,
          height: 30,
          borderRadius: 8,
          background: 'rgba(59,130,246,.18)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        <BellRing size={15} style={{ color: 'var(--accent-2)' }} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text)' }}>
          {t('push.bannerTitle')}
        </div>
        <div style={{ fontSize: 11, color: 'var(--muted)' }}>
          {t('push.bannerSubtitle')}
        </div>
      </div>
      <button
        className="btn btn-primary btn-sm"
        onClick={enable}
        disabled={busy}
        style={{ fontSize: 11.5, padding: '5px 10px', flexShrink: 0 }}
      >
        {busy ? '…' : t('push.bannerEnable')}
      </button>
      <button
        className="btn btn-ghost btn-icon"
        onClick={dismiss}
        aria-label={t('common.close')}
        style={{ width: 24, height: 24, flexShrink: 0 }}
      >
        <X size={12} />
      </button>
    </div>
  );
}
