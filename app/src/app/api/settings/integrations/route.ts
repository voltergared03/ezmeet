import { NextResponse } from 'next/server';
import { getTranslations } from 'next-intl/server';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { readConfig, getLlmConfig, getGoogleConfig, LLM_PRESETS } from '@/lib/config';
import { getSmtpConfig } from '@/lib/email';
import { getS3Config } from '@/lib/s3';
import { isChatConfigured } from '@/lib/chat-notify';
import { getWebhooksForApi } from '@/lib/webhooks';

// GET /api/settings/integrations — real status + metrics for each integration
export async function GET() {
  const session = await auth();
  if (!session?.user || session.user.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const t = await getTranslations('integrations');

  // PostgreSQL: ping + size
  let dbStatus: 'connected' | 'error' = 'error';
  let dbSize = '';
  try {
    const rows = await prisma.$queryRaw<{ size: bigint }[]>`SELECT pg_database_size(current_database()) AS size`;
    const bytes = Number(rows[0]?.size || 0);
    dbSize = bytes >= 1048576 ? `${(bytes / 1048576).toFixed(0)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
    dbStatus = 'connected';
  } catch {
    dbStatus = 'error';
  }

  const [userCount, liveMeetings] = await Promise.all([
    prisma.user.count().catch(() => 0),
    prisma.meeting.count({ where: { status: 'live' } }).catch(() => 0),
  ]);

  const keys = await readConfig(['DEEPGRAM_API_KEY', 'DEEPGRAM_MODEL', 'CLICKUP_ENABLED', 'CLICKUP_TOKEN', 'CLICKUP_ROUTING_MODE', 'LINEAR_ENABLED', 'LINEAR_TOKEN', 'LINEAR_ROUTING_MODE', 'CHAT_PROVIDER', 'CRM_ENABLED', 'CRM_TOKEN', 'CRM_PROVIDER']);
  const ai = await getLlmConfig();
  const smtp = await getSmtpConfig().catch(() => null);
  const s3 = await getS3Config().catch(() => null);
  const google = await getGoogleConfig().catch(() => ({ clientId: '', clientSecret: '' }));

  // Ollama runs locally with no key; every other provider needs one.
  const aiOk = !!ai.apiKey || ai.provider === 'ollama';
  const deepgramOk = !!(keys.DEEPGRAM_API_KEY || process.env.DEEPGRAM_API_KEY);
  const livekitOk = !!(process.env.LIVEKIT_URL || process.env.LIVEKIT_WS_URL || process.env.LIVEKIT_API_KEY);
  // Google creds are normally set via the /setup wizard (stored in the DB), so
  // check DB+env (getGoogleConfig) — NOT env alone, else a wizard-configured
  // workspace is falsely flagged "not configured" and the checklist nags forever.
  const googleOk = !!(google.clientId && google.clientSecret);
  const clickupOk = keys.CLICKUP_ENABLED === 'true' && !!(keys.CLICKUP_TOKEN || '').trim();
  const clickupMetric = clickupOk
    ? (keys.CLICKUP_ROUTING_MODE === 'inbox' ? t('clickupInbox') : t('clickupByDept'))
    : t('notConfiguredMetric');
  const linearOk = keys.LINEAR_ENABLED === 'true' && !!(keys.LINEAR_TOKEN || '').trim();
  const linearMetric = linearOk
    ? (keys.LINEAR_ROUTING_MODE === 'inbox' ? t('clickupInbox') : t('clickupByDept'))
    : t('notConfiguredMetric');
  const chatOk = await isChatConfigured();
  const chatMetric = chatOk ? (keys.CHAT_PROVIDER || 'telegram') : t('notConfiguredMetric');
  const webhookEndpoints = await getWebhooksForApi().catch(() => []);
  const webhookActive = webhookEndpoints.filter((e) => e.enabled).length;
  const webhookOk = webhookActive > 0;
  const webhookMetric = webhookOk ? t('webhooksActive', { count: webhookActive }) : t('notConfiguredMetric');
  const crmOk = keys.CRM_ENABLED === 'true' && !!(keys.CRM_TOKEN || '').trim();
  const crmMetric = crmOk ? (keys.CRM_PROVIDER || 'hubspot') : t('notConfiguredMetric');

  const integrations = [
    { name: 'LiveKit', desc: 'WebRTC SFU', status: livekitOk ? 'connected' : 'not_configured', metric: liveMeetings > 0 ? t('liveMeetings', { count: liveMeetings }) : 'self-hosted' },
    { name: 'Deepgram', desc: 'Multilingual STT', status: deepgramOk ? 'connected' : 'not_configured', metric: keys.DEEPGRAM_MODEL || 'nova-3' },
    { name: 'AI model', desc: t('descAi'), status: aiOk ? 'connected' : 'not_configured', metric: `${LLM_PRESETS[ai.provider].label} · ${ai.model}` },
    { name: 'SMTP Email', desc: t('descSmtp'), status: smtp ? 'connected' : 'not_configured', metric: smtp ? smtp.host : t('notConfiguredMetric') },
    { name: 'Google OAuth', desc: t('descGoogle'), status: googleOk ? 'connected' : 'not_configured', metric: t('users', { count: userCount }) },
    { name: 'PostgreSQL', desc: 'Prisma · self-hosted', status: dbStatus, metric: dbSize },
    { name: 'S3 Storage', desc: t('descS3'), status: s3 ? 'connected' : 'not_configured', metric: s3 ? s3.bucket : t('notConfiguredMetric') },
    { name: 'ClickUp', desc: t('descClickup'), status: clickupOk ? 'connected' : 'not_configured', metric: clickupMetric },
    { name: 'Linear', desc: t('descLinear'), status: linearOk ? 'connected' : 'not_configured', metric: linearMetric },
    { name: 'Chat', desc: t('descChat'), status: chatOk ? 'connected' : 'not_configured', metric: chatMetric },
    { name: 'Webhooks', desc: t('descWebhooks'), status: webhookOk ? 'connected' : 'not_configured', metric: webhookMetric },
    { name: 'CRM', desc: t('descCrm'), status: crmOk ? 'connected' : 'not_configured', metric: crmMetric },
  ];

  return NextResponse.json({ integrations });
}
