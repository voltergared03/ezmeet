'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations, useLocale } from 'next-intl';
import {
  Bell, CheckCheck, FileText, ListChecks,
  Zap, AtSign, Video, Trash2,
} from 'lucide-react';

interface Notification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  read: boolean;
  createdAt: string;
}

const TYPE_ICONS: Record<string, typeof Bell> = {
  meeting_starting: Video,
  task_assigned: ListChecks,
  report_ready: FileText,
  action_item: Zap,
  mention: AtSign,
};

const TYPE_COLORS: Record<string, string> = {
  meeting_starting: 'var(--accent)',
  task_assigned: 'var(--warn)',
  report_ready: 'var(--success)',
  action_item: 'var(--purple)',
  mention: 'var(--pink)',
};

function timeAgo(dateStr: string, t: ReturnType<typeof useTranslations>, locale: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return t('notifications.timeJustNow');
  const nf = new Intl.NumberFormat(locale);
  if (mins < 60) return t('notifications.timeMinutesAgo', { count: mins, n: nf.format(mins) });
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return t('notifications.timeHoursAgo', { count: hrs, n: nf.format(hrs) });
  const days = Math.floor(hrs / 24);
  return t('notifications.timeDaysAgo', { count: days, n: nf.format(days) });
}

export default function NotificationsPage() {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);

  const fetchNotifications = useCallback(async () => {
    try {
      const res = await fetch('/api/notifications?limit=50');
      if (res.ok) {
        const data = await res.json();
        setNotifications(data.notifications || []);
        setUnreadCount(data.unreadCount || 0);
      }
    } catch { /* skip */ }
    setLoading(false);
  }, []);

  useEffect(() => { fetchNotifications(); }, [fetchNotifications]);

  const markAllRead = async () => {
    await fetch('/api/notifications', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markAllRead: true }),
    });
    setNotifications(prev => prev.map(n => ({ ...n, read: true })));
    setUnreadCount(0);
  };

  const handleClick = async (notif: Notification) => {
    if (!notif.read) {
      await fetch('/api/notifications', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [notif.id] }),
      });
    }
    if (notif.link) router.push(notif.link);
  };

  const deleteNotif = async (id: string, wasUnread: boolean) => {
    setNotifications(prev => prev.filter(n => n.id !== id));
    if (wasUnread) setUnreadCount(c => Math.max(0, c - 1));
    try {
      await fetch('/api/notifications', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [id] }),
      });
    } catch { /* optimistic — list refetches on next load */ }
  };

  const clearAll = async () => {
    if (!notifications.length) return;
    setNotifications([]);
    setUnreadCount(0);
    try {
      await fetch('/api/notifications', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true }),
      });
    } catch { /* optimistic */ }
  };

  return (
    <div className="page-container" style={{ maxWidth: 640 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <h1 style={{ fontSize: 'clamp(18px, 5vw, 24px)', fontWeight: 700 }}>
          {t('notifications.title')}
          {unreadCount > 0 && (
            <span style={{
              marginLeft: 10, fontSize: 13, fontWeight: 600,
              padding: '3px 9px', borderRadius: 99,
              background: 'rgba(239,68,68,.15)', color: 'var(--danger-fg)',
              verticalAlign: 'middle',
            }}>{unreadCount}</span>
          )}
        </h1>
        <div style={{ display: 'flex', gap: 6 }}>
          {unreadCount > 0 && (
            <button onClick={markAllRead} className="btn btn-ghost btn-sm" style={{ gap: 5 }}>
              <CheckCheck size={14} /> {t('notifications.markAllRead')}
            </button>
          )}
          {notifications.length > 0 && (
            <button onClick={clearAll} className="btn btn-ghost btn-sm" style={{ gap: 5, color: 'var(--muted)' }}>
              <Trash2 size={14} /> {t('notifications.clearAll')}
            </button>
          )}
        </div>
      </div>

      {loading && (
        <div style={{ textAlign: 'center', padding: 40, color: 'var(--muted)' }}>
          {t('common.loading')}
        </div>
      )}

      {!loading && notifications.length === 0 && (
        <div className="card" style={{ textAlign: 'center', padding: '48px 20px' }}>
          <Bell size={36} style={{ margin: '0 auto 12px', opacity: 0.2 }} />
          <div style={{ color: 'var(--muted)', fontSize: 14 }}>{t('notifications.emptyPage')}</div>
        </div>
      )}

      {!loading && notifications.length > 0 && (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          {notifications.map((notif, idx) => {
            const Icon = TYPE_ICONS[notif.type] || Bell;
            const color = TYPE_COLORS[notif.type] || 'var(--accent)';

            return (
              <div
                key={notif.id}
                onClick={() => handleClick(notif)}
                style={{
                  display: 'flex', gap: 12, padding: '14px 16px',
                  cursor: notif.link ? 'pointer' : 'default',
                  background: notif.read ? 'transparent' : 'rgba(59,130,246,.04)',
                  borderBottom: idx < notifications.length - 1 ? '1px solid var(--border)' : 'none',
                  transition: 'background .1s',
                }}
              >
                <div style={{
                  width: 38, height: 38, borderRadius: 10, flexShrink: 0,
                  background: `${color}18`, display: 'flex',
                  alignItems: 'center', justifyContent: 'center',
                }}>
                  <Icon size={18} style={{ color }} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: 14, fontWeight: notif.read ? 500 : 600,
                    color: 'var(--text)', marginBottom: 2,
                  }}>
                    {notif.title}
                  </div>
                  {notif.body && (
                    <div style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.4, marginBottom: 3 }}>
                      {notif.body}
                    </div>
                  )}
                  <div style={{ fontSize: 11, color: 'var(--muted-2)' }}>
                    {timeAgo(notif.createdAt, t, locale)}
                  </div>
                </div>
                {!notif.read && (
                  <div style={{
                    width: 8, height: 8, borderRadius: '50%',
                    background: 'var(--accent)', flexShrink: 0, marginTop: 6,
                  }} />
                )}
                <button
                  onClick={(e) => { e.stopPropagation(); deleteNotif(notif.id, !notif.read); }}
                  className="btn btn-ghost btn-icon"
                  title={t('notifications.deleteOne')}
                  style={{ width: 28, height: 28, flexShrink: 0, color: 'var(--muted-2)', alignSelf: 'center' }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
