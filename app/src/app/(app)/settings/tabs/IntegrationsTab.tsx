'use client';

import { useState, useEffect } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import {
  Globe, Mic, Sparkles, Video, Mail, Archive, Download,
  Key, Eye, EyeOff, Loader2, Save, Check, ListChecks, X, Settings2, Plug,
} from 'lucide-react';
import { Toggle, FieldWrapper } from '../components/shared';

// Which connectors open a config modal (the rest are read-only status cards).
const MANAGEABLE = new Set(['Deepgram', 'DeepSeek', 'SMTP Email', 'S3 Storage', 'ClickUp', 'Google OAuth']);

export function IntegrationsTab() {
  const t = useTranslations();
  const locale = useLocale();
  const INTEGRATION_ICONS: Record<string, React.ReactNode> = {
    LiveKit: <Video size={20} />,
    Deepgram: <Mic size={20} />,
    DeepSeek: <Sparkles size={20} />,
    'SMTP Email': <Mail size={20} />,
    'Google OAuth': <Globe size={20} />,
    PostgreSQL: <Archive size={20} />,
    'S3 Storage': <Download size={20} />,
    ClickUp: <ListChecks size={20} />,
  };
  const [integrations, setIntegrations] = useState<{ name: string; desc: string; status: string; metric?: string }[]>([]);
  // The connector whose config modal is open (by name), or null.
  const [manage, setManage] = useState<string | null>(null);

  // API Keys management
  const [keys, setKeys] = useState<Record<string, { value: string; masked: string; updatedAt: string }>>({});
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const [showKey, setShowKey] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [keysLoading, setKeysLoading] = useState(true);

  // SMTP / email config
  const [smtp, setSmtp] = useState({ host: '', port: '587', secure: false, user: '', from: '', fromName: '', passSet: false });
  const [smtpPass, setSmtpPass] = useState('');
  const [smtpSaving, setSmtpSaving] = useState(false);
  const [smtpSaved, setSmtpSaved] = useState(false);
  const [smtpLoading, setSmtpLoading] = useState(true);
  const [testEmail, setTestEmail] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; msg: string } | null>(null);

  // S3 / object storage config
  const [s3, setS3] = useState({ endpoint: '', region: '', bucket: '', accessKeyId: '', forcePathStyle: false, secretSet: false });
  const [s3Secret, setS3Secret] = useState('');
  const [s3Saving, setS3Saving] = useState(false);
  const [s3Saved, setS3Saved] = useState(false);
  const [s3Testing, setS3Testing] = useState(false);
  const [s3Test, setS3Test] = useState<{ ok: boolean; msg: string } | null>(null);

  // ClickUp integration config (paste token → it works)
  const [clickup, setClickup] = useState<{ enabled: boolean; tokenSet: boolean; routingMode: 'department' | 'inbox'; teamId: string; migration?: { state?: string; total?: number; migrated?: number } | null }>({ enabled: false, tokenSet: false, routingMode: 'department', teamId: '' });
  const [clickupToken, setClickupToken] = useState('');
  const [clickupSaving, setClickupSaving] = useState(false);
  const [clickupSaved, setClickupSaved] = useState(false);
  const [clickupTesting, setClickupTesting] = useState(false);
  const [clickupTest, setClickupTest] = useState<{ ok: boolean; msg: string } | null>(null);

  useEffect(() => {
    fetch('/api/settings/keys')
      .then(r => r.json())
      .then(data => { if (!data.error) setKeys(data); })
      .catch(console.error)
      .finally(() => setKeysLoading(false));
  }, []);

  useEffect(() => {
    fetch('/api/settings/email')
      .then(r => r.json())
      .then(d => {
        if (!d.error) setSmtp({
          host: d.host || '', port: String(d.port || '587'), secure: !!d.secure,
          user: d.user || '', from: d.from || '', fromName: d.fromName || '', passSet: !!d.passSet,
        });
      })
      .catch(() => {})
      .finally(() => setSmtpLoading(false));
  }, []);

  useEffect(() => {
    fetch('/api/settings/integrations')
      .then(r => r.json())
      .then(d => { if (Array.isArray(d.integrations)) setIntegrations(d.integrations); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch('/api/settings/s3')
      .then(r => r.json())
      .then(d => {
        if (!d.error) setS3({
          endpoint: d.endpoint || '', region: d.region || '', bucket: d.bucket || '',
          accessKeyId: d.accessKeyId || '', forcePathStyle: !!d.forcePathStyle, secretSet: !!d.secretSet,
        });
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch('/api/settings/clickup')
      .then(r => r.json())
      .then(d => {
        if (!d.error) setClickup({
          enabled: !!d.enabled, tokenSet: !!d.tokenSet,
          routingMode: d.routingMode === 'inbox' ? 'inbox' : 'department', teamId: d.teamId || '',
          migration: d.migration ?? null,
        });
      })
      .catch(() => {});
  }, []);

  // Close the modal on Escape.
  useEffect(() => {
    if (!manage) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setManage(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [manage]);

  const refreshIntegrations = () => {
    fetch('/api/settings/integrations')
      .then(r => r.json())
      .then(d => { if (Array.isArray(d.integrations)) setIntegrations(d.integrations); })
      .catch(() => {});
  };

  const saveClickup = async () => {
    setClickupSaving(true); setClickupSaved(false);
    try {
      const payload: any = { enabled: clickup.enabled, routingMode: clickup.routingMode };
      if (clickupToken.trim()) payload.token = clickupToken.trim();
      const res = await fetch('/api/settings/clickup', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (res.ok) {
        setClickupSaved(true);
        if (clickupToken.trim()) { setClickup(c => ({ ...c, tokenSet: true })); setClickupToken(''); }
        setTimeout(() => setClickupSaved(false), 2500);
        refreshIntegrations();
      }
    } catch (e) { console.error(e); }
    finally { setClickupSaving(false); }
  };

  const testClickup = async () => {
    setClickupTesting(true); setClickupTest(null);
    try {
      // If a fresh token was typed, persist it first so the test hits the new one.
      if (clickupToken.trim()) {
        const saveRes = await fetch('/api/settings/clickup', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: clickupToken.trim() }) });
        if (!saveRes.ok) { setClickupTest({ ok: false, msg: t('settings.networkError') }); return; }
        setClickup(c => ({ ...c, tokenSet: true })); setClickupToken('');
      }
      const res = await fetch('/api/settings/clickup/test', { method: 'POST' });
      const d = await res.json().catch(() => ({}));
      setClickupTest(res.ok
        ? { ok: true, msg: d.team ? `${t('settings.connectionSuccess')} · ${d.team}` : t('settings.connectionSuccess') }
        : { ok: false, msg: d.error || t('settings.networkError') });
    } catch { setClickupTest({ ok: false, msg: t('settings.networkError') }); }
    finally { setClickupTesting(false); }
  };

  const saveS3 = async () => {
    setS3Saving(true); setS3Saved(false);
    try {
      const payload: any = { endpoint: s3.endpoint, region: s3.region, bucket: s3.bucket, accessKeyId: s3.accessKeyId, forcePathStyle: s3.forcePathStyle };
      if (s3Secret) payload.secretAccessKey = s3Secret;
      const res = await fetch('/api/settings/s3', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (res.ok) {
        setS3Saved(true);
        if (s3Secret) { setS3((s) => ({ ...s, secretSet: true })); setS3Secret(''); }
        setTimeout(() => setS3Saved(false), 2500);
        refreshIntegrations();
      }
    } catch (e) { console.error(e); }
    finally { setS3Saving(false); }
  };

  const testS3Conn = async () => {
    setS3Testing(true); setS3Test(null);
    try {
      const res = await fetch('/api/settings/s3/test', { method: 'POST' });
      const d = await res.json().catch(() => ({}));
      setS3Test(res.ok ? { ok: true, msg: t('settings.connectionSuccess') } : { ok: false, msg: d.error || t('settings.networkError') });
    } catch { setS3Test({ ok: false, msg: t('settings.networkError') }); }
    finally { setS3Testing(false); }
  };

  const saveKey = async (keyName: string) => {
    if (!editValue.trim()) return;
    setSaving(true);
    try {
      const res = await fetch('/api/settings/keys', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [keyName]: editValue.trim() }),
      });
      if (res.ok) {
        const data = await fetch('/api/settings/keys').then(r => r.json());
        if (!data.error) setKeys(data);
        setEditingKey(null);
        setEditValue('');
        refreshIntegrations();
      }
    } catch (e) { console.error(e); }
    finally { setSaving(false); }
  };

  const saveSmtp = async () => {
    setSmtpSaving(true); setSmtpSaved(false);
    try {
      const payload: any = { host: smtp.host, port: smtp.port, secure: smtp.secure, user: smtp.user, from: smtp.from, fromName: smtp.fromName };
      if (smtpPass) payload.pass = smtpPass;
      const res = await fetch('/api/settings/email', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      if (res.ok) {
        setSmtpSaved(true);
        if (smtpPass) { setSmtp(s => ({ ...s, passSet: true })); setSmtpPass(''); }
        setTimeout(() => setSmtpSaved(false), 2500);
        refreshIntegrations();
      }
    } catch (e) { console.error(e); }
    finally { setSmtpSaving(false); }
  };

  const sendTest = async () => {
    setTesting(true); setTestResult(null);
    try {
      const res = await fetch('/api/settings/email/test', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: testEmail.trim() }),
      });
      const d = await res.json().catch(() => ({}));
      setTestResult(res.ok ? { ok: true, msg: t('settings.testEmailSent') } : { ok: false, msg: d.error || t('settings.sendFailed') });
    } catch { setTestResult({ ok: false, msg: t('settings.networkError') }); }
    finally { setTesting(false); }
  };

  const API_KEYS_CONFIG = [
    { key: 'DEEPGRAM_API_KEY', label: 'Deepgram API Key', service: 'Deepgram' },
    { key: 'DEEPGRAM_MODEL', label: 'Deepgram Model', service: 'Deepgram' },
    { key: 'DEEPGRAM_LANGUAGE', label: 'Deepgram Language', service: 'Deepgram' },
    { key: 'DEEPSEEK_API_KEY', label: 'DeepSeek API Key', service: 'DeepSeek' },
    { key: 'DEEPSEEK_BASE_URL', label: 'DeepSeek Base URL', service: 'DeepSeek' },
    { key: 'DEEPSEEK_MODEL', label: 'DeepSeek Model', service: 'DeepSeek' },
    { key: 'GOOGLE_CLIENT_ID', label: 'Client ID', service: 'Google OAuth' },
    { key: 'GOOGLE_CLIENT_SECRET', label: 'Client secret', service: 'Google OAuth' },
  ];

  // ─────────────────────────── status pill ───────────────────────────
  const statusPill = (status: string) => {
    if (status === 'connected') return (
      <span className="chip" style={{ background: 'color-mix(in oklab, var(--green) 14%, transparent)', color: '#a7f3d0', borderColor: 'color-mix(in oklab, var(--green) 30%, transparent)' }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--green)' }} /> {t('settings.statusConnected')}
      </span>
    );
    if (status === 'error') return (
      <span className="chip" style={{ background: 'color-mix(in oklab, var(--red) 14%, transparent)', color: '#fca5a5', borderColor: 'color-mix(in oklab, var(--red) 30%, transparent)' }}>
        <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--red)' }} /> {t('settings.statusError')}
      </span>
    );
    return <span className="chip" style={{ color: 'var(--muted)' }}><span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--border-2)' }} /> {t('settings.notConfigured')}</span>;
  };

  // ─────────────────────────── per-key editor row (reused in Deepgram/DeepSeek modals) ───────────────────────────
  const keyRow = (keyName: string, label: string) => {
    const keyData = keys[keyName];
    const isEditing = editingKey === keyName;
    const isVisible = showKey[keyName];
    return (
      <div key={keyName} style={{ padding: '12px 14px', background: 'var(--surface)', borderRadius: 10, border: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: isEditing ? 10 : 0 }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 500 }}>{label}</div>
            {!isEditing && (
              <div className="mono" style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                {isVisible ? keyData?.value : keyData?.masked || t('settings.notConfigured')}
              </div>
            )}
          </div>
          {!isEditing && (
            <div style={{ display: 'flex', gap: 6 }}>
              {keyData?.value && (
                <button className="btn btn-ghost btn-icon" style={{ width: 30, height: 30 }}
                  onClick={() => setShowKey(p => ({ ...p, [keyName]: !p[keyName] }))}>
                  {isVisible ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
              )}
              <button className="btn btn-sm" onClick={() => { setEditingKey(keyName); setEditValue(''); }}>{t('common.edit')}</button>
            </div>
          )}
        </div>
        {isEditing && (
          <div style={{ display: 'flex', gap: 8 }}>
            <input className="field" value={editValue} onChange={e => setEditValue(e.target.value)}
              placeholder={
                keyName === 'DEEPSEEK_BASE_URL' ? 'https://api.deepseek.com'
                : keyName === 'DEEPSEEK_MODEL' ? 'deepseek-chat'
                : keyName === 'DEEPGRAM_MODEL' ? 'nova-3'
                : keyName === 'DEEPGRAM_LANGUAGE' ? 'multi'
                : keyName === 'GOOGLE_CLIENT_ID' ? '….apps.googleusercontent.com'
                : keyName === 'GOOGLE_CLIENT_SECRET' ? 'GOCSPX-…'
                : t('settings.pasteNewKey')
              }
              style={{ flex: 1, fontSize: 13, fontFamily: 'var(--font-mono)' }}
              autoFocus
              onKeyDown={e => { if (e.key === 'Enter') saveKey(keyName); if (e.key === 'Escape') setEditingKey(null); }}
            />
            <button className="btn btn-primary btn-sm" onClick={() => saveKey(keyName)} disabled={saving || !editValue.trim()}><Save size={13} /></button>
            <button className="btn btn-sm" onClick={() => setEditingKey(null)}>{t('common.cancel')}</button>
          </div>
        )}
        {keyData?.updatedAt && !isEditing && (
          <div style={{ fontSize: 10.5, color: 'var(--muted)', marginTop: 4 }}>
            {t('settings.updated')} {new Date(keyData.updatedAt).toLocaleDateString(locale)}
          </div>
        )}
      </div>
    );
  };

  // ─────────────────────────── modal body per connector ───────────────────────────
  const renderKeysModal = (service: string) => (
    keysLoading
      ? <div style={{ padding: 20, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>{t('common.loading')}</div>
      : <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {API_KEYS_CONFIG.filter(k => k.service === service).map(({ key, label }) => keyRow(key, label))}
        </div>
  );

  const renderGoogleModal = () => {
    const redirect = typeof window !== 'undefined' ? `${window.location.origin}/api/auth/callback/google` : '/api/auth/callback/google';
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
          {t('settings.googleRedirectHint')}
          <code className="mono" style={{ display: 'block', marginTop: 6, padding: '8px 10px', background: 'var(--surface-2)', borderRadius: 8, fontSize: 11.5, wordBreak: 'break-all', color: 'var(--text)' }}>{redirect}</code>
        </div>
        {renderKeysModal('Google OAuth')}
      </div>
    );
  };

  const renderSmtpModal = () => (
    smtpLoading
      ? <div style={{ padding: 20, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>{t('common.loading')}</div>
      : <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
            <FieldWrapper label={t('settings.smtpServer')}>
              <input className="field" value={smtp.host} placeholder="smtp.gmail.com" onChange={e => setSmtp(s => ({ ...s, host: e.target.value }))} />
            </FieldWrapper>
            <FieldWrapper label={t('settings.port')}>
              <input className="field" value={smtp.port} placeholder="587" inputMode="numeric" onChange={e => setSmtp(s => ({ ...s, port: e.target.value }))} />
            </FieldWrapper>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <FieldWrapper label={t('settings.smtpUser')}>
              <input className="field" value={smtp.user} placeholder="admin@example.com" onChange={e => setSmtp(s => ({ ...s, user: e.target.value }))} />
            </FieldWrapper>
            <FieldWrapper label={smtp.passSet ? t('settings.smtpPasswordSet') : t('settings.smtpPassword')}>
              <input className="field" type="password" value={smtpPass} placeholder={smtp.passSet ? '••••••••••••' : 'App Password'} onChange={e => setSmtpPass(e.target.value)} />
            </FieldWrapper>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <FieldWrapper label={t('settings.smtpFrom')}>
              <input className="field" value={smtp.from} placeholder="admin@example.com" onChange={e => setSmtp(s => ({ ...s, from: e.target.value }))} />
            </FieldWrapper>
            <FieldWrapper label={t('settings.smtpFromName')}>
              <input className="field" value={smtp.fromName} placeholder="Garely" onChange={e => setSmtp(s => ({ ...s, fromName: e.target.value }))} />
            </FieldWrapper>
          </div>
          <Toggle label={t('settings.smtpSsl')} value={smtp.secure} onChange={v => setSmtp(s => ({ ...s, secure: v }))} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <button className="btn btn-primary btn-sm" onClick={saveSmtp} disabled={smtpSaving} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {smtpSaving ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Save size={13} />} {t('common.save')}
            </button>
            {smtpSaved && <span style={{ fontSize: 12.5, color: 'var(--green)', display: 'inline-flex', alignItems: 'center', gap: 4 }}><Check size={13} /> {t('common.saved')}</span>}
          </div>
          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>{t('settings.testEmail')}</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input className="field" value={testEmail} placeholder={t('settings.testEmailPlaceholder')} onChange={e => setTestEmail(e.target.value)} style={{ flex: 1, minWidth: 220 }} />
              <button className="btn btn-sm" onClick={sendTest} disabled={testing} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {testing ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Mail size={13} />} {t('settings.sendTest')}
              </button>
            </div>
            {testResult && <div style={{ fontSize: 12.5, color: testResult.ok ? 'var(--green)' : 'var(--red)' }}>{testResult.msg}</div>}
          </div>
        </div>
  );

  const renderS3Modal = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <FieldWrapper label="Bucket">
          <input className="field" value={s3.bucket} placeholder="eam-recordings" onChange={e => setS3(s => ({ ...s, bucket: e.target.value }))} />
        </FieldWrapper>
        <FieldWrapper label="Region">
          <input className="field" value={s3.region} placeholder="us-east-1" onChange={e => setS3(s => ({ ...s, region: e.target.value }))} />
        </FieldWrapper>
      </div>
      <FieldWrapper label={t('settings.s3Endpoint')}>
        <input className="field" value={s3.endpoint} placeholder="https://s3.eu-central-1.wasabisys.com" onChange={e => setS3(s => ({ ...s, endpoint: e.target.value }))} />
      </FieldWrapper>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <FieldWrapper label="Access Key ID">
          <input className="field" value={s3.accessKeyId} placeholder="AKIA..." onChange={e => setS3(s => ({ ...s, accessKeyId: e.target.value }))} />
        </FieldWrapper>
        <FieldWrapper label={s3.secretSet ? t('settings.s3SecretSet') : 'Secret Access Key'}>
          <input className="field" type="password" value={s3Secret} placeholder={s3.secretSet ? '••••••••••••' : 'Secret'} onChange={e => setS3Secret(e.target.value)} />
        </FieldWrapper>
      </div>
      <Toggle label={t('settings.s3ForcePathStyle')} value={s3.forcePathStyle} onChange={v => setS3(s => ({ ...s, forcePathStyle: v }))} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <button className="btn btn-primary btn-sm" onClick={saveS3} disabled={s3Saving} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {s3Saving ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Save size={13} />} {t('common.save')}
        </button>
        <button className="btn btn-sm" onClick={testS3Conn} disabled={s3Testing} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {s3Testing ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Check size={13} />} {t('settings.testConnection')}
        </button>
        {s3Saved && <span style={{ fontSize: 12.5, color: 'var(--green)', display: 'inline-flex', alignItems: 'center', gap: 4 }}><Check size={13} /> {t('common.saved')}</span>}
        {s3Test && <span style={{ fontSize: 12.5, color: s3Test.ok ? 'var(--green)' : '#f87171' }}>{s3Test.msg}</span>}
      </div>
    </div>
  );

  const renderClickupModal = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Toggle label={t('settings.clickupEnabled')} value={clickup.enabled} onChange={v => setClickup(c => ({ ...c, enabled: v }))} />
      <FieldWrapper label={clickup.tokenSet ? t('settings.clickupTokenSet') : t('settings.clickupToken')}>
        <input className="field" type="password" value={clickupToken} placeholder={clickup.tokenSet ? '••••••••••••' : 'pk_...'}
          onChange={e => setClickupToken(e.target.value)} style={{ fontFamily: 'var(--font-mono)' }} />
      </FieldWrapper>
      <FieldWrapper label={t('settings.clickupRouting')}>
        <select className="field" value={clickup.routingMode} onChange={e => setClickup(c => ({ ...c, routingMode: e.target.value === 'inbox' ? 'inbox' : 'department' }))}>
          <option value="department">{t('settings.clickupRoutingDepartment')}</option>
          <option value="inbox">{t('settings.clickupRoutingInbox')}</option>
        </select>
      </FieldWrapper>
      <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>{t('settings.clickupHint')}</div>
      {clickup.migration?.state && (
        <div style={{ fontSize: 12, color: clickup.migration.state === 'error' ? '#f87171' : 'var(--muted)' }}>
          {clickup.migration.state === 'running'
            ? t('settings.clickupMigrating', { done: clickup.migration.migrated ?? 0, total: clickup.migration.total ?? 0 })
            : clickup.migration.state === 'done'
              ? t('settings.clickupMigrated', { count: clickup.migration.migrated ?? 0 })
              : t('settings.clickupMigrationError')}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <button className="btn btn-primary btn-sm" onClick={saveClickup} disabled={clickupSaving} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {clickupSaving ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Save size={13} />} {t('common.save')}
        </button>
        <button className="btn btn-sm" onClick={testClickup} disabled={clickupTesting || (!clickup.tokenSet && !clickupToken.trim())} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {clickupTesting ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Check size={13} />} {t('settings.testConnection')}
        </button>
        {clickupSaved && <span style={{ fontSize: 12.5, color: 'var(--green)', display: 'inline-flex', alignItems: 'center', gap: 4 }}><Check size={13} /> {t('common.saved')}</span>}
        {clickupTest && <span style={{ fontSize: 12.5, color: clickupTest.ok ? 'var(--green)' : '#f87171' }}>{clickupTest.msg}</span>}
      </div>
    </div>
  );

  const renderModalBody = (name: string) => {
    switch (name) {
      case 'Deepgram': return renderKeysModal('Deepgram');
      case 'DeepSeek': return renderKeysModal('DeepSeek');
      case 'SMTP Email': return renderSmtpModal();
      case 'S3 Storage': return renderS3Modal();
      case 'ClickUp': return renderClickupModal();
      case 'Google OAuth': return renderGoogleModal();
      default: return null;
    }
  };

  const current = manage ? integrations.find(i => i.name === manage) : null;

  return (
    <div style={{ maxWidth: 1000, margin: '0 auto' }}>
      <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 14 }}>{t('settings.connectorsSubtitle')}</div>

      {/* Connector grid */}
      {integrations.length === 0 ? (
        <div style={{ padding: 24, textAlign: 'center', color: 'var(--muted)', fontSize: 13 }}>{t('settings.checkingIntegrations')}</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(258px, 1fr))', gap: 12 }}>
          {integrations.map((it) => {
            const connected = it.status === 'connected';
            const manageable = MANAGEABLE.has(it.name);
            const open = manageable ? () => setManage(it.name) : undefined;
            return (
              <div key={it.name} className="card"
                onClick={open}
                role={manageable ? 'button' : undefined}
                tabIndex={manageable ? 0 : undefined}
                onKeyDown={manageable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setManage(it.name); } } : undefined}
                style={{
                  padding: 16, display: 'flex', flexDirection: 'column', gap: 14,
                  cursor: manageable ? 'pointer' : 'default',
                  transition: 'border-color .15s, transform .1s',
                }}
                onMouseEnter={manageable ? (e) => { e.currentTarget.style.borderColor = 'var(--border-2, #3f3f46)'; e.currentTarget.style.transform = 'translateY(-1px)'; } : undefined}
                onMouseLeave={manageable ? (e) => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.transform = 'none'; } : undefined}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                  <div style={{
                    width: 44, height: 44, borderRadius: 12, flexShrink: 0,
                    background: connected ? 'color-mix(in oklab, var(--accent) 16%, var(--surface-2))' : 'var(--surface-2)',
                    color: connected ? 'var(--accent-2)' : 'var(--muted)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>{INTEGRATION_ICONS[it.name] ?? <Plug size={20} />}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{it.name}</div>
                    <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.45, marginTop: 2 }}>{it.desc}</div>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 'auto' }}>
                  {statusPill(it.status)}
                  {manageable ? (
                    <button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); setManage(it.name); }}
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                      {connected ? <><Settings2 size={12} /> {t('settings.manage')}</> : <><Plug size={12} /> {t('settings.connect')}</>}
                    </button>
                  ) : (
                    it.metric && <span className="mono" style={{ fontSize: 11, color: 'var(--muted)' }}>{it.metric}</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Config modal */}
      {manage && current && (
        <div onClick={() => setManage(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(3,5,8,.6)', backdropFilter: 'blur(2px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200, padding: 16 }}>
          <div onClick={(e) => e.stopPropagation()} className="card"
            style={{ width: 'min(580px, 100%)', maxHeight: '88vh', overflowY: 'auto', padding: 0 }}>
            <div style={{ position: 'sticky', top: 0, background: 'var(--surface)', borderBottom: '1px solid var(--border)', padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 12, zIndex: 1 }}>
              <div style={{
                width: 38, height: 38, borderRadius: 10, flexShrink: 0,
                background: current.status === 'connected' ? 'color-mix(in oklab, var(--accent) 16%, var(--surface-2))' : 'var(--surface-2)',
                color: current.status === 'connected' ? 'var(--accent-2)' : 'var(--muted)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>{INTEGRATION_ICONS[current.name]}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 15 }}>{current.name}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)' }}>{current.desc}</div>
              </div>
              <button className="btn btn-ghost btn-icon" style={{ width: 32, height: 32 }} onClick={() => setManage(null)} aria-label={t('common.close')}><X size={16} /></button>
            </div>
            <div style={{ padding: '18px 20px 22px' }}>{renderModalBody(current.name)}</div>
          </div>
        </div>
      )}
    </div>
  );
}
