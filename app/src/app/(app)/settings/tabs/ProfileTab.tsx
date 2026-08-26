'use client';

import { useState, useEffect, useCallback } from 'react';
import { ThemeToggle } from '@/components/theme-toggle';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Globe, LogOut, Save, Check, Calendar as CalendarIcon, Link2, Unlink, AlertCircle } from 'lucide-react';
import { Avatar } from '@/components/ui/avatar';
import { Select } from '@/components/ui/select';
import { TwoFactorSecurity } from '@/components/twofa/security-card';
import { PushToggle } from '@/components/push-toggle';
import { signOut } from 'next-auth/react';
import { LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE } from '@/i18n/locales';
import { Toggle, FieldWrapper } from '../components/shared';
import { PasswordSection } from './PasswordSection';

// Two-way Google Calendar sync — per-user OAuth into a dedicated "Garely"
// calendar: events created/edited/deleted there become Garely meetings and
// vice versa. Separate from the read-only ICS feed above.
function GoogleCalendarCard() {
  const t = useTranslations();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [conn, setConn] = useState<{
    googleEmail?: string | null; status?: string; lastError?: string | null; lastSyncedAt?: string | null;
  } | null>(null);
  const [flash, setFlash] = useState(''); // result of the ?gcal= redirect

  const load = useCallback(() => {
    fetch('/api/integrations/google')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setConn(d?.connected ? d.connection : null))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    // Surface the OAuth round-trip result once, then clean the URL.
    const sp = new URLSearchParams(window.location.search);
    const res = sp.get('gcal');
    if (res) {
      setFlash(res);
      sp.delete('gcal');
      const qs = sp.toString();
      window.history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : ''));
    }
  }, [load]);

  const disconnect = async () => {
    if (!confirm(t('settings.gcalDisconnectConfirm'))) return;
    setBusy(true);
    try {
      const r = await fetch('/api/integrations/google', { method: 'DELETE' });
      if (r.ok) setConn(null);
    } finally { setBusy(false); }
  };

  const broken = conn && conn.status !== 'active';

  return (
    <div className="card" style={{ padding: '18px 22px', marginBottom: 18 }}>
      <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
        <CalendarIcon size={15} style={{ color: 'var(--accent)' }} /> {t('settings.gcalTitle')}
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 12, lineHeight: 1.5 }}>{t('settings.gcalDesc')}</div>

      {flash === 'connected' && (
        <div style={{ fontSize: 12.5, color: 'var(--green)', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
          <Check size={13} /> {t('settings.gcalConnected')}
        </div>
      )}
      {(flash === 'denied' || flash === 'error' || flash === 'invalid' || flash === 'noscope') && (
        <div style={{ fontSize: 12.5, color: 'var(--red)', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
          <AlertCircle size={13} /> {t('settings.gcalConnectFailed')}
        </div>
      )}

      {loading ? (
        <div style={{ fontSize: 13, color: 'var(--muted)' }}>{t('common.loading')}</div>
      ) : conn ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span className="chip" style={broken ? {
              background: 'color-mix(in oklab, var(--red) 14%, transparent)', color: 'var(--danger-fg)',
              borderColor: 'color-mix(in oklab, var(--red) 30%, transparent)',
            } : {
              background: 'var(--success-bg)', color: 'var(--success-fg)',
              borderColor: 'color-mix(in oklab, var(--green) 30%, transparent)',
            }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: broken ? 'var(--red)' : 'var(--green)' }} />
              {broken ? t('settings.gcalStatusBroken') : t('settings.gcalStatusActive')}
            </span>
            {conn.googleEmail && <span className="mono" style={{ fontSize: 12, color: 'var(--text-2)' }}>{conn.googleEmail}</span>}
          </div>
          {conn.lastSyncedAt && (
            <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>
              {t('settings.gcalLastSync')} {new Date(conn.lastSyncedAt).toLocaleString()}
            </div>
          )}
          {broken && (
            <div style={{ fontSize: 12, color: 'var(--red)', lineHeight: 1.5 }}>{t('settings.gcalReconnectHint')}</div>
          )}
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {broken && (
              <a className="btn btn-primary btn-sm" href="/api/integrations/google/connect" style={{ textDecoration: 'none' }}>
                <Link2 size={13} /> {t('settings.gcalReconnect')}
              </a>
            )}
            <button className="btn btn-sm" onClick={disconnect} disabled={busy}>
              <Unlink size={13} /> {t('settings.gcalDisconnect')}
            </button>
          </div>
        </div>
      ) : (
        <a className="btn btn-primary btn-sm" href="/api/integrations/google/connect"
          style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Link2 size={13} /> {t('settings.gcalConnect')}
        </a>
      )}
    </div>
  );
}

