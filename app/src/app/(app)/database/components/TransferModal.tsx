'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check, ArrowRightLeft } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { Avatar } from '@/components/ui/avatar';
import { Spinner } from '@/components/ui/spinner';
import type { OrgMember } from '../lib/types';

/**
 * Reusable "transfer ownership" picker for a base or a table. Pick another org
 * member, confirm, hand it over. The chosen recipient becomes the new owner;
 * the caller's API keeps the outgoing owner with access (see the transfer routes).
 */
export function TransferModal({
  open,
  title,
  subject,
  members,
  currentOwnerId,
  hint,
  onClose,
  onTransfer,
}: {
  open: boolean;
  title: string;
  subject?: string;
  members: OrgMember[];
  currentOwnerId?: string | null;
  hint: string;
  onClose: () => void;
  onTransfer: (userId: string) => Promise<boolean>;
}) {
  const t = useTranslations('database');
  const tc = useTranslations('common');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);

  useEffect(() => {
    if (open) { setQuery(''); setSelected(null); setBusy(false); setErr(false); }
  }, [open]);

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return members
      .filter((u) => u.id !== currentOwnerId)
      .filter((u) => !q || (u.name || '').toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q));
  }, [members, currentOwnerId, query]);

  async function confirm() {
    if (!selected || busy) return;
    setBusy(true);
    setErr(false);
    const ok = await onTransfer(selected);
    setBusy(false);
    if (ok) onClose();
    else setErr(true);
  }

  return (
    <Modal open={open} onClose={onClose} title={title} width={460}>
      {subject && (
        <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 12 }}>{subject}</div>
      )}
      <input
        className="field"
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t('transferSearch')}
        style={{ width: '100%', marginBottom: 10 }}
      />
      <div style={{ border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden', maxHeight: 260, overflowY: 'auto' }}>
        {candidates.length === 0 ? (
          <div style={{ padding: '18px 12px', fontSize: 13, color: 'var(--muted)', textAlign: 'center' }}>{t('transferNoMembers')}</div>
        ) : (
          candidates.map((u) => {
            const active = selected === u.id;
            return (
              <button
                key={u.id}
                onClick={() => setSelected(u.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, width: '100%', padding: '9px 11px',
                  border: 'none', borderBottom: '1px solid var(--border)', cursor: 'pointer', textAlign: 'left',
                  background: active ? 'color-mix(in oklab, var(--accent) 14%, transparent)' : 'transparent',
                }}
                onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = 'var(--surface-2)'; }}
                onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = 'transparent'; }}
              >
                <Avatar name={u.name || u.email || '?'} image={u.image} size="sm" />
                <span style={{ flex: 1, minWidth: 0, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.name || u.email}</span>
                {active && <Check size={15} style={{ color: 'var(--accent)', flexShrink: 0 }} />}
              </button>
            );
          })
        )}
      </div>
      <p style={{ margin: '12px 2px 0', fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>{hint}</p>
      {err && <div style={{ color: 'var(--red, var(--danger))', fontSize: 12.5, marginTop: 8 }}>{t('actionFailed')}</div>}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
        <button className="btn btn-ghost" onClick={onClose}>{tc('cancel')}</button>
        <button className="btn btn-primary" onClick={confirm} disabled={!selected || busy} style={{ gap: 7 }}>
          {busy ? <Spinner size={15} /> : <ArrowRightLeft size={15} />} {t('transferOwnership')}
        </button>
      </div>
    </Modal>
  );
}
