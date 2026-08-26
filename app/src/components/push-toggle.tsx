'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { BellRing, BellOff, Loader2 } from 'lucide-react';
import {
  getPushState,
  subscribeToPush,
  unsubscribeFromPush,
  showTestNotification,
  sendServerTest,
  type PushState,
} from '@/lib/push-client';

/**
 * Device-specific push opt-in. Unlike the email toggles (server prefs), this
 * drives the browser Notification permission + the SW push subscription, so it
 * must run client-side and reflects only THIS device.
 */
export function PushToggle() {
  const t = useTranslations();
  const [state, setState] = useState<PushState | 'loading'>('loading');
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    getPushState().then(setState);
  }, []);

  const enabled = state === 'subscribed';
  const supported = state !== 'unsupported' && state !== 'loading';
  const denied = state === 'denied';
  // `supported` is already false while loading, so !supported covers that case.
  const locked = !supported || denied || busy;

  const toggle = async () => {
    if (locked) return;
    setBusy(true);
    try {
      if (enabled) {
        await unsubscribeFromPush();
        setState('unsubscribed');
      } else {
        const r = await subscribeToPush();
        if (r.ok) {
          setState('subscribed');
          void showTestNotification();
        } else if (r.error === 'denied') {
          setState('denied');
        }
      }
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    if (testing) return;
    setTesting(true);
    setTestMsg(null);
    // Local notification (does the OS show anything at all?) + a real server
    // push (full pipeline). Same tag collapses them into one banner.
    const [local, server] = await Promise.all([showTestNotification(), sendServerTest()]);
    setTesting(false);

    if (!local.ok && local.reason === 'denied') {
      setTestMsg({ ok: false, text: t('push.testDenied') });
    } else if (server.sent === 0 && local.ok) {
      // OS accepted the local one, but the server found no live subscription.
      setTestMsg({ ok: true, text: t('push.testLocalOnly') });
    } else if (local.ok || server.sent > 0) {
      setTestMsg({ ok: true, text: t('push.testSent') });
    } else {
      setTestMsg({ ok: false, text: t('push.testFailed') });
    }
  };

  let hint = t('push.hintDefault');
  if (state === 'unsupported') hint = t('push.hintUnsupported');
  else if (denied) hint = t('push.hintDenied');
  else if (enabled) hint = t('push.hintEnabled');

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        padding: '12px 0',
        gap: 14,
        borderBottom: '1px solid var(--border)',
        opacity: state === 'loading' ? 0.6 : 1,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div
          style={{
            fontSize: 13.5,
            color: 'var(--text-2)',
            display: 'flex',
            alignItems: 'center',
            gap: 7,
            fontWeight: 500,
          }}
        >
          {enabled ? (
            <BellRing size={14} style={{ color: 'var(--accent)', flexShrink: 0 }} />
          ) : (
            <BellOff size={14} style={{ color: 'var(--muted)', flexShrink: 0 }} />
          )}
          {t('push.deviceTitle')}
        </div>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3, lineHeight: 1.45 }}>
          {hint}
        </div>
        {enabled && (
          <>
            <button
              className="btn btn-sm"
              style={{ marginTop: 9, fontSize: 12, gap: 6 }}
              onClick={() => void runTest()}
              disabled={testing}
            >
              {testing ? <Loader2 size={12} className="spin" /> : null}
              {t('push.sendTest')}
            </button>
            {testMsg && (
              <div
                style={{
                  marginTop: 8,
                  fontSize: 11.5,
                  lineHeight: 1.45,
                  color: testMsg.ok ? 'var(--muted)' : 'var(--red, var(--danger))',
                  maxWidth: 360,
                }}
              >
                {testMsg.text}
              </div>
            )}
          </>
        )}
      </div>

      <button
        type="button"
        aria-label={t('push.toggleAria')}
        disabled={locked}
        onClick={toggle}
        style={{
          width: 38,
          height: 22,
          borderRadius: 999,
          border: 'none',
          flexShrink: 0,
          marginTop: 1,
          background: enabled ? 'var(--accent)' : 'var(--surface-3)',
          position: 'relative',
          cursor: locked ? 'not-allowed' : 'pointer',
          opacity: !supported || denied ? 0.5 : 1,
          transition: 'background 0.15s',
        }}
      >
        {busy ? (
          <Loader2
            size={12}
            className="spin"
            style={{ position: 'absolute', top: 5, left: 13, color: 'var(--on-accent)' }}
          />
        ) : (
          <span
            style={{
              position: 'absolute',
              top: 3,
              left: enabled ? 19 : 3,
              width: 16,
              height: 16,
              borderRadius: '50%',
              background: '#fff',
              transition: 'left 0.15s',
              boxShadow: '0 1px 3px rgba(0,0,0,.3)',
            }}
          />
        )}
      </button>
    </div>
  );
}
