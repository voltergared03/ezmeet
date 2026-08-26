'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Key, Loader2 } from 'lucide-react';
import { Field } from '@/components/ui/field';
import { passwordProblem, PASSWORD_MIN } from '@/lib/form-rules';

// Set or change your own login password. SSO-only accounts (no password yet)
// can set one without a current password — the authenticated session authorizes it.
export function PasswordSection({ hasPassword: initialHas }: { hasPassword: boolean }) {
  const t = useTranslations();
  const [has, setHas] = useState(initialHas);
  const [open, setOpen] = useState(false);
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // Errors are held PER FIELD. A single message under a two-field form cannot say
  // whether the current password was wrong or the new one was too short, which is the
  // one thing the user needs to know to fix it.
  const [curErr, setCurErr] = useState<string | null>(null);
  const [nextErr, setNextErr] = useState<string | null>(null);

  const submit = async () => {
    setCurErr(null); setNextErr(null);
    // Same rule the API applies, imported from the same file — see lib/form-rules.
    if (passwordProblem(next)) { setNextErr(t('settings.passwordMin8')); return; }
    setBusy(true); setMsg(null);
    try {
      const res = await fetch('/api/account/password', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(has ? { currentPassword: cur, newPassword: next } : { newPassword: next }),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok) {
        setMsg({ ok: true, text: has ? t('settings.passwordChanged') : t('settings.passwordSet') });
        setHas(true); setCur(''); setNext('');
        setTimeout(() => { setOpen(false); setMsg(null); }, 1800);
      } else {
        // A rejected CURRENT password is the common failure and it belongs on that
        // field; anything else is not field-specific and stays a form-level message.
        const text = d.error || t('settings.saveFailed');
        if (res.status === 400 && has) setCurErr(text);
        else setMsg({ ok: false, text });
      }
    } catch { setMsg({ ok: false, text: t('settings.networkError') }); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ padding: '12px 0', borderBottom: '1px solid var(--border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <div style={{ fontSize: 13.5, fontWeight: 500 }}>{t('settings.loginPassword')}</div>
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>
            {has ? t('settings.loginPasswordHasDesc') : t('settings.loginPasswordSetDesc')}
          </div>
        </div>
        {!open && (
          <button className="btn btn-sm" onClick={() => { setOpen(true); setMsg(null); }} style={{ gap: 6, flexShrink: 0 }}>
            <Key size={13} /> {has ? t('common.edit') : t('settings.setPassword')}
          </button>
        )}
      </div>
      {open && (
        <div style={{ marginTop: 12, display: 'grid', gap: 10, maxWidth: 360 }}>
          {has && (
            <Field label={t('settings.currentPassword')} error={curErr}>
              {(f) => (
                <input {...f} className="field" type="password" autoComplete="current-password"
                  value={cur} onChange={(e) => { setCur(e.target.value); setCurErr(null); }} />
              )}
            </Field>
          )}
          {/* The rule is a persistent hint, not a placeholder that vanishes the moment
              you start typing — which is exactly when you need to still see it. */}
          <Field
            label={t('settings.newPassword')}
            hint={t('settings.passwordMin8Hint', { n: PASSWORD_MIN })}
            error={nextErr}
          >
            {(f) => (
              <input {...f} className="field" type="password" autoComplete="new-password"
                value={next} onChange={(e) => { setNext(e.target.value); setNextErr(null); }} />
            )}
          </Field>
          {msg && <div style={{ fontSize: 12.5, color: msg.ok ? 'var(--success-fg)' : 'var(--danger-fg)' }}>{msg.text}</div>}
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary btn-sm" onClick={submit} disabled={busy || !next || (has && !cur)} style={{ gap: 6 }}>
              {busy ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Key size={13} />} {t('common.save')}
            </button>
            <button className="btn btn-sm" onClick={() => { setOpen(false); setCur(''); setNext(''); setMsg(null); setCurErr(null); setNextErr(null); }}>{t('common.cancel')}</button>
          </div>
        </div>
      )}
    </div>
  );
}
