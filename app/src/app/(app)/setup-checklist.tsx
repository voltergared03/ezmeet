'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { CheckCircle2, AlertCircle, ChevronRight, Loader2, X, Sparkles } from 'lucide-react';

type Integ = { name: string; desc: string; status: string; metric: string };

// Integrations that the operator is expected to configure post-setup. Postgres /
// LiveKit are infra (in compose) so we don't nag about them here.
const TRACKED = ['Google OAuth', 'SMTP Email', 'Deepgram', 'AI model', 'S3 Storage'];

const TEST_ENDPOINT: Record<string, string> = {
  'SMTP Email': '/api/settings/email/test',
  'S3 Storage': '/api/settings/s3/test',
  'AI model': '/api/settings/ai/test',
  Deepgram: '/api/settings/deepgram/test',
};

const DISMISS_KEY = 'eam_setup_checklist_dismissed';

export function SetupChecklist() {
  const t = useTranslations();
  const [integrations, setIntegrations] = useState<Integ[] | null>(null);
  const [hidden, setHidden] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [result, setResult] = useState<Record<string, { ok: boolean; msg: string }>>({});

  useEffect(() => {
    fetch('/api/settings/integrations')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.integrations) setIntegrations(d.integrations); })
      .catch(() => {});
  }, []);

  // Persist the dismissal so it stays hidden across reloads (per browser).
  useEffect(() => {
    try { if (localStorage.getItem(DISMISS_KEY) === '1') setHidden(true); } catch { /* ignore */ }
  }, []);

  const dismiss = () => {
    setHidden(true);
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* ignore */ }
  };

  if (!integrations || hidden) return null;

  const tracked = integrations.filter((i) => TRACKED.includes(i.name));
  const pending = tracked.filter((i) => i.status !== 'connected');
  if (tracked.length === 0 || pending.length === 0) return null; // all set → no nudge

  const done = tracked.length - pending.length;

  const runTest = async (name: string) => {
    const url = TEST_ENDPOINT[name];
    if (!url) return;
    setTesting(name);
    setResult((r) => ({ ...r, [name]: undefined as any }));
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const d = await res.json().catch(() => ({}));
      setResult((r) => ({ ...r, [name]: { ok: res.ok && d.success, msg: res.ok ? 'OK' : (d.error || t('setupChecklist.error')) } }));
    } catch {
      setResult((r) => ({ ...r, [name]: { ok: false, msg: t('setupChecklist.networkError') } }));
    } finally {
      setTesting(null);
    }
  };

  return (
    <div
      className="card fade-in"
      style={{
        padding: '18px 20px', marginBottom: 22,
        background: 'linear-gradient(135deg, color-mix(in oklab, var(--accent) 10%, var(--surface)) 0%, var(--surface) 70%)',
        borderColor: 'color-mix(in oklab, var(--accent) 26%, var(--border))',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <Sparkles size={17} style={{ color: 'var(--accent)' }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 700, fontSize: 14.5 }}>{t('setupChecklist.title')}</div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>
            {t('setupChecklist.summary', { done, total: tracked.length })}
          </div>
        </div>
        <button className="btn btn-ghost btn-icon" title={t('setupChecklist.hide')} onClick={dismiss} style={{ height: 28, width: 28 }}>
          <X size={14} />
        </button>
      </div>

      <div style={{ display: 'grid', gap: 8 }}>
        {pending.map((i) => {
          const res = result[i.name];
          return (
            <div key={i.name} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '9px 12px', background: 'var(--surface-2)', borderRadius: 10 }}>
              <AlertCircle size={15} style={{ color: 'var(--amber, var(--warn))', flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{i.name}</div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{i.desc}</div>
              </div>
              {res && (
                <span style={{ fontSize: 11.5, color: res.ok ? 'var(--green)' : 'var(--red, var(--danger))', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {res.ok ? '✓ OK' : res.msg}
                </span>
              )}
              {TEST_ENDPOINT[i.name] && (
                <button className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px', flexShrink: 0 }} disabled={testing === i.name} onClick={() => runTest(i.name)}>
                  {testing === i.name ? <Loader2 size={13} className="spin" /> : t('setupChecklist.test')}
                </button>
              )}
              <Link href="/settings" className="btn btn-ghost" style={{ fontSize: 12, padding: '5px 10px', flexShrink: 0, color: 'var(--accent)' }}>
                {t('setupChecklist.configure')} <ChevronRight size={13} />
              </Link>
            </div>
          );
        })}
      </div>
    </div>
  );
}
