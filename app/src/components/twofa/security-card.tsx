'use client';

import { useState } from 'react';
import { useSession } from 'next-auth/react';
import { useTranslations } from 'next-intl';
import { ShieldCheck, ShieldOff, Loader2, X } from 'lucide-react';
import { TwoFactorSetupFlow } from './setup-flow';

/**
 * Settings → Security row for two-factor auth. Shows current status and hosts
 * the enable wizard / disable confirmation in a lightweight modal.
 */
export function TwoFactorSecurity({ enabled: initialEnabled }: { enabled: boolean }) {
  const t = useTranslations();
  const { update } = useSession();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [mode, setMode] = useState<null | 'setup' | 'disable'>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function close() { setMode(null); setCode(''); setError(''); setBusy(false); }

  async function disable() {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const r = await fetch('/api/2fa/disable', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code.trim() }),
      });
      const d = await r.json();
      if (!r.ok) { setError(d.error || t('twofa.invalidCode')); setBusy(false); return; }
      setEnabled(false);
      // Refresh the session JWT so middleware stops requiring 2FA immediately.
      await update?.().catch(() => {});
      close();
    } catch {
      setError(t('twofa.networkError')); setBusy(false);
    }
  }

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 0', borderBottom: '1px solid var(--border)', gap: 14 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 500, display: 'flex', alignItems: 'center', gap: 8 }}>
            {t('twofa.twoFactorAuth')}
            {enabled ? (
              <span className="chip" style={{ background: 'var(--success-bg)', color: 'var(--success-fg)', borderColor: 'color-mix(in oklab, var(--green) 30%, transparent)' }}>
                <ShieldCheck size={11} /> {t('twofa.statusEnabled')}
              </span>
            ) : (
              <span className="chip" style={{ color: 'var(--muted)' }}>{t('twofa.statusDisabled')}</span>
            )}
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
            {t('twofa.securityDescription')}
          </div>
        </div>
        {enabled ? (
          <button className="btn btn-sm" onClick={() => setMode('disable')} style={{ color: 'var(--red)', borderColor: 'color-mix(in oklab, var(--red) 30%, var(--border))', flexShrink: 0 }}>
            <ShieldOff size={13} /> {t('twofa.disable')}
          </button>
        ) : (
          <button className="btn btn-sm btn-primary" onClick={() => setMode('setup')} style={{ flexShrink: 0 }}>
            <ShieldCheck size={13} /> {t('twofa.enable')}
          </button>
        )}
      </div>

      {mode && (
        <div
          onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) close(); }}
          style={{
            position: 'fixed', inset: 0, zIndex: 1000, background: 'var(--overlay)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
            backdropFilter: 'blur(2px)',
          }}
        >
          <div className="card" style={{ width: '100%', maxWidth: 420, padding: '22px 24px', position: 'relative' }}>
            <button className="btn btn-ghost btn-icon" onClick={close} style={{ position: 'absolute', top: 12, right: 12, width: 30, height: 30 }} aria-label={t('common.close')}>
              <X size={16} />
            </button>

            {mode === 'setup' ? (
              <TwoFactorSetupFlow
                onCancel={close}
                onDone={() => { setEnabled(true); close(); }}
              />
            ) : (
              <div>
                <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>{t('twofa.disableConfirmTitle')}</div>
                <p style={{ color: 'var(--text-2)', fontSize: 13, lineHeight: 1.5, margin: '0 0 14px' }}>
                  {t('twofa.disableConfirmBody')}
                </p>
                <input
                  className="field mono"
                  autoFocus
                  placeholder="000000"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\s/g, '').slice(0, 9))}
                  onKeyDown={(e) => { if (e.key === 'Enter') disable(); }}
                  style={{ fontSize: 18, letterSpacing: '0.2em', textAlign: 'center' }}
                />
                {error && <div style={{ marginTop: 10, fontSize: 12.5, color: 'var(--red)', textAlign: 'center' }}>{error}</div>}
                <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
                  <button className="btn" onClick={close} style={{ flex: 1, justifyContent: 'center' }}>{t('common.cancel')}</button>
                  <button className="btn btn-primary" onClick={disable} disabled={busy || code.length < 6} style={{ flex: 1, justifyContent: 'center', background: 'var(--red)', borderColor: 'var(--red)' }}>
                    {busy ? <Loader2 size={15} className="spin" /> : t('twofa.disable')}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
