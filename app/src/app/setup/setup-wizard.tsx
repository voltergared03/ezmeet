'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useSession, signIn } from 'next-auth/react';
import { useRouter } from 'next/navigation';
import { Logo } from '@/components/ui/logo';
import { Select } from '@/components/ui/select';
import { LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE } from '@/i18n/locales';
import {
  Check, Copy, ArrowRight, ArrowLeft, Loader2, KeyRound, Building2, Globe, ShieldCheck,
} from 'lucide-react';

const TOKEN_KEY = 'eam_setup_token';

const TZ_OPTIONS = [
  'Europe/Kyiv', 'Europe/Warsaw', 'Europe/London', 'Europe/Berlin',
  'America/New_York', 'America/Los_Angeles', 'Asia/Dubai', 'UTC',
].map((v) => ({ value: v, label: v }));

const LANG_OPTIONS = [
  { value: 'en', label: 'English' },
  { value: 'uk', label: 'Українська' },
];

interface Initial {
  wsName: string;
  wsDomain: string;
  wsTimezone: string;
  wsLanguage: string;
  hasGoogleId: boolean;
}

export function SetupWizard({ initial }: { initial: Initial }) {
  const t = useTranslations();
  const router = useRouter();
  const { status } = useSession();

  const STEPS = [t('setup.stepToken'), t('setup.stepSpace'), t('setup.stepLogin'), t('setup.stepAdmin')];

  const [token, setToken] = useState('');
  const [tokenInput, setTokenInput] = useState('');
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const [wsName, setWsName] = useState(initial.wsName);
  const [wsDomain, setWsDomain] = useState(initial.wsDomain);
  const [wsTimezone, setWsTimezone] = useState(initial.wsTimezone);
  const [wsLanguage, setWsLanguage] = useState(initial.wsLanguage);
  const [googleId, setGoogleId] = useState('');
  const [googleSecret, setGoogleSecret] = useState('');
  // Auth methods (step 3)
  const [googleEnabled, setGoogleEnabled] = useState(true);
  const [passwordEnabled, setPasswordEnabled] = useState(false);
  const [selfReg, setSelfReg] = useState(false);
  const [selfRegDomains, setSelfRegDomains] = useState('');
  // First admin via password (step 4, when password method is on)
  const [adminEmail, setAdminEmail] = useState('');
  const [adminName, setAdminName] = useState('');
  const [adminPassword, setAdminPassword] = useState('');

  // Resume across refreshes / the Google OAuth round-trip.
  useEffect(() => {
    const saved = sessionStorage.getItem(TOKEN_KEY);
    if (saved) {
      setToken(saved);
      setStep((s) => (s === 1 ? 2 : s));
    }
  }, []);
  useEffect(() => {
    if (status === 'authenticated' && token) setStep(4);
  }, [status, token]);

  const cleanDomain = wsDomain.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
  const origin = cleanDomain ? `https://${cleanDomain}` : (typeof window !== 'undefined' ? window.location.origin : '');
  const redirectUri = `${origin}/api/auth/callback/google`;

  const copy = (text: string, id: string) => {
    navigator.clipboard?.writeText(text).then(() => {
      setCopied(id);
      setTimeout(() => setCopied((c) => (c === id ? null : c)), 1500);
    });
  };

  // Picking the workspace language is the first setup choice — it sets the
  // system default for everyone AND switches the wizard itself live.
  const changeWizardLanguage = (v: string) => {
    setWsLanguage(v);
    document.cookie = `${LOCALE_COOKIE}=${v}; path=/; max-age=${LOCALE_COOKIE_MAX_AGE}; samesite=lax`;
    router.refresh();
  };

  const saveConfig = useCallback(async (values: Record<string, string>) => {
    const res = await fetch('/api/setup/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, values }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error || t('setup.errSaveFailed'));
    }
  }, [token, t]);

  const verifyToken = async () => {
    setErr(null); setBusy(true);
    try {
      const res = await fetch('/api/setup/verify-token', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: tokenInput.trim() }),
      });
      const d = await res.json().catch(() => ({}));
      if (d.ok) {
        setToken(tokenInput.trim());
        sessionStorage.setItem(TOKEN_KEY, tokenInput.trim());
        setStep(2);
      } else {
        setErr(t('setup.errInvalidToken'));
      }
    } catch { setErr(t('setup.errNetwork')); }
    finally { setBusy(false); }
  };

  const saveIdentity = async () => {
    if (!wsName.trim() || !cleanDomain) { setErr(t('setup.errNameDomainRequired')); return; }
    setErr(null); setBusy(true);
    try {
      await saveConfig({
        WS_NAME: wsName.trim(),
        WS_DOMAIN: cleanDomain,
        WS_TIMEZONE: wsTimezone,
        WS_LANGUAGE: wsLanguage,
      });
      setStep(3);
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const saveAuth = async () => {
    if (!googleEnabled && !passwordEnabled) { setErr(t('setup.errPickOneMethod')); return; }
    if (googleEnabled && (!googleId.trim() || !googleSecret.trim())) { setErr(t('setup.errGoogleCredsRequired')); return; }
    setErr(null); setBusy(true);
    try {
      const values: Record<string, string> = {
        AUTH_GOOGLE_ENABLED: googleEnabled ? 'true' : 'false',
        AUTH_PASSWORD_ENABLED: passwordEnabled ? 'true' : 'false',
        AUTH_SELFREG: passwordEnabled && selfReg ? 'true' : 'false',
        AUTH_SELFREG_DOMAINS: selfRegDomains.split(',').map((s) => s.trim()).filter(Boolean).join(','),
      };
      if (googleEnabled) {
        values.GOOGLE_CLIENT_ID = googleId.trim();
        values.GOOGLE_CLIENT_SECRET = googleSecret.trim();
      }
      await saveConfig(values);
      setStep(4);
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };

  // Password-auth setup: create the admin from email+password, then auto-login.
  const createPasswordAdmin = async () => {
    if (!adminEmail.trim() || !adminPassword) { setErr(t('setup.errEmailPasswordRequired')); return; }
    if (adminPassword.length < 8) { setErr(t('setup.errPasswordTooShort')); return; }
    setErr(null); setBusy(true);
    try {
      const res = await fetch('/api/setup/admin', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, email: adminEmail.trim(), name: adminName.trim(), password: adminPassword }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok || !d.ok) { setErr(d.error || t('setup.errCreateAdminFailed')); return; }
      sessionStorage.removeItem(TOKEN_KEY);
      const r = await signIn('credentials', {
        email: adminEmail.trim().toLowerCase(), password: adminPassword, redirect: false,
      });
      if (r?.error) { router.push('/login'); return; }
      router.push('/'); router.refresh();
    } catch { setErr(t('setup.errNetwork')); }
    finally { setBusy(false); }
  };

  const finish = async () => {
    setErr(null); setBusy(true);
    try {
      const res = await fetch('/api/setup/complete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok && d.ok) {
        sessionStorage.removeItem(TOKEN_KEY);
        router.push('/');
        router.refresh();
      } else {
        setErr(d.error || t('setup.errCompleteFailed'));
      }
    } catch { setErr(t('setup.errNetwork')); }
    finally { setBusy(false); }
  };

  return (
    <div
      style={{
        position: 'fixed', inset: 0, overflowY: 'auto',
        background: 'radial-gradient(ellipse at 20% 0%, color-mix(in oklab, var(--accent) 14%, var(--bg)) 0%, var(--bg) 60%)',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-start',
        padding: '48px 20px',
      }}
    >
      <div style={{ width: '100%', maxWidth: 540 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 22 }}>
          <Logo size={26} />
        </div>

        {/* Step indicator */}
        <div style={{ display: 'flex', gap: 6, marginBottom: 20 }}>
          {STEPS.map((label, i) => {
            const n = i + 1;
            const active = n === step;
            const done = n < step;
            return (
              <div key={label} style={{ flex: 1, textAlign: 'center' }}>
                <div style={{
                  height: 4, borderRadius: 99,
                  background: done || active ? 'var(--accent)' : 'var(--border)',
                  opacity: done ? 0.6 : 1, transition: 'background .2s',
                }} />
                <div style={{ fontSize: 11, marginTop: 6, color: active ? 'var(--text)' : 'var(--muted)', fontWeight: active ? 600 : 400 }}>
                  {label}
                </div>
              </div>
            );
          })}
        </div>

        <div className="card fade-in" style={{ padding: '28px 28px 24px' }}>
          {/* STEP 1 — token */}
          {step === 1 && (
            <>
              <StepHead icon={<KeyRound size={18} />} title={t('setup.tokenTitle')} sub={t('setup.tokenSub')} />
              <FieldLabel>{t('setup.tokenLabel')}</FieldLabel>
              <input
                className="field" autoFocus value={tokenInput}
                placeholder={t('setup.tokenPlaceholder')} onChange={(e) => setTokenInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') verifyToken(); }}
              />
              <p style={{ fontSize: 12, color: 'var(--muted)', margin: '10px 0 0', lineHeight: 1.5 }}>
                {t('setup.tokenHint')}
                <code style={{ display: 'block', marginTop: 6, padding: '6px 10px', background: 'var(--surface-2)', borderRadius: 8, fontSize: 11.5 }}>
                  docker compose logs eam-meet | grep -A2 &quot;SETUP&quot;
                </code>
              </p>
              <NavRow>
                <span />
                <PrimaryBtn onClick={verifyToken} busy={busy} disabled={!tokenInput.trim()}>{t('setup.next')}</PrimaryBtn>
              </NavRow>
            </>
          )}

          {/* STEP 2 — identity */}
          {step === 2 && (
            <>
              <StepHead icon={<Building2 size={18} />} title={t('setup.identityTitle')} sub={t('setup.identitySub')} />
              <FieldLabel>{t('setup.languageLabel')}</FieldLabel>
              <Select value={wsLanguage} onChange={changeWizardLanguage} options={LANG_OPTIONS} style={{ height: 38 }} />
              <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: '6px 0 0', lineHeight: 1.55 }}>{t('setup.languageHint')}</p>
              <FieldLabel style={{ marginTop: 14 }}>{t('setup.nameLabel')}</FieldLabel>
              <input className="field" value={wsName} placeholder={t('setup.namePlaceholder')} onChange={(e) => setWsName(e.target.value)} />
              <FieldLabel style={{ marginTop: 14 }}>{t('setup.domainLabel')}</FieldLabel>
              <input className="field" value={wsDomain} placeholder={t('setup.domainPlaceholder')} onChange={(e) => setWsDomain(e.target.value)} />
              <FieldLabel style={{ marginTop: 14 }}>{t('setup.timezoneLabel')}</FieldLabel>
              <Select value={wsTimezone} onChange={setWsTimezone} options={TZ_OPTIONS} style={{ height: 38 }} />
              <NavRow>
                <span />
                <PrimaryBtn onClick={saveIdentity} busy={busy}>{t('setup.next')}</PrimaryBtn>
              </NavRow>
            </>
          )}

          {/* STEP 3 — auth methods */}
          {step === 3 && (
            <>
              <StepHead icon={<Globe size={18} />} title={t('setup.authTitle')} sub={t('setup.authSub')} />
              <WizToggle label={t('setup.googleSso')} desc={t('setup.googleSsoDesc')} value={googleEnabled} onChange={setGoogleEnabled} />
              <WizToggle label={t('setup.emailPassword')} desc={t('setup.emailPasswordDesc')} value={passwordEnabled} onChange={setPasswordEnabled} />

              {googleEnabled && (
                <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
                  <div style={{ fontSize: 12.5, color: 'var(--muted)', lineHeight: 1.6, marginBottom: 12 }}>
                    {t.rich('setup.googleSetupHint', { b: (chunks) => <b>{chunks}</b> })}
                  </div>
                  <CopyRow label={t('setup.redirectUriLabel')} value={redirectUri} copied={copied === 'r'} onCopy={() => copy(redirectUri, 'r')} />
                  <CopyRow label={t('setup.jsOriginLabel')} value={origin} copied={copied === 'o'} onCopy={() => copy(origin, 'o')} />
                  <FieldLabel style={{ marginTop: 14 }}>{t('setup.clientIdLabel')}</FieldLabel>
                  <input className="field" value={googleId} placeholder="…apps.googleusercontent.com" onChange={(e) => setGoogleId(e.target.value)} />
                  <FieldLabel style={{ marginTop: 14 }}>{t('setup.clientSecretLabel')}</FieldLabel>
                  <input className="field" type="password" value={googleSecret} placeholder="GOCSPX-…" onChange={(e) => setGoogleSecret(e.target.value)} />
                </div>
              )}

              {passwordEnabled && (
                <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
                  <WizToggle label={t('setup.selfRegLabel')} desc={t('setup.selfRegDesc')} value={selfReg} onChange={setSelfReg} />
                  {selfReg && (
                    <>
                      <FieldLabel style={{ marginTop: 12 }}>{t('setup.allowedDomainsLabel')}</FieldLabel>
                      <input className="field" value={selfRegDomains} placeholder="company.com, team.com" onChange={(e) => setSelfRegDomains(e.target.value)} />
                      <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: '6px 0 0' }}>{t('setup.allowedDomainsHint')}</p>
                    </>
                  )}
                </div>
              )}

              <NavRow>
                <GhostBtn onClick={() => { setErr(null); setStep(2); }}><ArrowLeft size={14} /> {t('common.back')}</GhostBtn>
                <PrimaryBtn onClick={saveAuth} busy={busy}>{t('setup.next')}</PrimaryBtn>
              </NavRow>
            </>
          )}

          {/* STEP 4 — claim admin */}
          {step === 4 && (
            <>
              <StepHead icon={<ShieldCheck size={18} />} title={t('setup.adminTitle')} sub={passwordEnabled ? t('setup.adminSubPassword') : t('setup.adminSubGoogle')} />
              {passwordEnabled ? (
                <>
                  <FieldLabel>{t('setup.emailLabel')}</FieldLabel>
                  <input className="field" type="email" value={adminEmail} placeholder="admin@company.com" onChange={(e) => setAdminEmail(e.target.value)} />
                  <FieldLabel style={{ marginTop: 14 }}>{t('setup.nameFieldLabel')}</FieldLabel>
                  <input className="field" value={adminName} placeholder={t('setup.adminNamePlaceholder')} onChange={(e) => setAdminName(e.target.value)} />
                  <FieldLabel style={{ marginTop: 14 }}>{t('setup.passwordLabel')}</FieldLabel>
                  <input className="field" type="password" value={adminPassword} placeholder={t('setup.passwordPlaceholder')}
                    onChange={(e) => setAdminPassword(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') createPasswordAdmin(); }} />
                  <NavRow>
                    <GhostBtn onClick={() => { setErr(null); setStep(3); }}><ArrowLeft size={14} /> {t('common.back')}</GhostBtn>
                    <PrimaryBtn onClick={createPasswordAdmin} busy={busy}>{t('setup.finish')}</PrimaryBtn>
                  </NavRow>
                </>
              ) : status === 'authenticated' ? (
                <>
                  <div style={{
                    display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px',
                    background: 'color-mix(in oklab, var(--green) 12%, transparent)',
                    border: '1px solid color-mix(in oklab, var(--green) 30%, transparent)',
                    borderRadius: 10, fontSize: 13, marginBottom: 16,
                  }}>
                    <Check size={16} style={{ color: 'var(--green)' }} /> {t('setup.signedInGoogle')}
                  </div>
                  <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 16px', lineHeight: 1.5 }}>
                    {t.rich('setup.finishHint', { code: (chunks) => <code>{chunks}</code> })}
                  </p>
                  <NavRow>
                    <GhostBtn onClick={() => { setErr(null); setStep(3); }}><ArrowLeft size={14} /> {t('common.back')}</GhostBtn>
                    <PrimaryBtn onClick={finish} busy={busy}>{t('setup.finish')}</PrimaryBtn>
                  </NavRow>
                </>
              ) : (
                <>
                  <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 16px', lineHeight: 1.5 }}>
                    {t('setup.signInGooglePrompt')}
                  </p>
                  <button className="btn btn-primary" style={{ width: '100%', justifyContent: 'center', padding: '13px 16px', fontWeight: 600 }}
                    onClick={() => { sessionStorage.setItem(TOKEN_KEY, token); signIn('google', { callbackUrl: '/setup' }); }}>
                    <Globe size={16} /> {t('setup.signInGoogle')}
                  </button>
                  <NavRow>
                    <GhostBtn onClick={() => { setErr(null); setStep(3); }}><ArrowLeft size={14} /> {t('common.back')}</GhostBtn>
                    <span />
                  </NavRow>
                </>
              )}
            </>
          )}

          {err && (
            <div style={{ marginTop: 14, fontSize: 12.5, color: 'var(--red, var(--danger))', background: 'color-mix(in oklab, var(--red, var(--danger)) 10%, transparent)', padding: '9px 12px', borderRadius: 8 }}>
              {err}
            </div>
          )}
        </div>

        <div style={{ textAlign: 'center', fontSize: 11.5, color: 'var(--muted)', marginTop: 16 }}>
          {t('setup.footer')}
        </div>
      </div>
    </div>
  );
}

