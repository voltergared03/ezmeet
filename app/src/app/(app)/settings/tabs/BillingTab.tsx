'use client';

import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { Save, Check, Loader2 } from 'lucide-react';
import { UsageRow, FieldWrapper } from '../components/shared';

type Pricing = { PRICE_DEEPSEEK_IN: number; PRICE_DEEPSEEK_OUT: number; PRICE_DEEPGRAM_MIN: number; EMAIL_LIMIT: number };

export function BillingTab() {
  const t = useTranslations();
  const [usage, setUsage] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  // Provider pricing — drives the cost figures above; lives here (Usage) so the
  // rates sit next to the spend they compute. Saved via the workspace config
  // endpoint (partial PATCH), independent of the Workspace tab.
  const [pricing, setPricing] = useState<Pricing | null>(null);
  const [savingPricing, setSavingPricing] = useState(false);
  const [pricingSaved, setPricingSaved] = useState(false);
  const [pricingErr, setPricingErr] = useState('');

  useEffect(() => {
    fetch('/api/settings/usage')
      .then(r => r.json())
      .then(data => { if (!data.error) setUsage(data); })
      .catch(console.error)
      .finally(() => setLoading(false));
    fetch('/api/settings/workspace')
      .then(r => r.json())
      .then(d => {
        if (!d.error) setPricing({
          PRICE_DEEPSEEK_IN: Number(d.PRICE_DEEPSEEK_IN ?? 0),
          PRICE_DEEPSEEK_OUT: Number(d.PRICE_DEEPSEEK_OUT ?? 0),
          PRICE_DEEPGRAM_MIN: Number(d.PRICE_DEEPGRAM_MIN ?? 0),
          EMAIL_LIMIT: Number(d.EMAIL_LIMIT ?? 0),
        });
      })
      .catch(() => {});
  }, []);

  const setP = (k: keyof Pricing, v: number) => setPricing(p => (p ? { ...p, [k]: v } : p));

  const savePricing = async () => {
    if (!pricing) return;
    setSavingPricing(true); setPricingSaved(false); setPricingErr('');
    try {
      const res = await fetch('/api/settings/workspace', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pricing),
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok) {
        setPricingSaved(true); setTimeout(() => setPricingSaved(false), 2500);
        // Re-pull usage so the cost figures reflect the new rates immediately.
        fetch('/api/settings/usage').then(r => r.json()).then(data => { if (!data.error) setUsage(data); }).catch(() => {});
      } else { setPricingErr(d.error || t('settings.saveFailed')); }
    } catch { setPricingErr(t('settings.networkError')); }
    finally { setSavingPricing(false); }
  };

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>{t('common.loading')}</div>;
  if (!usage) return <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>{t('settings.loadDataFailed')}</div>;

  const costs = usage.costs || {};
  const totalCost = costs.total || 0;
  const uahRate = 41.5;
  const meetingsPct = Math.min(100, (usage.meetings?.thisMonth || 0) * 2);
  const hoursPct = Math.min(100, (usage.hours?.thisMonth || 0) * 2);
  const aiPct = Math.min(100, (usage.actionItems?.thisMonth || 0) / 2);
  const emailPct = usage.emails?.limit ? Math.round((usage.emails.thisMonth / usage.emails.limit) * 100) : 0;

  // Format cost with enough precision
  const fmtCost = (v: number) => {
    if (v === 0) return '$0.00';
    if (v < 0.01) return '$' + v.toFixed(4);
    if (v < 0.10) return '$' + v.toFixed(3);
    return '$' + v.toFixed(2);
  };

  return (
    <div style={{ maxWidth: 1000, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div className="billing-grid" style={{ display: 'grid', gap: 18 }}>
        <div className="card" style={{
          padding: 24, gridColumn: '1 / -1',
          background: 'linear-gradient(135deg, color-mix(in oklab, var(--accent) 14%, var(--surface)) 0%, var(--surface) 60%)',
          borderColor: 'color-mix(in oklab, var(--accent) 25%, var(--border))',
        }}>
          <div style={{ fontSize: 11.5, color: 'var(--accent-2)', textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 600, marginBottom: 8 }}>{t('settings.costThisMonth')}</div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, flexWrap: 'wrap' }}>
            <div style={{ fontSize: 42, fontWeight: 700, letterSpacing: '-0.02em' }}>{fmtCost(totalCost)}</div>
            <div style={{ fontSize: 13, color: 'var(--muted)' }}>{t('settings.costApprox', { amount: (totalCost * uahRate < 1 ? (totalCost * uahRate).toFixed(2) : Math.round(totalCost * uahRate)) })}</div>
          </div>
          <div style={{ marginTop: 14, fontSize: 12.5, color: 'var(--text-2)', display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            <span>DeepSeek {fmtCost(costs.deepseek || 0)}</span>
            <span>Deepgram {fmtCost(costs.deepgram || 0)}</span>
            {(usage.ai?.costPerReport > 0) && <span style={{ color: 'var(--muted)' }}>{t('settings.costPerReport', { amount: fmtCost(usage.ai.costPerReport) })}</span>}
          </div>
        </div>
        <div className="card" style={{ padding: 20 }}>
          <div style={{ fontWeight: 600, marginBottom: 14 }}>{t('settings.thisMonth')}</div>
          <UsageRow label={t('settings.meetingsHeld')} value={String(usage.meetings?.thisMonth || 0)} pct={meetingsPct} />
          <UsageRow label={t('settings.hoursRecorded')} value={String(usage.hours?.thisMonth || 0)} pct={hoursPct} />
          <UsageRow label="Action items" value={String(usage.actionItems?.thisMonth || 0)} pct={aiPct} />
          <UsageRow label="Email" value={(usage.emails?.thisMonth || 0) + ' / ' + (usage.emails?.limit || 3000)} pct={emailPct} />
        </div>
        <div className="card" style={{ padding: 20 }}>
          <div style={{ fontWeight: 600, marginBottom: 14 }}>{t('settings.aiAnalytics')}</div>
          <UsageRow label={t('settings.aiReports')} value={String(usage.ai?.reportsGenerated || 0)} pct={Math.min(100, (usage.ai?.reportsGenerated || 0) * 5)} />
          <UsageRow label={t('settings.tokensInput')} value={((usage.ai?.tokensInput || 0) / 1000).toFixed(1) + 'K'} pct={Math.min(100, (usage.ai?.tokensInput || 0) / 10000)} />
          <UsageRow label={t('settings.tokensOutput')} value={((usage.ai?.tokensOutput || 0) / 1000).toFixed(1) + 'K'} pct={Math.min(100, (usage.ai?.tokensOutput || 0) / 5000)} />
          <UsageRow label={t('settings.transcriptions')} value={String(usage.transcriptSegments?.thisMonth || 0)} pct={Math.min(100, (usage.transcriptSegments?.thisMonth || 0) / 10)} />
          <div className="muted" style={{ fontSize: 11.5, marginTop: 10 }}>
            {t('settings.totalsLine', { meetings: usage.meetings?.total || 0, tasks: usage.actionItems?.total || 0, users: usage.users || 0 })}
          </div>
        </div>
      </div>

      {/* Provider pricing — the rates that compute the costs above */}
      {pricing && (
        <div className="card" style={{ padding: '18px 22px' }}>
          <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>{t('settings.providerPricing')}</div>
          <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 14 }}>{t('settings.providerPricingDesc')}</div>
          <div className="settings-grid-2" style={{ display: 'grid', gap: 14 }}>
            <FieldWrapper label={t('settings.deepseekInputPrice')}>
              <input className="field" type="number" step="0.01" value={pricing.PRICE_DEEPSEEK_IN} onChange={e => setP('PRICE_DEEPSEEK_IN', Number(e.target.value))} />
            </FieldWrapper>
            <FieldWrapper label={t('settings.deepseekOutputPrice')}>
              <input className="field" type="number" step="0.01" value={pricing.PRICE_DEEPSEEK_OUT} onChange={e => setP('PRICE_DEEPSEEK_OUT', Number(e.target.value))} />
            </FieldWrapper>
            <FieldWrapper label={t('settings.deepgramPrice')}>
              <input className="field" type="number" step="0.0001" value={pricing.PRICE_DEEPGRAM_MIN} onChange={e => setP('PRICE_DEEPGRAM_MIN', Number(e.target.value))} />
            </FieldWrapper>
            <FieldWrapper label={t('settings.emailLimitPerMonth')}>
              <input className="field" type="number" value={pricing.EMAIL_LIMIT} onChange={e => setP('EMAIL_LIMIT', Number(e.target.value))} />
            </FieldWrapper>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16 }}>
            <button className="btn btn-primary" onClick={savePricing} disabled={savingPricing}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {savingPricing ? <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> : <Save size={14} />} {t('common.save')}
            </button>
            {pricingSaved && (
              <span style={{ fontSize: 13, color: 'var(--green)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <Check size={14} /> {t('common.saved')}
              </span>
            )}
            {pricingErr && <span style={{ fontSize: 13, color: 'var(--red)' }}>{pricingErr}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
