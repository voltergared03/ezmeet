'use client';

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import Link from 'next/link';
import { useTranslations, useLocale } from 'next-intl';
import {
  Gavel, Search, X, ArrowUpRight, AlertCircle, RotateCw, Sparkles,
  User, ChevronDown, Pencil, Trash2, Check, ChevronsDownUp, ChevronsUpDown, Loader2,
} from 'lucide-react';
import { Avatar } from '@/components/ui/avatar';
import { Select } from '@/components/ui/select';
import { fmtDateLong } from '@/lib/utils';
import { useWorkspaceTz } from '@/hooks/use-workspace-tz';

interface UserLite { id: string; name: string | null; image: string | null; }
interface DecisionMeeting { id: string; title: string; scheduledAt: string | null; }
interface Decision {
  id: string;
  text: string;
  date: string | null;
  ownerId: string | null;
  owner: UserLite | null;
  meetingId: string | null;
  reportId: string | null;
  source: string;
  meeting: DecisionMeeting | null;
  canEdit: boolean;
  createdAt: string;
}
interface Member { id: string; name: string | null; email?: string | null; image: string | null; }

const ALL = 'all';
const NONE = '__none__';

const STYLES = `
@keyframes dec-fadeUp { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
@keyframes dec-shimmer { 0% { background-position: -260px 0; } 100% { background-position: 260px 0; } }
.dec-reveal { opacity: 0; animation: dec-fadeUp .5s cubic-bezier(.16,1,.3,1) forwards; }
.dec-card { transition: border-color .15s ease, box-shadow .15s ease; }
.dec-head { transition: background .15s ease; cursor: pointer; }
.dec-head:hover { background: var(--surface-2); }
.dec-item { transition: background .12s ease; }
.dec-item:hover { background: color-mix(in oklab, var(--surface-2) 55%, transparent); }
.dec-item .dec-actions { opacity: .5; transition: opacity .12s ease; }
.dec-item:hover .dec-actions, .dec-item:focus-within .dec-actions { opacity: 1; }
/* touch devices have no hover — keep the edit/delete affordances visible */
@media (hover: none) { .dec-item .dec-actions { opacity: .9; } }
.dec-iconbtn { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: 7px; border: 1px solid transparent; background: transparent; color: var(--muted); cursor: pointer; transition: all .12s ease; }
.dec-iconbtn:hover { background: var(--surface); border-color: var(--border); color: var(--text); }
.dec-iconbtn.danger:hover { color: var(--danger-fg); border-color: color-mix(in oklab, var(--danger-fg) 40%, transparent); }
.dec-report-link { transition: color .15s ease; }
.dec-report-link:hover { color: var(--accent) !important; }
.dec-skel { background: linear-gradient(90deg, var(--surface) 25%, var(--surface-2) 37%, var(--surface) 63%); background-size: 460px 100%; animation: dec-shimmer 1.5s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { .dec-reveal { animation: none; opacity: 1; } .dec-skel { animation: none; } }
`;

type Group = { meeting: DecisionMeeting | null; items: Decision[] };