/* ── small presentational helpers ───────────────────────────── */

function StepHead({ icon, title, sub }: { icon: React.ReactNode; title: string; sub: string }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 6 }}>
        <span style={{ color: 'var(--accent)' }}>{icon}</span>
        <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0, letterSpacing: '-0.01em' }}>{title}</h1>
      </div>
      <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0, lineHeight: 1.5 }}>{sub}</p>
    </div>
  );
}

function FieldLabel({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-2)', marginBottom: 6, ...style }}>{children}</div>;
}

function NavRow({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 22, gap: 12 }}>{children}</div>;
}

function PrimaryBtn({ children, onClick, busy, disabled }: { children: React.ReactNode; onClick: () => void; busy?: boolean; disabled?: boolean }) {
  return (
    <button className="btn btn-primary" style={{ padding: '10px 18px', fontWeight: 600, justifyContent: 'center' }}
      onClick={onClick} disabled={busy || disabled}>
      {busy ? <Loader2 size={15} className="spin" /> : <>{children} <ArrowRight size={15} /></>}
    </button>
  );
}

function GhostBtn({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button className="btn btn-ghost" style={{ padding: '10px 14px', fontSize: 13, color: 'var(--muted)' }} onClick={onClick}>
      {children}
    </button>
  );
}

function WizToggle({ label, desc, value, onChange }: { label: string; desc?: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 0', gap: 14 }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--text-2)' }}>{label}</div>
        {desc && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>{desc}</div>}
      </div>
      <button type="button" aria-label={label} onClick={() => onChange(!value)} style={{
        width: 38, height: 22, borderRadius: 999, border: 'none', flexShrink: 0,
        background: value ? 'var(--accent)' : 'var(--surface-3)', position: 'relative', cursor: 'pointer', transition: 'background .15s',
      }}>
        <span style={{ position: 'absolute', top: 3, left: value ? 19 : 3, width: 16, height: 16, borderRadius: '50%', background: '#fff', transition: 'left .15s', boxShadow: '0 1px 3px rgba(0,0,0,.3)' }} />
      </button>
    </div>
  );
}

function CopyRow({ label, value, copied, onCopy }: { label: string; value: string; copied: boolean; onCopy: () => void }) {
  const t = useTranslations();
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 4 }}>{label}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--surface-2)', borderRadius: 8, padding: '8px 10px' }}>
        <code style={{ flex: 1, fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</code>
        <button className="btn btn-ghost btn-icon" style={{ flexShrink: 0, height: 26, width: 26 }} title={t('setup.copy')} onClick={onCopy}>
          {copied ? <Check size={13} style={{ color: 'var(--green)' }} /> : <Copy size={13} />}
        </button>
      </div>
    </div>
  );
}