export function ProfileTab({ session: sess, updateSession }: { session: any; updateSession: any }) {
  const t = useTranslations();
  const user = sess?.user;
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);

  const [name, setName] = useState('');
  const [displayRole, setDisplayRole] = useState('');
  const [timezone, setTimezone] = useState('Europe/Kyiv');
  const [language, setLanguage] = useState('uk');
  const [spokenLang, setSpokenLang] = useState(''); // '' = auto-detect
  const [micOnJoin, setMicOnJoin] = useState(false);
  const [camOnJoin, setCamOnJoin] = useState(false);
  const [liveTranscript, setLiveTranscript] = useState(true);
  const [emailReminder, setEmailReminder] = useState(true);
  const [emailReport, setEmailReport] = useState(true);
  const [actionItemNotif, setActionItemNotif] = useState(true);
  const [weeklyDigest, setWeeklyDigest] = useState(false);
  const [twoFactorEnabled, setTwoFactorEnabled] = useState(false);
  const [hasPassword, setHasPassword] = useState(false);

  useEffect(() => {
    fetch('/api/settings')
      .then((r) => r.json())
      .then((data) => {
        setName(data.name || '');
        setTimezone(data.timezone || 'Europe/Kyiv');
        const p = data.preferences || {};
        setDisplayRole(p.displayRole || '');
        setLanguage(p.language || 'uk');
        setSpokenLang(p.spokenLanguageLocked ? (p.spokenLanguage || '') : '');
        setMicOnJoin(p.micOnJoin ?? false);
        setCamOnJoin(p.camOnJoin ?? false);
        setLiveTranscript(p.liveTranscript ?? true);
        setEmailReminder(p.emailReminder ?? true);
        setEmailReport(p.emailReport ?? true);
        setActionItemNotif(p.actionItemNotif ?? true);
        setWeeklyDigest(p.weeklyDigest ?? false);
        setTwoFactorEnabled(data.twoFactorEnabled ?? false);
        setHasPassword(data.hasPassword ?? false);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const saveSettings = useCallback(async () => {
    setSaving(true);
    setSaved(false);
    try {
      // spokenLanguageLocked=true forces this language (auto-detect won't override).
      const prefs: any = { displayRole, language, micOnJoin, camOnJoin, liveTranscript, emailReminder, emailReport, actionItemNotif, weeklyDigest, spokenLanguageLocked: !!spokenLang };
      if (spokenLang) prefs.spokenLanguage = spokenLang;
      await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, timezone, preferences: prefs }),
      });
      setSaved(true);
      if (name !== user?.name) await updateSession({ name });
      setTimeout(() => setSaved(false), 2500);
    } catch (e) { console.error(e); }
    finally { setSaving(false); }
  }, [name, timezone, displayRole, language, spokenLang, micOnJoin, camOnJoin, liveTranscript, emailReminder, emailReport, actionItemNotif, weeklyDigest, user?.name, updateSession]);

  // Interface language switches instantly: persist the preference, drop the
  // `locale` cookie that drives server rendering, refresh the session token,
  // then re-render the whole app in the chosen language.
  const changeLanguage = useCallback(async (v: string) => {
    setLanguage(v);
    document.cookie = `${LOCALE_COOKIE}=${v}; path=/; max-age=${LOCALE_COOKIE_MAX_AGE}; samesite=lax`;
    try {
      await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferences: { language: v } }),
      });
      await updateSession();
    } catch (e) { console.error(e); }
    router.refresh();
  }, [updateSession, router]);

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>{t('common.loading')}</div>;

  return (
    <div style={{ maxWidth: 760, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', marginBottom: 18 }}>
        <button className={saved ? 'btn' : 'btn btn-primary'} onClick={saveSettings} disabled={saving} style={{ fontWeight: 600 }}>
          {saved ? <><Check size={15} /> {t('common.saved')}</> : saving ? t('common.saving') : <><Save size={15} /> {t('common.save')}</>}
        </button>
      </div>

      <div className="card" style={{ padding: '18px 22px', marginBottom: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 18, marginBottom: 18 }}>
          <Avatar name={user?.name ?? 'User'} image={user?.image} size="lg" />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: 16 }}>{user?.name ?? 'User'}</div>
            <div className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>{user?.email}</div>
            <div style={{ marginTop: 6, display: 'flex', gap: 8 }}>
              <span className="chip" style={{ background: 'var(--success-bg)', color: 'var(--success-fg)', borderColor: 'color-mix(in oklab, var(--green) 30%, transparent)' }}>
                <Globe size={11} /> Google SSO
              </span>
            </div>
          </div>
        </div>
        <div className="settings-grid-2" style={{ display: 'grid', gap: 14 }}>
          <FieldWrapper label={t('settings.name')}><input className="field" value={name} onChange={(e) => setName(e.target.value)} /></FieldWrapper>
          <FieldWrapper label={t('settings.role')}><input className="field" value={displayRole} onChange={(e) => setDisplayRole(e.target.value)} placeholder="Product Manager" /></FieldWrapper>
          <FieldWrapper label={t('settings.timezone')}>
            <Select value={timezone} onChange={setTimezone} options={[
              { value: 'Europe/Kyiv', label: 'Europe/Kyiv (UTC+3)' },
              { value: 'Europe/Warsaw', label: 'Europe/Warsaw (UTC+2)' },
              { value: 'America/New_York', label: 'America/New_York (UTC-4)' },
            ]} />
          </FieldWrapper>
          <FieldWrapper label={t('settings.interfaceLanguage')}>
            <Select value={language} onChange={changeLanguage} options={[
              { value: 'uk', label: 'Українська' },
              { value: 'en', label: 'English' },
            ]} />
          </FieldWrapper>
          <FieldWrapper label={t('settings.spokenLanguage')}>
            <Select value={spokenLang} onChange={setSpokenLang} options={[
              { value: '', label: t('settings.spokenLanguageAuto') },
              { value: 'uk', label: 'Українська' },
              { value: 'en', label: 'English' },
              { value: 'ru', label: 'Русский' },
            ]} />
          </FieldWrapper>
        </div>
        {/* Outside the grid: the switch is its own control, not a labelled field, and
            it saves on click rather than waiting for the form's Save — theme is a
            preview-as-you-pick setting, so making it wait would be the wrong model. */}
        <div style={{ marginTop: 14 }}>
          <ThemeToggle />
        </div>
      </div>

      <div className="card" style={{ padding: '18px 22px', marginBottom: 18 }}>
        <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 8 }}>{t('settings.audioVideo')}</div>
        <Toggle label={t('settings.micOnJoin')} value={micOnJoin} onChange={setMicOnJoin} />
        <Toggle label={t('settings.camOnJoin')} value={camOnJoin} onChange={setCamOnJoin} />
        <Toggle label={t('settings.liveTranscriptDefault')} value={liveTranscript} onChange={setLiveTranscript} />

      </div>

      <div className="card" style={{ padding: '18px 22px', marginBottom: 18 }}>
        <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 8 }}>{t('settings.notifications')}</div>
        <PushToggle />
        <Toggle label={t('settings.emailReminder')} value={emailReminder} onChange={setEmailReminder} />
        <Toggle label={t('settings.emailReport')} value={emailReport} onChange={setEmailReport} />
        <Toggle label={t('settings.actionItemNotif')} value={actionItemNotif} onChange={setActionItemNotif} />
        <Toggle label={t('settings.weeklyDigest')} value={weeklyDigest} onChange={setWeeklyDigest} />
      </div>

      <GoogleCalendarCard />

      <div className="card" style={{ padding: '18px 22px' }}>
        <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 8 }}>{t('settings.security')}</div>
        <TwoFactorSecurity enabled={twoFactorEnabled} />
        <PasswordSection hasPassword={hasPassword} />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 0' }}>
          <div>
            <div style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--red)' }}>{t('settings.signOutTitle')}</div>
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>{t('settings.signOutDesc')}</div>
          </div>
          <button className="btn btn-sm" onClick={() => signOut()} style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--red)', borderColor: 'color-mix(in oklab, var(--red) 30%, var(--border))' }}>
            <LogOut size={13} /> {t('sidebar.signOut')}
          </button>
        </div>
      </div>
    </div>
  );
}
