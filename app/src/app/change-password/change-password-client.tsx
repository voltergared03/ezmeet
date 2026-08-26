'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Logo } from '@/components/ui/logo';
import { Lock, Loader2 } from 'lucide-react';
import { Field } from '@/components/ui/field';
import { passwordProblem, PASSWORD_MIN } from '@/lib/form-rules';

export function ChangePasswordClient({ forced }: { forced: boolean }) {
  const router = useRouter();
  const t = useTranslations();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);          // form-level only
  const [curErr, setCurErr] = useState<string | null>(null);
  const [nextErr, setNextErr] = useState<string | null>(null);
  const [confirmErr, setConfirmErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null); setCurErr(null); setNextErr(null); setConfirmErr(null);
    // Same rule the API applies — see lib/form-rules.
    if (passwordProblem(next)) { setNextErr(t('auth.errPasswordMin')); return; }
    // The mismatch belongs on CONFIRM: that is the box the user retypes to fix it.
    if (next !== confirm) { setConfirmErr(t('auth.errPasswordMismatch')); return; }
    setBusy(true);
    try {
      const res = await fetch('/api/account/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: forced ? undefined : current, newPassword: next }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || !d.ok) {
        // A rejected CURRENT password is the usual reason and belongs on that field.
        const text = d.error || t('auth.errPasswordChangeFailed');
        if (res.status === 400 && !forced) setCurErr(text); else setErr(text);
        setBusy(false); return;
      }
      router.push('/');
      router.refresh();
    } catch {
      setErr(t('auth.errNetwork'));
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed', inset: 0,
        background: 'radial-gradient(ellipse at 20% 0%, color-mix(in oklab, var(--accent) 14%, var(--bg)) 0%, var(--bg) 60%)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', overflowY: 'auto',
      }}
    >
      <div style={{ maxWidth: 400, width: '100%', padding: '24px 20px' }}>
        <div className="card fade-in" style={{ padding: '36px 32px' }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 20 }}>
            <Logo size={22} />
          </div>
          <h1 style={{ fontSize: 20, fontWeight: 700, margin: '0 0 6px', textAlign: 'center' }}>
            {forced ? t('auth.setNewPassword') : t('auth.changePassword')}
          </h1>
          <p style={{ color: 'var(--muted)', fontSize: 13, margin: '0 0 22px', textAlign: 'center', lineHeight: 1.5 }}>
            {forced
              ? t('auth.setNewPasswordHint')
              : t('auth.changePasswordHint')}
          </p>

          <form onSubmit={submit}>
            <div style={{ display: 'grid', gap: 12 }}>
              {!forced && (
                <Field label={t('auth.currentPassword')} error={curErr}>
                  {(f) => (
                    <input {...f} className="field" type="password" autoComplete="current-password"
                      value={current} onChange={(e) => { setCurrent(e.target.value); setCurErr(null); }} />
                  )}
                </Field>
              )}
              {/* The length rule stays visible as a hint. As a placeholder it vanished
                  at the first keystroke — precisely when it still needed reading. */}
              <Field
                label={t('auth.newPassword')}
                hint={t('auth.passwordMinHint', { n: PASSWORD_MIN })}
                error={nextErr}
              >
                {(f) => (
                  <input {...f} className="field" type="password" autoComplete="new-password"
                    value={next} onChange={(e) => { setNext(e.target.value); setNextErr(null); }} />
                )}
              </Field>
              <Field label={t('auth.repeatNewPassword')} error={confirmErr}>
                {(f) => (
                  <input {...f} className="field" type="password" autoComplete="new-password"
                    value={confirm} onChange={(e) => { setConfirm(e.target.value); setConfirmErr(null); }} />
                )}
              </Field>
            </div>
            {err && <div role="alert" style={{ fontSize: 12.5, color: 'var(--danger-fg)', marginTop: 10 }}>{err}</div>}
            <button
              type="submit" className="btn btn-primary" disabled={busy}
              style={{ width: '100%', justifyContent: 'center', padding: '13px 16px', fontWeight: 600, marginTop: 16, gap: 8 }}
            >
              {busy ? <Loader2 size={16} className="spin" /> : <Lock size={15} />} {t('auth.savePassword')}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
