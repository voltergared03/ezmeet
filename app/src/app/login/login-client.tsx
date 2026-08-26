'use client';

import { useState } from 'react';
import { signIn } from 'next-auth/react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { Logo } from '@/components/ui/logo';
import { Globe, Lock, Loader2 } from 'lucide-react';
import { BackgroundPaths } from './background-paths';

export function LoginClient({
  wsName,
  googleEnabled,
  passwordEnabled,
  selfReg,
}: {
  wsName: string;
  googleEnabled: boolean;
  passwordEnabled: boolean;
  selfReg: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const t = useTranslations();
  // Post-login destination. Only same-origin relative paths are honoured (a
  // single leading slash, not "//host") so the param can't become an open
  // redirect. Lets a /join link send a signed-in colleague back to the lobby.
  const raw = searchParams.get('callbackUrl') || '/';
  const callbackUrl = raw.startsWith('/') && !raw.startsWith('//') ? raw : '/';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) return;
    setErr(null);
    setBusy(true);
    try {
      const r = await signIn('credentials', {
        email: email.trim().toLowerCase(),
        password,
        redirect: false,
      });
      if (r?.error) {
        // A pending/expired/denied self-registration has no account yet, so the
        // sign-in fails generically — check for it and show a clearer message.
        let msg = t('auth.errInvalidCredentials');
        try {
          const sr = await fetch('/api/register/status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: email.trim().toLowerCase(), password }),
          });
          const sd = await sr.json().catch(() => ({}));
          if (sd.status === 'pending') msg = t('auth.errRegPending');
          else if (sd.status === 'expired') msg = t('auth.errRegExpired');
          else if (sd.status === 'denied') msg = t('auth.errRegDenied');
        } catch {
          /* keep the generic message */
        }
        setErr(msg);
        setBusy(false);
        return;
      }
      router.push(callbackUrl);
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
        background: 'radial-gradient(ellipse at 20% 0%, color-mix(in oklab, var(--accent) 14%, var(--bg)) 0%, var(--bg) 60%)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        overflowY: 'auto',
      }}
    >
      <BackgroundPaths />
      <div style={{ position: 'relative', zIndex: 1, maxWidth: 420, width: '100%', padding: '24px 20px' }}>
        <div className="card fade-in" style={{ padding: '40px 36px', textAlign: 'center' }}>
          <div style={{ marginBottom: 24 }}>
            <Logo size={24} />
          </div>

          <h1 style={{ fontSize: 24, fontWeight: 700, margin: '0 0 28px', letterSpacing: '-0.02em' }}>
            {t('auth.welcome', { name: wsName })}
          </h1>

          {passwordEnabled && (
            <form onSubmit={submit} style={{ textAlign: 'left', marginBottom: googleEnabled ? 18 : 4 }}>
              <input
                className="field"
                type="email"
                autoComplete="username"
                placeholder={t('auth.email')}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                style={{ marginBottom: 10 }}
              />
              <input
                className="field"
                type="password"
                autoComplete="current-password"
                placeholder={t('auth.password')}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              {err && (
                <div style={{ fontSize: 12.5, color: 'var(--red, var(--danger))', marginTop: 10 }}>{err}</div>
              )}
              <button
                type="submit"
                className="btn btn-primary"
                disabled={busy || !email.trim() || !password}
                style={{ width: '100%', justifyContent: 'center', padding: '13px 16px', fontWeight: 600, marginTop: 14, gap: 8 }}
              >
                {busy ? <Loader2 size={16} className="spin" /> : <Lock size={15} />} {t('auth.signIn')}
              </button>
              {selfReg && (
                <div style={{ textAlign: 'center', marginTop: 14, fontSize: 13, color: 'var(--muted)' }}>
                  {t('auth.noAccount')}{' '}
                  <Link href="/register" style={{ color: 'var(--accent)', fontWeight: 600 }}>
                    {t('auth.register')}
                  </Link>
                </div>
              )}
            </form>
          )}

          {googleEnabled && passwordEnabled && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '4px 0 18px', color: 'var(--muted-2)', fontSize: 11.5 }}>
              <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
              {t('auth.or')}
              <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
            </div>
          )}

          {googleEnabled && (
            <button
              onClick={() => signIn('google', { callbackUrl })}
              className="btn"
              style={{ width: '100%', padding: '14px 16px', justifyContent: 'center', fontSize: 14, fontWeight: 600 }}
            >
              <Globe size={16} /> {t('auth.signInWithGoogle')}
            </button>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--muted)', fontSize: 12, justifyContent: 'center', marginTop: 18 }}>
            <Lock size={12} /> {t('auth.selfHosted')}
          </div>
        </div>
      </div>
    </div>
  );
}
