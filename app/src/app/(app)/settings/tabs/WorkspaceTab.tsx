'use client';

import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { Shield, ShieldAlert, Save, Check, Loader2, X } from 'lucide-react';
import { Select } from '@/components/ui/select';
import { TwoFactorSetupFlow } from '@/components/twofa/setup-flow';
import { Toggle, FieldWrapper } from '../components/shared';

export function WorkspaceTab() {
  const t = useTranslations();
  const [ws, setWs] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [my2fa, setMy2fa] = useState<boolean | null>(null); // current admin's 2FA status
  const [show2faSetup, setShow2faSetup] = useState(false);
  const [saveErr, setSaveErr] = useState('');
  const [authSaving, setAuthSaving] = useState(false);
  const [authMsg, setAuthMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    fetch('/api/settings/workspace')
      .then(r => r.json())
      .then(d => { if (!d.error) setWs(d); })
      .catch(() => {})
      .finally(() => setLoading(false));
    fetch('/api/settings')
      .then(r => r.json())
      .then(d => setMy2fa(!!d.twoFactorEnabled))
      .catch(() => {});
  }, []);

  const set = (k: string, v: any) => setWs((s: any) => ({ ...s, [k]: v }));

  const save = async () => {
    if (!ws) return;
    setSaving(true); setSaved(false); setSaveErr('');
    try {
      const res = await fetch('/api/settings/workspace', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ws),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok) { setSaved(true); setTimeout(() => setSaved(false), 2500); }
      else { setSaveErr(d.error || t('settings.saveFailed')); }
    } catch (e) { setSaveErr(t('settings.networkError')); }
    finally { setSaving(false); }
  };

  // Sign-in methods persist IMMEDIATELY on toggle (not via the global Save
  // button further down the page), so enabling email+password / self-registration
  // takes effect right away and can't be lost by forgetting to hit Save.
  const setAuth = async (key: string, value: any) => {
    const prev = ws;
    const next = { ...ws, [key]: value };
    if (key === 'AUTH_PASSWORD_ENABLED' && !value) next.AUTH_SELFREG = false; // self-reg needs password
    setWs(next);
    setAuthSaving(true); setAuthMsg(null);
    try {
      const res = await fetch('/api/settings/workspace', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          AUTH_GOOGLE_ENABLED: !!next.AUTH_GOOGLE_ENABLED,
          AUTH_PASSWORD_ENABLED: !!next.AUTH_PASSWORD_ENABLED,
          AUTH_SELFREG: !!next.AUTH_SELFREG,
          AUTH_SELFREG_DOMAINS: next.AUTH_SELFREG_DOMAINS || '',
        }),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok) { setAuthMsg({ ok: true, text: t('common.saved') }); setTimeout(() => setAuthMsg(null), 2000); }
      else { setWs(prev); setAuthMsg({ ok: false, text: d.error || t('settings.saveFailed') }); }
    } catch { setWs(prev); setAuthMsg({ ok: false, text: t('settings.networkError') }); }
    finally { setAuthSaving(false); }
  };

  if (loading || !ws) {
    return <div style={{ maxWidth: 1000, margin: '0 auto', padding: 40, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>{t('common.loading')}</div>;
  }

  return (
    <div style={{ maxWidth: 1000, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 18 }}>
      {/* General */}
      <div className="card" style={{ padding: '18px 22px' }}>
        <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 12 }}>{t('settings.general')}</div>
        <div className="settings-grid-2" style={{ display: 'grid', gap: 14 }}>
          <FieldWrapper label={t('settings.workspaceName')}>
            <input className="field" value={ws.WS_NAME} onChange={e => set('WS_NAME', e.target.value)} />
          </FieldWrapper>
          <FieldWrapper label={t('settings.dnsCustomDomain')}>
            <input className="field" value={ws.WS_DOMAIN} onChange={e => set('WS_DOMAIN', e.target.value)} />
          </FieldWrapper>
          <FieldWrapper label={t('settings.defaultTimezone')}>
            <Select value={ws.WS_TIMEZONE} onChange={(v) => set('WS_TIMEZONE', v)} options={[
              { value: 'Europe/Kyiv', label: 'Europe/Kyiv' },
              { value: 'Europe/Warsaw', label: 'Europe/Warsaw' },
              { value: 'America/New_York', label: 'America/New_York' },
            ]} />
          </FieldWrapper>
          <FieldWrapper label={t('settings.defaultInterfaceLanguage')}>
            <Select value={ws.WS_LANGUAGE} onChange={(v) => set('WS_LANGUAGE', v)} options={[
              { value: 'uk', label: 'Українська' },
              { value: 'en', label: 'English' },
            ]} />
          </FieldWrapper>
        </div>
      </div>

      {/* Sign-in methods */}
      <div className="card" style={{ padding: '18px 22px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
          <div style={{ fontWeight: 600, fontSize: 15 }}>{t('settings.signInMethods')}</div>
          {authSaving && <Loader2 size={14} style={{ animation: 'spin 1s linear infinite', color: 'var(--muted)' }} />}
          {authMsg?.ok && (
            <span style={{ fontSize: 12.5, display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--green)' }}>
              <Check size={13} /> {authMsg.text}
            </span>
          )}
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 14 }}>{t('settings.signInMethodsDesc')}</div>
        {authMsg && !authMsg.ok && (
          <div style={{ fontSize: 12.5, color: 'var(--red)', marginBottom: 14, lineHeight: 1.45 }}>{authMsg.text}</div>
        )}
        <Toggle label="Google SSO" value={ws.AUTH_GOOGLE_ENABLED} onChange={v => setAuth('AUTH_GOOGLE_ENABLED', v)} />
        <Toggle label={t('settings.emailPassword')} value={ws.AUTH_PASSWORD_ENABLED} onChange={v => setAuth('AUTH_PASSWORD_ENABLED', v)} />
        {ws.AUTH_PASSWORD_ENABLED && (
          <>
            <Toggle label={t('settings.allowSelfRegistration')} value={ws.AUTH_SELFREG} onChange={v => setAuth('AUTH_SELFREG', v)} />
            {ws.AUTH_SELFREG && (
              <div style={{ marginTop: 10 }}>
                <FieldWrapper label={t('settings.allowedDomains')}>
                  <input className="field" value={ws.AUTH_SELFREG_DOMAINS || ''} placeholder="company.com, team.com"
                    onChange={e => set('AUTH_SELFREG_DOMAINS', e.target.value)}
                    onBlur={e => setAuth('AUTH_SELFREG_DOMAINS', e.target.value)} />
                </FieldWrapper>
              </div>
            )}
          </>
        )}
      </div>

      {/* Meeting policies */}
      <div className="card" style={{ padding: '18px 22px' }}>
        <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>{t('settings.meetingPolicies')}</div>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 14 }}>{t('settings.meetingPoliciesDesc')}</div>
        <Toggle label={t('settings.allowGuestsByLink')} value={ws.WS_GUEST_ACCESS} onChange={v => set('WS_GUEST_ACCESS', v)} />
        <Toggle label={t('settings.aiSummaryAuto')} value={ws.WS_AI_SUMMARY} onChange={v => set('WS_AI_SUMMARY', v)} />
        <Toggle label={t('settings.liveTranscriptDefault')} value={ws.WS_LIVE_TRANSCRIPTION} onChange={v => set('WS_LIVE_TRANSCRIPTION', v)} />
        <Toggle label={t('settings.recordAllMeetings')} value={ws.WS_RECORD_ALL} onChange={v => set('WS_RECORD_ALL', v)} />
        <Toggle label={t('settings.require2faAdmins')} value={ws.WS_REQUIRE_2FA} onChange={v => set('WS_REQUIRE_2FA', v)} disabled={my2fa === false && !ws.WS_REQUIRE_2FA} />
        {my2fa === false && !ws.WS_REQUIRE_2FA && (
          <div style={{
            marginTop: 12, padding: '12px 14px', borderRadius: 10,
            background: 'color-mix(in oklab, var(--amber) 12%, transparent)',
            border: '1px solid color-mix(in oklab, var(--amber) 35%, var(--border))',
            display: 'flex', gap: 12, alignItems: 'flex-start',
          }}>
            <ShieldAlert size={18} style={{ color: 'var(--amber)', flexShrink: 0, marginTop: 1 }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 3 }}>{t('settings.setupOwn2faTitle')}</div>
              <div style={{ fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.5 }}>
                {t('settings.setupOwn2faDesc')}
              </div>
              <button className="btn btn-sm btn-primary" onClick={() => setShow2faSetup(true)} style={{ marginTop: 10 }}>
                <Shield size={13} /> {t('settings.setup2fa')}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Limits */}
      <div className="card" style={{ padding: '18px 22px' }}>
        <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>{t('settings.limits')}</div>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 14 }}>{t('settings.limitsDesc')}</div>
        <div className="settings-grid-3" style={{ display: 'grid', gap: 14 }}>
          <FieldWrapper label={t('settings.maxParticipantsPerRoom')}>
            <input className="field" type="number" value={ws.WS_MAX_PARTICIPANTS} onChange={e => set('WS_MAX_PARTICIPANTS', Number(e.target.value))} />
          </FieldWrapper>
          <FieldWrapper label={t('settings.maxDurationMin')}>
            <input className="field" type="number" value={ws.WS_MAX_DURATION_MIN} onChange={e => set('WS_MAX_DURATION_MIN', Number(e.target.value))} />
          </FieldWrapper>
          <FieldWrapper label={t('settings.retentionDays')}>
            <input className="field" type="number" value={ws.WS_RETENTION_DAYS} onChange={e => set('WS_RETENTION_DAYS', Number(e.target.value))} />
          </FieldWrapper>
        </div>
      </div>

      {/* Save */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <button className="btn btn-primary" onClick={save} disabled={saving}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {saving ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Save size={14} />} {t('common.save')}
        </button>
        {saved && (
          <span style={{ fontSize: 13, color: 'var(--green)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Check size={14} /> {t('common.saved')}
          </span>
        )}
        {saveErr && (
          <span style={{ fontSize: 13, color: 'var(--red)' }}>{saveErr}</span>
        )}
      </div>

      {show2faSetup && (
        <div
          onMouseDown={(e) => { if (e.target === e.currentTarget) setShow2faSetup(false); }}
          style={{
            position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,.55)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, backdropFilter: 'blur(2px)',
          }}
        >
          <div className="card" style={{ width: '100%', maxWidth: 420, padding: '22px 24px', position: 'relative' }}>
            <button className="btn btn-ghost btn-icon" onClick={() => setShow2faSetup(false)} style={{ position: 'absolute', top: 12, right: 12, width: 30, height: 30 }} aria-label={t('common.close')}>
              <X size={16} />
            </button>
            <TwoFactorSetupFlow onCancel={() => setShow2faSetup(false)} onDone={() => { setMy2fa(true); setShow2faSetup(false); }} />
          </div>
        </div>
      )}
    </div>
  );
}
