'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

/* ══════════════════════════════════════════════════════════
   ROOM CONTENT — rendered inside <LiveKitRoom>
   ══════════════════════════════════════════════════════════ */
export function AdmissionPanel({ meetingId }: { meetingId: string }) {
  const t = useTranslations();
  const [pending, setPending] = useState<{ id: string; guestName: string }[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(`/api/meetings/${meetingId}/admit`);
        if (res.ok) { const d = await res.json(); if (!cancelled) setPending(d.pending || []); }
      } catch { /* ignore */ }
    };
    poll();
    const iv = setInterval(poll, 4000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [meetingId]);

  const decide = async (rid: string, action: 'approve' | 'deny') => {
    setBusy(rid);
    try {
      await fetch(`/api/meetings/${meetingId}/admit`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: rid, action }),
      });
      setPending((p) => p.filter((x) => x.id !== rid));
    } catch { /* ignore */ } finally { setBusy(null); }
  };

  if (pending.length === 0) return null;
  return (
    <div style={{ position: 'absolute', top: 70, left: '50%', transform: 'translateX(-50%)', zIndex: 60, display: 'flex', flexDirection: 'column', gap: 8, width: 360, maxWidth: '90vw' }}>
      {pending.map((p) => (
        <div key={p.id} style={{ background: 'rgba(20,22,28,.97)', border: '1px solid var(--hover-2)', borderRadius: 12, padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10, boxShadow: '0 12px 40px var(--overlay)' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,.55)' }}>{t('room.guestWantsToJoin')}</div>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--on-accent)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.guestName}</div>
          </div>
          <button onClick={() => decide(p.id, 'deny')} disabled={busy === p.id} style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid rgba(255,255,255,.15)', background: 'transparent', color: 'rgba(255,255,255,.7)', cursor: 'pointer', fontSize: 13 }}>{t('room.deny')}</button>
          <button onClick={() => decide(p.id, 'approve')} disabled={busy === p.id} style={{ padding: '6px 12px', borderRadius: 8, border: 'none', background: 'var(--accent)', color: 'var(--on-accent)', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>{t('room.admit')}</button>
        </div>
      ))}
    </div>
  );
}
