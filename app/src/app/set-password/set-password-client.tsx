'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { signIn } from 'next-auth/react';
import { useTranslations } from 'next-intl';
import { Logo } from '@/components/ui/logo';
import { Field } from '@/components/ui/field';
import { passwordProblem, PASSWORD_MIN } from '@/lib/form-rules';
import { Lock, Loader2, AlertCircle } from 'lucide-react';

type Status = 'checking' | 'ready' | 'invalid';

export function SetPasswordClient({ token }: { token: string }) {
  const router = useRouter();
  const t = useTranslations();
  const [status, setStatus] = useState<Status>('checking');
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);          // form-level only
  const [pwErr, setPwErr] = useState<string | null>(null);
  const [confirmErr, setConfirmErr] = useState<string | null>(null);

  // Validate the token on mount.
  useEffect(() => {
    if (!token) {
      setStatus('invalid');
      return;
    }
    let cancelled = false;
    fetch(`/api/auth/set-password?token=${encodeURIComponent(token)}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d?.ok) {
          setEmail(d.email || '');
          setStatus('ready');
        } else {
          setStatus('invalid');
        }
      })
      .catch(() => {
        if (!cancelled) setStatus('invalid');
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null); setPwErr(null); setConfirmErr(null);
    // Same rule the API applies — see lib/form-rules.
    if (passwordProblem(pw)) { setPwErr(t('auth.errPasswordMin')); return; }
    // The mismatch belongs on CONFIRM: that is the box you retype to fix it.
    if (pw !== confirm) { setConfirmErr(t('auth.errPasswordMismatch')); return; }
    setBusy(true);
    try {
      const res = await fetch('/api/auth/set-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password: pw }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || !d.ok) {
        if (d?.error === 'invalid_token') {
          setStatus('invalid');
          return;
        }
        setErr(d?.error || t('auth.errPasswordChangeFailed'));
        setBusy(false);
        return;
      }
      // Sign the new user straight in with the password they just created.
      const si = await signIn('credentials', {
        email: d.email || email,
        password: pw,
        redirect: false,
      });
      if (si?.error) {
        // Fall back to the login screen if auto sign-in is blocked.
        router.push('/login');
        return;
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
        position: 'fixed',
        inset: 0,
        background:
          'radial-gradient(ellipse at 20% 0%, color-mix(in oklab, var(--accent) 14%, var(--bg)) 0%, var(--bg) 60%)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        overflowY: 'auto',
      }}
    >
      <div style={{ maxWidth: 400, width: '100%', padding: '24px 20px' }}>
        <div className="card fade-in" style={{ padding: '36px 32px' }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 20 }}>
            <Logo size={22} />
          </div>

          {status === 'checking' && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '20px 0', color: 'var(--muted)' }}>
              <Loader2 size={22} className="spin" />
              <span style={{ fontSize: 13 }}>{t('common.loading')}</span>
            </div>
          )}

          {status === 'invalid' && (
            <div style={{ textAlign: 'center' }}>
              <div
                style={{
                  width: 46,
                  height: 46,
                  borderRadius: 12,
                  margin: '0 auto 14px',
                  display: 'grid',
                  placeItems: 'center',
                  background: 'color-mix(in oklab, var(--red) 14%, transparent)',
                  color: 'var(--red)',
                }}
              >
                <AlertCircle size={22} />
              </div>
              <h1 style={{ fontSize: 19, fontWeight: 700, margin: '0 0 6px' }}>{t('auth.inviteInvalidTitle')}</h1>
              <p style={{ color: 'var(--muted)', fontSize: 13, margin: '0 0 20px', lineHeight: 1.5 }}>
                {t('auth.inviteInvalidHint')}
              </p>
              <button className="btn" style={{ width: '100%', justifyContent: 'center' }} onClick={() => router.push('/login')}>
                {t('auth.backToSignIn')}
              </button>
            </div>
          )}

          {status === 'ready' && (
            <>
              <h1 style={{ fontSize: 20, fontWeight: 700, margin: '0 0 6px', textAlign: 'center' }}>
                {t('auth.createPasswordTitle')}
              </h1>
              <p style={{ color: 'var(--muted)', fontSize: 13, margin: '0 0 22px', textAlign: 'center', lineHeight: 1.5 }}>
                {t('auth.createPasswordHint')}
              </p>

              <form onSubmit={submit}>
                {email && (
                  <input
                    className="field"
                    type="email"
                    value={email}
                    readOnly
                    autoComplete="username"
                    style={{ marginBottom: 10, opacity: 0.7 }}
                  />
                )}
                <div style={{ display: 'grid', gap: 12 }}>
                  {/* The rule stays readable as a hint; as a placeholder it disappeared at the
                      first keystroke, which is exactly when it still mattered. */}
                  <Field
                    label={t('auth.newPassword')}
                    hint={t('auth.passwordMinHint', { n: PASSWORD_MIN })}
                    error={pwErr}
                  >
                    {(f) => (
                      <input {...f} className="field" type="password" autoComplete="new-password"
                        value={pw} onChange={(e) => { setPw(e.target.value); setPwErr(null); }} autoFocus />
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
                  type="submit"
                  className="btn btn-primary"
                  disabled={busy}
                  style={{ width: '100%', justifyContent: 'center', padding: '13px 16px', fontWeight: 600, marginTop: 16, gap: 8 }}
                >
                  {busy ? <Loader2 size={16} className="spin" /> : <Lock size={15} />} {t('auth.savePassword')}
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
