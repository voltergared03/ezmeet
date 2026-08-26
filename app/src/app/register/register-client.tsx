'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { Logo } from '@/components/ui/logo';
import { Loader2, Check, UserPlus } from 'lucide-react';

export function RegisterClient({ wsName }: { wsName: string }) {
  const t = useTranslations();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (password.length < 8) { setErr(t('auth.errPasswordMin')); return; }
    setBusy(true);
    try {
      const res = await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), name: name.trim(), password }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { setErr(d.error || t('auth.errRegisterFailed')); setBusy(false); return; }
      setDone(true);
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

          {done ? (
            <div style={{ textAlign: 'center' }}>
              <div style={{ width: 48, height: 48, borderRadius: '50%', margin: '0 auto 16px', background: 'color-mix(in oklab, var(--green) 16%, transparent)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Check size={24} style={{ color: 'var(--green)' }} />
              </div>
              <h1 style={{ fontSize: 19, fontWeight: 700, margin: '0 0 8px' }}>{t('auth.requestSubmitted')}</h1>
              <p style={{ color: 'var(--muted)', fontSize: 13.5, margin: '0 0 20px', lineHeight: 1.5 }}>
                {t('auth.requestSubmittedHint')}
              </p>
              <Link href="/login" className="btn" style={{ width: '100%', justifyContent: 'center', padding: '12px' }}>
                {t('auth.toSignIn')}
              </Link>
            </div>
          ) : (
            <>
              <h1 style={{ fontSize: 20, fontWeight: 700, margin: '0 0 6px', textAlign: 'center' }}>
                {t('auth.registerTitle', { name: wsName })}
              </h1>
              <p style={{ color: 'var(--muted)', fontSize: 13, margin: '0 0 22px', textAlign: 'center', lineHeight: 1.5 }}>
                {t('auth.registerSubtitle')}
              </p>
              <form onSubmit={submit}>
                <input className="field" type="email" autoComplete="username" placeholder={t('auth.email')} value={email}
                  onChange={(e) => setEmail(e.target.value)} style={{ marginBottom: 10 }} />
                <input className="field" placeholder={t('auth.name')} value={name}
                  onChange={(e) => setName(e.target.value)} style={{ marginBottom: 10 }} />
                <input className="field" type="password" autoComplete="new-password" placeholder={t('auth.passwordMinPlaceholder')} value={password}
                  onChange={(e) => setPassword(e.target.value)} />
                {err && <div style={{ fontSize: 12.5, color: 'var(--red, var(--danger))', marginTop: 10 }}>{err}</div>}
                <button type="submit" className="btn btn-primary" disabled={busy || !email.trim() || !password}
                  style={{ width: '100%', justifyContent: 'center', padding: '13px 16px', fontWeight: 600, marginTop: 16, gap: 8 }}>
                  {busy ? <Loader2 size={16} className="spin" /> : <UserPlus size={15} />} {t('auth.submitRequest')}
                </button>
              </form>
              <div style={{ textAlign: 'center', marginTop: 14, fontSize: 13, color: 'var(--muted)' }}>
                {t('auth.haveAccount')}{' '}
                <Link href="/login" style={{ color: 'var(--accent)', fontWeight: 600 }}>{t('auth.signIn')}</Link>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