export default function DecisionsPage() {
  const t = useTranslations('decisions');
  const locale = useLocale();
  const tz = useWorkspaceTz();

  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [query, setQuery] = useState('');
  const [meetingFilter, setMeetingFilter] = useState<string>(ALL);
  const [ownerFilter, setOwnerFilter] = useState<string>(ALL);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const seeded = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const [dRes, mRes] = await Promise.all([fetch('/api/decisions'), fetch('/api/users')]);
      if (!dRes.ok) throw new Error(String(dRes.status));
      setDecisions(await dRes.json());
      if (mRes.ok) setMembers(await mRes.json());
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Seed: open the most-recent meeting once, on first load.
  useEffect(() => {
    if (seeded.current || !decisions.length) return;
    seeded.current = true;
    const firstMid = decisions.find((d) => d.meeting)?.meeting?.id;
    if (firstMid) setExpanded(new Set([firstMid]));
  }, [decisions]);

  const memberById = useMemo(() => new Map(members.map((m) => [m.id, m])), [members]);
  const memberOptions = useMemo(
    () => [{ value: '', label: t('noOwner') }, ...members.map((m) => ({ value: m.id, label: m.name || m.email || m.id }))],
    [members, t],
  );

  const meetingOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const d of decisions) if (d.meeting) seen.set(d.meeting.id, d.meeting.title || t('untitledMeeting'));
    return [{ value: ALL, label: t('filterAllMeetings') }, ...[...seen].map(([value, label]) => ({ value, label }))];
  }, [decisions, t]);

  const ownerOptions = useMemo(() => {
    const seen = new Map<string, string>();
    let hasNone = false;
    for (const d of decisions) {
      if (d.owner) seen.set(d.owner.id, d.owner.name || t('unknownOwner'));
      else hasNone = true;
    }
    const opts = [{ value: ALL, label: t('filterAllOwners') }, ...[...seen].map(([value, label]) => ({ value, label }))];
    if (hasNone) opts.push({ value: 'none', label: t('noOwner') });
    return opts;
  }, [decisions, t]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return decisions.filter((d) => {
      if (meetingFilter !== ALL && d.meeting?.id !== meetingFilter) return false;
      if (ownerFilter === 'none' ? !!d.ownerId : ownerFilter !== ALL && d.ownerId !== ownerFilter) return false;
      if (q && !d.text.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [decisions, meetingFilter, ownerFilter, query]);

  const groups = useMemo<Group[]>(() => {
    const map = new Map<string, Group>();
    for (const d of filtered) {
      const key = d.meeting?.id ?? NONE;
      let g = map.get(key);
      if (!g) { g = { meeting: d.meeting, items: [] }; map.set(key, g); }
      g.items.push(d);
    }
    return [...map.values()];
  }, [filtered]);

  const meetingCount = useMemo(() => new Set(decisions.map((d) => d.meeting?.id).filter(Boolean)).size, [decisions]);
  const filtersActive = query.trim() !== '' || meetingFilter !== ALL || ownerFilter !== ALL;
  const groupKey = (g: Group) => g.meeting?.id ?? NONE;
  const isOpen = (g: Group) => filtersActive || expanded.has(groupKey(g));
  const allOpen = groups.length > 0 && groups.every((g) => expanded.has(groupKey(g)));
  const hasFilters = filtersActive;

  const toggle = (key: string) => setExpanded((prev) => {
    const next = new Set(prev);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });
  const toggleAll = () => setExpanded(allOpen ? new Set() : new Set(groups.map(groupKey)));
  const clearAll = () => { setQuery(''); setMeetingFilter(ALL); setOwnerFilter(ALL); };

  // ── mutations ──────────────────────────────────────────
  const applyUpdate = useCallback((u: { id: string; text: string; ownerId: string | null }) => {
    setDecisions((prev) => prev.map((d) => {
      if (d.id !== u.id) return d;
      const m = u.ownerId ? memberById.get(u.ownerId) : null;
      return { ...d, text: u.text, ownerId: u.ownerId, owner: m ? { id: m.id, name: m.name, image: m.image } : null };
    }));
  }, [memberById]);
  const removeDecision = useCallback((id: string) => setDecisions((prev) => prev.filter((d) => d.id !== id)), []);

  return (
    <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
      <div className="page-container" style={{ maxWidth: 880, margin: '0 auto' }}>
        <style>{STYLES}</style>

        {/* ── Masthead ───────────────────────────────────── */}
        <header style={{ position: 'relative', marginBottom: 18 }}>
          <div aria-hidden style={{ position: 'absolute', top: -36, left: -20, width: 320, height: 170, background: 'radial-gradient(60% 60% at 20% 30%, color-mix(in oklab, var(--accent) 20%, transparent), transparent 70%)', filter: 'blur(8px)', pointerEvents: 'none', zIndex: 0 }} />
          <div style={{ position: 'relative', zIndex: 1 }}>
            <div className="mono" style={{ fontSize: 11, letterSpacing: '0.22em', textTransform: 'uppercase', color: 'var(--accent)', fontWeight: 600, marginBottom: 10 }}>{t('kicker')}</div>
            <h1 style={{ fontSize: 32, lineHeight: 1.05, fontWeight: 700, letterSpacing: '-0.02em', margin: 0, display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ width: 38, height: 38, borderRadius: 11, flexShrink: 0, background: 'linear-gradient(145deg, color-mix(in oklab, var(--accent) 26%, transparent), color-mix(in oklab, var(--accent) 8%, transparent))', border: '1px solid color-mix(in oklab, var(--accent) 30%, transparent)', color: 'var(--accent)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
                <Gavel size={20} />
              </span>
              {t('pageTitle')}
            </h1>
            <p style={{ color: 'var(--text-2)', fontSize: 14.5, lineHeight: 1.5, margin: '11px 0 0', maxWidth: 540 }}>{t('subtitle')}</p>
            {!loading && !error && decisions.length > 0 && (
              <div className="mono" style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14, fontSize: 12.5, color: 'var(--muted)' }}>
                <span style={{ color: 'var(--text-2)' }}>{t('count', { count: decisions.length })}</span>
                <span style={{ opacity: 0.4 }}>/</span>
                <span>{t('statMeetings', { count: meetingCount })}</span>
              </div>
            )}
          </div>
        </header>

        {/* ── Sticky filter bar ──────────────────────────── */}
        <div style={{ position: 'sticky', top: 0, zIndex: 6, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '12px 0', marginBottom: 12, background: 'linear-gradient(var(--bg) 80%, transparent)', backdropFilter: 'blur(6px)' }}>
          <div className="field" style={{ flex: 1, minWidth: 190, display: 'flex', alignItems: 'center', gap: 8, position: 'relative' }}>
            <Search size={15} style={{ color: 'var(--muted)', flexShrink: 0 }} />
            <input type="text" value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('searchPlaceholder')} style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: 'var(--text)', fontSize: 14, minWidth: 0 }} />
            {query && <button onClick={() => setQuery('')} aria-label={t('clear')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted)', padding: 4, display: 'flex', borderRadius: 6 }}><X size={14} /></button>}
          </div>
          <Select value={meetingFilter} onChange={setMeetingFilter} options={meetingOptions} icon={<Gavel size={13} style={{ color: 'var(--muted)' }} />} style={{ minWidth: 150 }} />
          <Select value={ownerFilter} onChange={setOwnerFilter} options={ownerOptions} icon={<User size={13} style={{ color: 'var(--muted)' }} />} style={{ minWidth: 140 }} />
          {!filtersActive && groups.length > 1 && (
            <button onClick={toggleAll} className="dec-iconbtn" style={{ width: 'auto', padding: '0 10px', height: 36, gap: 6, fontSize: 13 }} title={allOpen ? t('collapseAll') : t('expandAll')}>
              {allOpen ? <ChevronsDownUp size={15} /> : <ChevronsUpDown size={15} />}
              <span style={{ fontSize: 12.5 }}>{allOpen ? t('collapseAll') : t('expandAll')}</span>
            </button>
          )}
        </div>

        {/* ── Loading ────────────────────────────────────── */}
        {loading && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {[0, 1, 2].map((i) => <div key={i} className="dec-skel" style={{ height: 64, borderRadius: 14, opacity: 1 - i * 0.18 }} />)}
          </div>
        )}

        {/* ── Error ──────────────────────────────────────── */}
        {!loading && error && (
          <div style={{ textAlign: 'center', padding: '60px 20px', color: 'var(--muted)' }}>
            <AlertCircle size={40} style={{ opacity: 0.4 }} />
            <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)', marginTop: 14 }}>{t('loadError')}</div>
            <button className="btn" style={{ marginTop: 16 }} onClick={() => void load()}><RotateCw size={14} /> {t('retry')}</button>
          </div>
        )}

        {/* ── Empty ──────────────────────────────────────── */}
        {!loading && !error && filtered.length === 0 && (
          <div style={{ textAlign: 'center', padding: '64px 20px' }}>
            <div style={{ width: 64, height: 64, borderRadius: 18, margin: '0 auto', background: 'color-mix(in oklab, var(--accent) 10%, transparent)', border: '1px solid color-mix(in oklab, var(--accent) 22%, transparent)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--accent)' }}>
              <Gavel size={28} />
            </div>
            <div style={{ fontSize: 17, fontWeight: 600, marginTop: 18 }}>{hasFilters ? t('emptyFilteredTitle') : t('emptyTitle')}</div>
            <div style={{ color: 'var(--muted)', fontSize: 14, lineHeight: 1.55, maxWidth: 400, margin: '10px auto 0' }}>{hasFilters ? t('emptyFilteredDesc') : t('emptyDesc')}</div>
            {hasFilters && <button className="btn" style={{ marginTop: 18 }} onClick={clearAll}><X size={14} /> {t('clearFilters')}</button>}
          </div>
        )}

        {/* ── Accordion of meeting cards ─────────────────── */}
        {!loading && !error && filtered.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {groups.map((g, gi) => (
              <MeetingCard
                key={groupKey(g)}
                group={g}
                open={isOpen(g)}
                onToggle={() => toggle(groupKey(g))}
                reveal={!filtersActive && gi < 12}
                revealDelay={gi * 45}
                members={members}
                memberOptions={memberOptions}
                memberById={memberById}
                locale={locale}
                tz={tz}
                t={t}
                onUpdated={applyUpdate}
                onDeleted={removeDecision}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Meeting card (collapsible) ─────────────────────────── */
function MeetingCard({
  group, open, onToggle, reveal, revealDelay, members, memberOptions, memberById, locale, tz, t, onUpdated, onDeleted,
}: {
  group: Group; open: boolean; onToggle: () => void; reveal: boolean; revealDelay: number;
  members: Member[]; memberOptions: { value: string; label: string }[]; memberById: Map<string, Member>;
  locale: string; tz: string; t: ReturnType<typeof useTranslations>;
  onUpdated: (u: { id: string; text: string; ownerId: string | null }) => void;
  onDeleted: (id: string) => void;
}) {
  const m = group.meeting;
  const date = m?.scheduledAt ?? group.items[0]?.date ?? null;
  return (
    <div className={`dec-card ${reveal ? 'dec-reveal' : ''}`} style={{ animationDelay: reveal ? `${revealDelay}ms` : undefined, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 14, overflow: 'hidden' }}>
      {/* header (toggles) */}
      <div className="dec-head" role="button" tabIndex={0} aria-expanded={open} onClick={onToggle}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } }}
        style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '13px 14px' }}>
        <span style={{ width: 30, height: 30, borderRadius: 9, flexShrink: 0, display: 'grid', placeItems: 'center', background: 'color-mix(in oklab, var(--accent) 14%, transparent)', color: 'var(--accent)' }}>
          <Gavel size={15} />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14.5, fontWeight: 600, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {m ? (m.title || t('untitledMeeting')) : t('untitledMeeting')}
          </div>
          <div className="mono" style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>
            {date ? fmtDateLong(new Date(date), locale, tz) : ''}{date ? ' · ' : ''}{t('count', { count: group.items.length })}
          </div>
        </div>
        {m && (
          <Link href={`/meetings/${m.id}/report`} className="dec-report-link" onClick={(e) => e.stopPropagation()} title={t('openReport')}
            style={{ color: 'var(--muted)', display: 'inline-flex', padding: 4, borderRadius: 7 }}>
            <ArrowUpRight size={17} />
          </Link>
        )}
        <ChevronDown size={18} style={{ color: 'var(--muted)', flexShrink: 0, transition: 'transform .18s ease', transform: open ? 'rotate(180deg)' : 'none' }} />
      </div>

      {/* body */}
      {open && (
        <div style={{ borderTop: '1px solid var(--border)' }}>
          {group.items.map((d, i) => (
            <DecisionItem
              key={d.id}
              d={d}
              last={i === group.items.length - 1}
              members={members}
              memberOptions={memberOptions}
              memberById={memberById}
              t={t}
              onUpdated={onUpdated}
              onDeleted={onDeleted}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── A single decision (view / edit / delete) ──────────── */
function DecisionItem({
  d, last, members, memberOptions, memberById, t, onUpdated, onDeleted,
}: {
  d: Decision; last: boolean;
  members: Member[]; memberOptions: { value: string; label: string }[]; memberById: Map<string, Member>;
  t: ReturnType<typeof useTranslations>;
  onUpdated: (u: { id: string; text: string; ownerId: string | null }) => void;
  onDeleted: (id: string) => void;
}) {
  const [mode, setMode] = useState<'view' | 'edit' | 'confirm'>('view');
  const [text, setText] = useState(d.text);
  const [ownerId, setOwnerId] = useState(d.ownerId ?? '');
  const [busy, setBusy] = useState(false);

  const startEdit = () => { setText(d.text); setOwnerId(d.ownerId ?? ''); setMode('edit'); };

  const save = async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/decisions/${d.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: trimmed, ownerId: ownerId || null }),
      });
      if (res.ok) { onUpdated(await res.json()); setMode('view'); }
    } finally { setBusy(false); }
  };

  const doDelete = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/decisions/${d.id}`, { method: 'DELETE' });
      if (res.ok) onDeleted(d.id);
    } finally { setBusy(false); }
  };

  const owner = d.ownerId ? memberById.get(d.ownerId) ?? d.owner : null;
  const cellPad = '12px 14px';

  if (mode === 'edit') {
    return (
      <div style={{ padding: cellPad, borderBottom: last ? 'none' : '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 10 }}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          autoFocus
          className="field"
          style={{ width: '100%', resize: 'vertical', fontSize: 14, lineHeight: 1.5, fontFamily: 'inherit' }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <Select value={ownerId} onChange={setOwnerId} options={memberOptions} placeholder={t('setOwner')} icon={<User size={13} style={{ color: 'var(--muted)' }} />} style={{ minWidth: 200 }} />
          <div style={{ flex: 1 }} />
          <button className="btn btn-ghost" onClick={() => setMode('view')} disabled={busy}>{t('cancel')}</button>
          <button className="btn btn-primary" onClick={save} disabled={busy || !text.trim()}>
            {busy ? <Loader2 size={14} className="spin" /> : <Check size={14} />} {t('save')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="dec-item" style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: cellPad, borderBottom: last ? 'none' : '1px solid var(--border)' }}>
      <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--accent)', flexShrink: 0, marginTop: 7, opacity: 0.8 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.5, color: 'var(--text)', whiteSpace: 'pre-wrap' }}>{d.text}</p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginTop: 8 }}>
          {owner ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: 'var(--text-2)' }}>
              <Avatar name={owner.name || ''} image={owner.image} size="sm" />
              <span style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{owner.name || t('unknownOwner')}</span>
            </span>
          ) : (
            <span style={{ fontSize: 12.5, color: 'var(--muted)', fontStyle: 'italic' }}>{t('noOwner')}</span>
          )}
          {d.source === 'ai' && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontWeight: 600, letterSpacing: '0.04em', color: 'var(--accent)', padding: '2px 7px', borderRadius: 999, background: 'color-mix(in oklab, var(--accent) 12%, transparent)', border: '1px solid color-mix(in oklab, var(--accent) 22%, transparent)' }}>
              <Sparkles size={10} /> {t('aiBadge')}
            </span>
          )}
        </div>

        {mode === 'confirm' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, padding: '8px 12px', borderRadius: 9, background: 'color-mix(in oklab, var(--danger-fg) 9%, transparent)', border: '1px solid color-mix(in oklab, var(--danger-fg) 30%, transparent)' }}>
            <span style={{ fontSize: 12.5, color: 'var(--text)', flex: 1 }}>{t('confirmDelete')}</span>
            <button className="btn btn-ghost" onClick={() => setMode('view')} disabled={busy} style={{ height: 30, padding: '0 12px' }}>{t('cancel')}</button>
            <button className="btn" onClick={doDelete} disabled={busy} style={{ height: 30, padding: '0 12px', background: '#dc2626', borderColor: '#dc2626', color: 'var(--on-accent)' }}>
              {busy ? <Loader2 size={13} className="spin" /> : <Trash2 size={13} />} {t('delete')}
            </button>
          </div>
        )}
      </div>

      {d.canEdit && mode === 'view' && (
        <div className="dec-actions" style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
          <button className="dec-iconbtn" onClick={startEdit} aria-label={t('edit')} title={t('edit')}><Pencil size={14} /></button>
          <button className="dec-iconbtn danger" onClick={() => setMode('confirm')} aria-label={t('delete')} title={t('delete')}><Trash2 size={14} /></button>
        </div>
      )}
    </div>
  );
}
