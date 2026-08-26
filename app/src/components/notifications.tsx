'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations, useLocale } from 'next-intl';
import {
  Bell, Check, CheckCheck, FileText, ListChecks,
  Zap, AtSign, Video, X, Trash2,
} from 'lucide-react';
import { PushOptInBanner } from '@/components/push-optin-banner';

interface Notification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  read: boolean;
  meetingId: string | null;
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
  if (mins < 60) return t('notifications.timeMinutesShort', { count: mins, n: nf.format(mins) });
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return t('notifications.timeHoursShort', { count: hrs, n: nf.format(hrs) });
  const days = Math.floor(hrs / 24);
  return t('notifications.timeDaysShort', { count: days, n: nf.format(days) });
}

export function NotificationBell({ placement = 'up' }: { placement?: 'up' | 'down' }) {
  const t = useTranslations();
  const locale = useLocale();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const fetchNotifications = useCallback(async () => {
    try {
      const res = await fetch('/api/notifications?limit=20');
      if (res.ok) {
        const data = await res.json();
        setNotifications(data.notifications || []);
        setUnreadCount(data.unreadCount || 0);
      }
    } catch { /* skip */ }
  }, []);

  // Poll for notifications every 30s
  useEffect(() => {
    fetchNotifications();
    const iv = setInterval(fetchNotifications, 30000);
    return () => clearInterval(iv);
  }, [fetchNotifications]);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const markAllRead = async () => {
    setLoading(true);
    try {
      await fetch('/api/notifications', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ markAllRead: true }),
      });
      setNotifications(prev => prev.map(n => ({ ...n, read: true })));
      setUnreadCount(0);
    } catch { /* skip */ }
    setLoading(false);
  };

  const handleClick = async (notif: Notification) => {
    // Mark as read
    if (!notif.read) {
      try {
        await fetch('/api/notifications', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: [notif.id] }),
        });
        setNotifications(prev =>
          prev.map(n => n.id === notif.id ? { ...n, read: true } : n)
        );
        setUnreadCount(prev => Math.max(0, prev - 1));
      } catch { /* skip */ }
    }
    // Navigate
    if (notif.link) {
      setOpen(false);
      router.push(notif.link);
    }
  };

  const deleteNotif = async (e: React.MouseEvent, notif: Notification) => {
    e.stopPropagation();
    setNotifications(prev => prev.filter(n => n.id !== notif.id));
    if (!notif.read) setUnreadCount(prev => Math.max(0, prev - 1));
    try {
      await fetch('/api/notifications', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [notif.id] }),
      });
    } catch { /* optimistic — polling reconciles */ }
  };

  const clearAll = async () => {
    setLoading(true);
    try {
      await fetch('/api/notifications', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true }),
      });
      setNotifications([]);
      setUnreadCount(0);
    } catch { /* skip */ }
    setLoading(false);
  };

  return (
    <div ref={panelRef} style={{ position: 'relative' }}>
      {/* Bell Button */}
      <button
        onClick={() => setOpen(!open)}
        className="btn btn-ghost btn-icon"
        title={t('notifications.title')}
        style={{
          position: 'relative', width: 36, height: 36,
        }}
      >
        <Bell size={18} />
        {unreadCount > 0 && (
          <span style={{
            position: 'absolute', top: 2, right: 2,
            minWidth: 16, height: 16, borderRadius: 99,
            background: 'var(--danger)', color: 'var(--on-accent)',
            fontSize: 9, fontWeight: 700,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: '0 4px',
            border: '2px solid var(--bg)',
          }}>
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {/* Dropdown Panel */}
      {open && (
        <div style={{
          position: 'absolute',
          ...(placement === 'down' ? { top: 'calc(100% + 8px)', right: 0 } : { bottom: 'calc(100% + 8px)', left: 0 }),
          width: 'min(360px, calc(100vw - 24px))', maxHeight: 480,
          background: 'var(--surface)', border: '1px solid var(--border)',
          borderRadius: 16, boxShadow: '0 20px 60px var(--overlay)',
          display: 'flex', flexDirection: 'column',
          zIndex: 1000, overflow: 'hidden',
          animation: 'fadeIn .15s ease',
        }}>
          {/* Header */}
          <div style={{
            padding: '14px 16px', display: 'flex', alignItems: 'center',
            justifyContent: 'space-between', borderBottom: '1px solid var(--border)',
            flexShrink: 0,
          }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>
              {t('notifications.title')}
              {unreadCount > 0 && (
                <span style={{
                  marginLeft: 8, fontSize: 11, fontWeight: 600,
                  padding: '2px 7px', borderRadius: 99,
                  background: 'rgba(239,68,68,.15)', color: 'var(--danger-fg)',
                }}>{unreadCount}</span>
              )}
            </span>
            <div style={{ display: 'flex', gap: 4 }}>
              {unreadCount > 0 && (
                <button
                  onClick={markAllRead}
                  disabled={loading}
                  className="btn btn-ghost btn-sm"
                  style={{ fontSize: 11, gap: 4, padding: '4px 8px' }}
                >
                  <CheckCheck size={13} /> {t('notifications.markAllRead')}
                </button>
              )}
              {notifications.length > 0 && (
                <button
                  onClick={clearAll}
                  disabled={loading}
                  className="btn btn-ghost btn-icon"
                  style={{ width: 28, height: 28, color: 'var(--muted)' }}
                  title={t('notifications.clearAll')}
                >
                  <Trash2 size={14} />
                </button>
              )}
              <button
                onClick={() => setOpen(false)}
                className="btn btn-ghost btn-icon"
                style={{ width: 28, height: 28 }}
              >
                <X size={14} />
              </button>
            </div>
          </div>

          {/* Push opt-in (only when supported & not yet enabled) */}
          <PushOptInBanner />

          {/* Notifications List */}
          <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
            {notifications.length === 0 && (
              <div style={{
                textAlign: 'center', padding: '40px 20px',
                color: 'var(--muted)', fontSize: 13,
              }}>
                <Bell size={28} style={{ margin: '0 auto 10px', opacity: 0.3 }} />
                <div>{t('notifications.empty')}</div>
              </div>
            )}
            {notifications.map(notif => {
              const Icon = TYPE_ICONS[notif.type] || Bell;
              const color = TYPE_COLORS[notif.type] || 'var(--accent)';

              return (
                <div
                  key={notif.id}
                  onClick={() => handleClick(notif)}
                  style={{
                    display: 'flex', gap: 12, padding: '12px 16px',
                    cursor: notif.link ? 'pointer' : 'default',
                    background: notif.read ? 'transparent' : 'rgba(59,130,246,.04)',
                    borderBottom: '1px solid var(--hover)',
                    transition: 'background .1s',
                  }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--hover)')}
                  onMouseLeave={e => (e.currentTarget.style.background = notif.read ? 'transparent' : 'rgba(59,130,246,.04)')}
                >
                  {/* Icon */}
                  <div style={{
                    width: 34, height: 34, borderRadius: 10, flexShrink: 0,
                    background: `${color}18`, display: 'flex',
                    alignItems: 'center', justifyContent: 'center',
                  }}>
                    <Icon size={16} style={{ color }} />
                  </div>

                  {/* Content */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 13, fontWeight: notif.read ? 500 : 600,
                      color: 'var(--text)', marginBottom: 2,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {notif.title}
                    </div>
                    {notif.body && (
                      <div style={{
                        fontSize: 12, color: 'var(--muted)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        lineHeight: 1.4,
                      }}>
                        {notif.body}
                      </div>
                    )}
                    <div style={{ fontSize: 10.5, color: 'var(--muted-2)', marginTop: 3 }}>
                      {timeAgo(notif.createdAt, t, locale)}
                    </div>
                  </div>

                  {/* Unread dot */}
                  {!notif.read && (
                    <div style={{
                      width: 8, height: 8, borderRadius: '50%',
                      background: 'var(--accent)', flexShrink: 0, marginTop: 4,
                    }} />
                  )}

                  {/* Delete */}
                  <button
                    onClick={(e) => deleteNotif(e, notif)}
                    className="btn btn-ghost btn-icon"
                    title={t('common.delete')}
                    style={{ width: 24, height: 24, flexShrink: 0, color: 'var(--muted-2)', alignSelf: 'center' }}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
