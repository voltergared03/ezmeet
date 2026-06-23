'use client';

import { useState, useEffect } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import {
  Globe, Mic, Sparkles, Video, Mail, Archive, Download,
  Key, Eye, EyeOff, Loader2, Save, Check, ListChecks, X, Settings2, Plug, MessageSquare, GitBranch,
} from 'lucide-react';
import { Toggle, FieldWrapper } from '../components/shared';
import { LinearIcon, ClickUpIcon, DeepgramIcon, LiveKitIcon, PostgresIcon, S3Icon, GoogleIcon } from '../components/BrandIcons';

// Which connectors open a config modal (the rest are read-only status cards).
const MANAGEABLE = new Set(['Deepgram', 'AI model', 'SMTP Email', 'S3 Storage', 'ClickUp', 'Linear', 'Google OAuth', 'Chat']);

export function IntegrationsTab() {
  const t = useTranslations();
  const locale = useLocale();
  const INTEGRATION_ICONS: Record<string, React.ReactNode> = {
    LiveKit: <LiveKitIcon />,
    Deepgram: <DeepgramIcon />,
    'AI model': <Sparkles size={20} />,
    'SMTP Email': <Mail size={20} />,
    'Google OAuth': <GoogleIcon />,
    PostgreSQL: <PostgresIcon />,
    'S3 Storage': <S3Icon />,
    ClickUp: <ClickUpIcon />,
    Linear: <LinearIcon />,
    Chat: <MessageSquare size={20} />,
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

  // Linear two-way sync config (mirrors ClickUp)
  const [linear, setLinear] = useState<{ enabled: boolean; tokenSet: boolean; routingMode: 'department' | 'inbox'; migration?: { state?: string; total?: number; migrated?: number } | null }>({ enabled: false, tokenSet: false, routingMode: 'department' });
  const [linearToken, setLinearToken] = useState('');
  const [linearSaving, setLinearSaving] = useState(false);
  const [linearSaved, setLinearSaved] = useState(false);
  const [linearTesting, setLinearTesting] = useState(false);
  const [linearTest, setLinearTest] = useState<{ ok: boolean; msg: string } | null>(null);

  // Chat notifications config (Telegram / Slack / Mattermost / Discord)
  const [chat, setChat] = useState<{ enabled: boolean; provider: string; chatId: string; botTokenSet: boolean; webhookSet: boolean }>({ enabled: false, provider: 'telegram', chatId: '', botTokenSet: false, webhookSet: false });
  const [chatBotToken, setChatBotToken] = useState('');
  const [chatWebhook, setChatWebhook] = useState('');
  const [chatSaving, setChatSaving] = useState(false);
  const [chatSaved, setChatSaved] = useState(false);
  const [chatTesting, setChatTesting] = useState(false);
  const [chatTestRes, setChatTestRes] = useState<{ ok: boolean; msg: string } | null>(null);

  // AI model provider config (DeepSeek / OpenRouter / OpenAI / Anthropic / Ollama / Custom)
  const [ai, setAi] = useState<{ provider: string; baseUrl: string; model: string; maxTokens: string; apiKeySet: boolean }>({ provider: 'deepseek', baseUrl: '', model: '', maxTokens: '', apiKeySet: false });
  const [aiKey, setAiKey] = useState('');
  const [aiPresets, setAiPresets] = useState<Record<string, { label: string; baseUrl: string; model: string; keyless?: boolean }>>({});
  const [aiModels, setAiModels] = useState<{ id: string; maxOutput: number | null; contextLength: number | null }[]>([]);
  const [aiModelsLoading, setAiModelsLoading] = useState(false);
  const [aiModelsErr, setAiModelsErr] = useState('');
  const [aiCustom, setAiCustom] = useState(false); // manual model-id entry (vs. the fetched dropdown)
  const [aiSaving, setAiSaving] = useState(false);
  const [aiSaved, setAiSaved] = useState(false);
  const [aiTesting, setAiTesting] = useState(false);
  const [aiTestRes, setAiTestRes] = useState<{ ok: boolean; msg: string } | null>(null);

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

  useEffect(() => {
    fetch('/api/settings/linear')
      .then(r => r.json())
      .then(d => {
        if (!d.error) setLinear({
          enabled: !!d.enabled, tokenSet: !!d.tokenSet,
          routingMode: d.routingMode === 'inbox' ? 'inbox' : 'department',
          migration: d.migration ?? null,
        });
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch('/api/settings/chat')
      .then(r => r.json())
      .then(d => {
        if (!d.error) setChat({
          enabled: !!d.enabled, provider: d.provider || 'telegram', chatId: d.chatId || '',
          botTokenSet: !!d.botTokenSet, webhookSet: !!d.webhookSet,
        });
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch('/api/settings/ai')
      .then(r => r.json())
      .then(d => {
        if (!d.error) {
          setAi({ provider: d.provider || 'deepseek', baseUrl: d.baseUrl || '', model: d.model || '', maxTokens: d.maxTokens ? String(d.maxTokens) : '', apiKeySet: !!d.apiKeySet });
          if (d.presets) setAiPresets(d.presets);
        }
      })
      .catch(() => {});
  }, []);

  // Auto-load the provider's model list the first time the AI modal opens (when a
  // key is already saved, or the provider is keyless), so the dropdown is ready.
  useEffect(() => {
    if (manage === 'AI model' && aiModels.length === 0 && !aiModelsLoading && (ai.apiKeySet || aiPresets[ai.provider]?.keyless)) {
      loadAiModels();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manage]);

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

  const saveLinear = async () => {
    setLinearSaving(true); setLinearSaved(false);
    try {
      const payload: any = { enabled: linear.enabled, routingMode: linear.routingMode };
      if (linearToken.trim()) payload.token = linearToken.trim();
      const res = await fetch('/api/settings/linear', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (res.ok) {
        setLinearSaved(true);
        if (linearToken.trim()) { setLinear(c => ({ ...c, tokenSet: true })); setLinearToken(''); }
        setTimeout(() => setLinearSaved(false), 2500);
        refreshIntegrations();
      }
    } catch (e) { console.error(e); }
    finally { setLinearSaving(false); }
  };

  const testLinear = async () => {
    setLinearTesting(true); setLinearTest(null);
    try {
      if (linearToken.trim()) {
        const saveRes = await fetch('/api/settings/linear', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: linearToken.trim() }) });
        if (!saveRes.ok) { setLinearTest({ ok: false, msg: t('settings.networkError') }); return; }
        setLinear(c => ({ ...c, tokenSet: true })); setLinearToken('');
      }
      const res = await fetch('/api/settings/linear/test', { method: 'POST' });
      const d = await res.json().catch(() => ({}));
      setLinearTest(res.ok
        ? { ok: true, msg: d.team ? `${t('settings.connectionSuccess')} · ${d.team}` : t('settings.connectionSuccess') }
        : { ok: false, msg: d.error || t('settings.networkError') });
    } catch { setLinearTest({ ok: false, msg: t('settings.networkError') }); }
    finally { setLinearTesting(false); }
  };

  const saveChat = async () => {
    setChatSaving(true); setChatSaved(false);
    try {
      const payload: any = { enabled: chat.enabled, provider: chat.provider, chatId: chat.chatId };
      if (chatBotToken.trim()) payload.botToken = chatBotToken.trim();
      if (chatWebhook.trim()) payload.webhookUrl = chatWebhook.trim();
      const res = await fetch('/api/settings/chat', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (res.ok) {
        setChatSaved(true);
        if (chatBotToken.trim()) { setChat(c => ({ ...c, botTokenSet: true })); setChatBotToken(''); }
        if (chatWebhook.trim()) { setChat(c => ({ ...c, webhookSet: true })); setChatWebhook(''); }
        setTimeout(() => setChatSaved(false), 2500);
        refreshIntegrations();
      }
    } catch (e) { console.error(e); }
    finally { setChatSaving(false); }
  };

  const testChat = async () => {
    setChatTesting(true); setChatTestRes(null);
    try {
      // Persist the current form first so the test message uses it (no need to enable yet).
      const payload: any = { provider: chat.provider, chatId: chat.chatId };
      if (chatBotToken.trim()) payload.botToken = chatBotToken.trim();
      if (chatWebhook.trim()) payload.webhookUrl = chatWebhook.trim();
      const saveRes = await fetch('/api/settings/chat', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (!saveRes.ok) { setChatTestRes({ ok: false, msg: t('settings.networkError') }); return; }
      if (chatBotToken.trim()) { setChat(c => ({ ...c, botTokenSet: true })); setChatBotToken(''); }
      if (chatWebhook.trim()) { setChat(c => ({ ...c, webhookSet: true })); setChatWebhook(''); }
      const res = await fetch('/api/settings/chat/test', { method: 'POST' });
      const d = await res.json().catch(() => ({}));
      setChatTestRes(res.ok ? { ok: true, msg: t('settings.testSent') } : { ok: false, msg: d.error || t('settings.networkError') });
    } catch { setChatTestRes({ ok: false, msg: t('settings.networkError') }); }
    finally { setChatTesting(false); }
  };

  const loadAiModels = async () => {
    setAiModelsLoading(true); setAiModelsErr('');
    try {
      const payload: any = { provider: ai.provider, baseUrl: ai.baseUrl };
      if (aiKey.trim()) payload.apiKey = aiKey.trim();
      const res = await fetch('/api/settings/ai/models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const d = await res.json().catch(() => ({}));
      if (res.ok && Array.isArray(d.models)) {
        setAiModels(d.models);
        if (!d.models.length) setAiModelsErr(t('settings.aiModelsEmpty'));
      } else {
        setAiModels([]); setAiModelsErr(d.error || t('settings.networkError'));
      }
    } catch { setAiModels([]); setAiModelsErr(t('settings.networkError')); }
    finally { setAiModelsLoading(false); }
  };

  const saveAi = async () => {
    setAiSaving(true); setAiSaved(false);
    try {
      const payload: any = { provider: ai.provider, baseUrl: ai.baseUrl, model: ai.model, maxTokens: ai.maxTokens.trim() ? Number(ai.maxTokens) : 0 };
      if (aiKey.trim()) payload.apiKey = aiKey.trim();
      const res = await fetch('/api/settings/ai', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (res.ok) {
        setAiSaved(true);
        if (aiKey.trim()) { setAi(a => ({ ...a, apiKeySet: true })); setAiKey(''); }
        setTimeout(() => setAiSaved(false), 2500);
        refreshIntegrations();
      }
    } catch (e) { console.error(e); }
    finally { setAiSaving(false); }
  };

  const testAi = async () => {
    setAiTesting(true); setAiTestRes(null);
    try {
      // Persist the current form first so the probe uses it.
      const payload: any = { provider: ai.provider, baseUrl: ai.baseUrl, model: ai.model, maxTokens: ai.maxTokens.trim() ? Number(ai.maxTokens) : 0 };
      if (aiKey.trim()) payload.apiKey = aiKey.trim();
      const saveRes = await fetch('/api/settings/ai', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (!saveRes.ok) { setAiTestRes({ ok: false, msg: t('settings.networkError') }); return; }
      if (aiKey.trim()) { setAi(a => ({ ...a, apiKeySet: true })); setAiKey(''); }
      const res = await fetch('/api/settings/ai/test', { method: 'POST' });
      const d = await res.json().catch(() => ({}));
      setAiTestRes(res.ok
        ? { ok: true, msg: d.model ? `${t('settings.connectionSuccess')} · ${d.model}` : t('settings.connectionSuccess') }
        : { ok: false, msg: d.error || t('settings.networkError') });
    } catch { setAiTestRes({ ok: false, msg: t('settings.networkError') }); }
    finally { setAiTesting(false); }
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
                keyName === 'DEEPGRAM_MODEL' ? 'nova-3'
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

  const renderLinearModal = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <Toggle label={t('settings.linearEnabled')} value={linear.enabled} onChange={v => setLinear(c => ({ ...c, enabled: v }))} />
      <FieldWrapper label={linear.tokenSet ? t('settings.linearTokenSet') : t('settings.linearToken')}>
        <input className="field" type="password" value={linearToken} placeholder={linear.tokenSet ? '••••••••••••' : 'lin_api_...'}
          onChange={e => setLinearToken(e.target.value)} style={{ fontFamily: 'var(--font-mono)' }} />
      </FieldWrapper>
      <FieldWrapper label={t('settings.linearRouting')}>
        <select className="field" value={linear.routingMode} onChange={e => setLinear(c => ({ ...c, routingMode: e.target.value === 'inbox' ? 'inbox' : 'department' }))}>
          <option value="department">{t('settings.linearRoutingDepartment')}</option>
          <option value="inbox">{t('settings.linearRoutingInbox')}</option>
        </select>
      </FieldWrapper>
      <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>{t('settings.linearHint')}</div>
      {linear.migration?.state && (
        <div style={{ fontSize: 12, color: linear.migration.state === 'error' ? '#f87171' : 'var(--muted)' }}>
          {linear.migration.state === 'running'
            ? t('settings.clickupMigrating', { done: linear.migration.migrated ?? 0, total: linear.migration.total ?? 0 })
            : linear.migration.state === 'done'
              ? t('settings.clickupMigrated', { count: linear.migration.migrated ?? 0 })
              : t('settings.clickupMigrationError')}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <button className="btn btn-primary btn-sm" onClick={saveLinear} disabled={linearSaving} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {linearSaving ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Save size={13} />} {t('common.save')}
        </button>
        <button className="btn btn-sm" onClick={testLinear} disabled={linearTesting || (!linear.tokenSet && !linearToken.trim())} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {linearTesting ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Check size={13} />} {t('settings.testConnection')}
        </button>
        {linearSaved && <span style={{ fontSize: 12.5, color: 'var(--green)', display: 'inline-flex', alignItems: 'center', gap: 4 }}><Check size={13} /> {t('common.saved')}</span>}
        {linearTest && <span style={{ fontSize: 12.5, color: linearTest.ok ? 'var(--green)' : '#f87171' }}>{linearTest.msg}</span>}
      </div>
    </div>
  );

  const renderChatModal = () => {
    const isTelegram = chat.provider === 'telegram';
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Toggle label={t('settings.chatEnabled')} value={chat.enabled} onChange={v => setChat(c => ({ ...c, enabled: v }))} />
        <FieldWrapper label={t('settings.chatProvider')}>
          <select className="field" value={chat.provider} onChange={e => setChat(c => ({ ...c, provider: e.target.value }))}>
            <option value="telegram">Telegram</option>
            <option value="slack">Slack</option>
            <option value="mattermost">Mattermost</option>
            <option value="discord">Discord</option>
          </select>
        </FieldWrapper>
        {isTelegram ? (
          <>
            <FieldWrapper label={chat.botTokenSet ? t('settings.chatBotTokenSet') : t('settings.chatBotToken')}>
              <input className="field" type="password" value={chatBotToken} placeholder={chat.botTokenSet ? '••••••••••••' : '123456:ABC-…'}
                onChange={e => setChatBotToken(e.target.value)} style={{ fontFamily: 'var(--font-mono)' }} />
            </FieldWrapper>
            <FieldWrapper label={t('settings.chatChatId')}>
              <input className="field" value={chat.chatId} placeholder="-1001234567890"
                onChange={e => setChat(c => ({ ...c, chatId: e.target.value }))} style={{ fontFamily: 'var(--font-mono)' }} />
            </FieldWrapper>
          </>
        ) : (
          <FieldWrapper label={chat.webhookSet ? t('settings.chatWebhookSet') : t('settings.chatWebhook')}>
            <input className="field" type="password" value={chatWebhook} placeholder={chat.webhookSet ? '••••••••••••' : 'https://…'}
              onChange={e => setChatWebhook(e.target.value)} style={{ fontFamily: 'var(--font-mono)' }} />
          </FieldWrapper>
        )}
        <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>{t('settings.chatHint')}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <button className="btn btn-primary btn-sm" onClick={saveChat} disabled={chatSaving} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {chatSaving ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Save size={13} />} {t('common.save')}
          </button>
          <button className="btn btn-sm" onClick={testChat} disabled={chatTesting || (isTelegram ? (!chat.botTokenSet && !chatBotToken.trim()) : (!chat.webhookSet && !chatWebhook.trim()))} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {chatTesting ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <MessageSquare size={13} />} {t('settings.sendTest')}
          </button>
          {chatSaved && <span style={{ fontSize: 12.5, color: 'var(--green)', display: 'inline-flex', alignItems: 'center', gap: 4 }}><Check size={13} /> {t('common.saved')}</span>}
          {chatTestRes && <span style={{ fontSize: 12.5, color: chatTestRes.ok ? 'var(--green)' : '#f87171' }}>{chatTestRes.msg}</span>}
        </div>
      </div>
    );
  };

  const renderAiModal = () => {
    const keyless = !!aiPresets[ai.provider]?.keyless;
    const selModel = aiModels.find(m => m.id === ai.model);
    const modelMax = selModel?.maxOutput || null;
    const showSelect = aiModels.length > 0 && !aiCustom;
    // A saved/custom model id not present in the fetched list still needs an option.
    const extraModel = ai.model && !aiModels.some(m => m.id === ai.model) ? ai.model : '';
    const fmtTok = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <FieldWrapper label={t('settings.aiProvider')}>
          <select className="field" value={ai.provider}
            onChange={e => { const p = e.target.value; const pr = aiPresets[p]; setAi(a => ({ ...a, provider: p, baseUrl: pr?.baseUrl || '', model: pr?.model || '' })); setAiTestRes(null); setAiModels([]); setAiModelsErr(''); setAiCustom(false); }}>
            {Object.entries(aiPresets).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
        </FieldWrapper>
        {!keyless && (
          <FieldWrapper label={ai.apiKeySet ? t('settings.aiKeySet') : t('settings.aiKey')}>
            <input className="field" type="password" value={aiKey} placeholder={ai.apiKeySet ? '••••••••••••' : 'sk-…'}
              onChange={e => setAiKey(e.target.value)} style={{ fontFamily: 'var(--font-mono)' }} />
          </FieldWrapper>
        )}
        <FieldWrapper label={t('settings.aiBaseUrl')}>
          <input className="field" value={ai.baseUrl} placeholder="https://api.deepseek.com"
            onChange={e => setAi(a => ({ ...a, baseUrl: e.target.value }))} style={{ fontFamily: 'var(--font-mono)' }} />
        </FieldWrapper>
        <FieldWrapper label={t('settings.aiModel')}>
          <div style={{ display: 'flex', gap: 8 }}>
            {showSelect ? (
              <select className="field" value={ai.model} style={{ flex: 1, fontFamily: 'var(--font-mono)' }}
                onChange={e => { const v = e.target.value; if (v === '__custom') { setAiCustom(true); } else { setAi(a => ({ ...a, model: v })); } }}>
                {!ai.model && <option value="" disabled>{t('settings.aiModelPick')}</option>}
                {extraModel && <option value={extraModel}>{extraModel}</option>}
                {aiModels.map(m => <option key={m.id} value={m.id}>{m.id}{m.maxOutput ? ` — ${fmtTok(m.maxOutput)} max` : m.contextLength ? ` — ${fmtTok(m.contextLength)} ctx` : ''}</option>)}
                <option value="__custom">{t('settings.aiModelCustom')}</option>
              </select>
            ) : (
              <input className="field" value={ai.model} placeholder="deepseek-chat"
                onChange={e => setAi(a => ({ ...a, model: e.target.value }))} style={{ flex: 1, fontFamily: 'var(--font-mono)' }} />
            )}
            <button className="btn btn-sm" onClick={loadAiModels} disabled={aiModelsLoading || (!keyless && !ai.apiKeySet && !aiKey.trim())} title={t('settings.aiLoadModels')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
              {aiModelsLoading ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Download size={13} />} {t('settings.aiLoadModels')}
            </button>
          </div>
          {aiModels.length > 0 && !aiCustom && <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4 }}>{t('settings.aiModelsLoaded', { count: aiModels.length })}</div>}
          {aiModels.length > 0 && aiCustom && <button className="btn btn-ghost" style={{ fontSize: 11, padding: '1px 0', marginTop: 4 }} onClick={() => setAiCustom(false)}>{t('settings.aiModelFromList')}</button>}
          {aiModelsErr && <div style={{ fontSize: 11.5, color: '#f87171', marginTop: 4 }}>{aiModelsErr}</div>}
        </FieldWrapper>
        <FieldWrapper label={t('settings.aiMaxTokens')}>
          <input className="field" type="number" min={0} value={ai.maxTokens} placeholder={t('settings.aiMaxTokensAuto')}
            onChange={e => setAi(a => ({ ...a, maxTokens: e.target.value }))} style={{ fontFamily: 'var(--font-mono)' }} />
          {modelMax && (
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 4, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {t('settings.aiModelMax', { n: modelMax.toLocaleString() })}
              <button className="btn btn-ghost" style={{ fontSize: 11, padding: '1px 7px' }} onClick={() => setAi(a => ({ ...a, maxTokens: String(modelMax) }))}>{t('settings.aiUseMax')}</button>
            </div>
          )}
        </FieldWrapper>
        <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>{t('settings.aiHint')}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <button className="btn btn-primary btn-sm" onClick={saveAi} disabled={aiSaving} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {aiSaving ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Save size={13} />} {t('common.save')}
          </button>
          <button className="btn btn-sm" onClick={testAi} disabled={aiTesting || (!keyless && !ai.apiKeySet && !aiKey.trim())} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {aiTesting ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> : <Check size={13} />} {t('settings.testConnection')}
          </button>
          {aiSaved && <span style={{ fontSize: 12.5, color: 'var(--green)', display: 'inline-flex', alignItems: 'center', gap: 4 }}><Check size={13} /> {t('common.saved')}</span>}
          {aiTestRes && <span style={{ fontSize: 12.5, color: aiTestRes.ok ? 'var(--green)' : '#f87171' }}>{aiTestRes.msg}</span>}
        </div>
      </div>
    );
  };

  const renderModalBody = (name: string) => {
    switch (name) {
      case 'Deepgram': return renderKeysModal('Deepgram');
      case 'AI model': return renderAiModal();
      case 'SMTP Email': return renderSmtpModal();
      case 'S3 Storage': return renderS3Modal();
      case 'ClickUp': return renderClickupModal();
      case 'Linear': return renderLinearModal();
      case 'Google OAuth': return renderGoogleModal();
      case 'Chat': return renderChatModal();
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
