'use client';

import { useEffect, useState, useRef, type CSSProperties } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { createPortal } from 'react-dom';
import { Database as DbIcon, Plus, Table2, MoreHorizontal, Pencil, Trash2, Share2, Lock } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { Spinner } from '@/components/ui/spinner';
import { ShareModal } from './components/ShareModal';
import { CHOICE_COLORS, type BaseSummary } from './lib/types';

const ACCENTS = ['var(--accent)', 'var(--success)', '#a855f7', 'var(--warn)', 'var(--pink)', 'var(--teal)', '#6366f1', '#f97316'];
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const accentOf = (b: BaseSummary, i: number) => b.color || ACCENTS[i % ACCENTS.length];

export default function DatabaseHome() {
  const t = useTranslations('database');
  const tc = useTranslations('common');
  const router = useRouter();
  const [bases, setBases] = useState<BaseSummary[] | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [renameTarget, setRenameTarget] = useState<BaseSummary | null>(null);
  const [renameVal, setRenameVal] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<BaseSummary | null>(null);
  const [shareId, setShareId] = useState<string | null>(null);
  const [createErr, setCreateErr] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/bases').then((r) => (r.ok ? r.json() : [])).then(setBases).catch(() => setBases([]));
  }, []);

  const patch = (id: string, body: Record<string, unknown>) =>
    fetch(`/api/bases/${id}`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(body) });

  async function create() {
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    setCreateErr(null);
    const res = await fetch('/api/bases', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ name: n }) });
    setBusy(false);
    if (res.ok) {
      const b = await res.json();
      setCreateOpen(false);
      setName('');
      router.push(`/database/${b.id}`);
    } else {
      setCreateErr(t('actionFailed'));
    }
  }

  async function doRename() {
    if (!renameTarget || !renameVal.trim()) return;
    const id = renameTarget.id;
    const nm = renameVal.trim();
    setBases((bs) => bs && bs.map((b) => (b.id === id ? { ...b, name: nm } : b)));
    setRenameTarget(null);
    await patch(id, { name: nm });
  }

  async function recolor(b: BaseSummary, color: string) {
    setBases((bs) => bs && bs.map((x) => (x.id === b.id ? { ...x, color } : x)));
    await patch(b.id, { color });
  }

  async function doDelete() {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    setBases((bs) => bs && bs.filter((b) => b.id !== id));
    setDeleteTarget(null);
    await fetch(`/api/bases/${id}`, { method: 'DELETE' });
  }

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', width: '100%' }}>
      <div style={{ maxWidth: 1500, margin: '0 auto', padding: '30px clamp(20px, 5vw, 56px) 60px' }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 16, marginBottom: 28 }}>
        <div>
          <div className="mono" style={{ fontSize: 11, letterSpacing: '.16em', textTransform: 'uppercase', color: 'var(--accent)', marginBottom: 9 }}>
            Garely · {t('title')}
          </div>
          <h1 style={{ fontSize: 32, fontWeight: 700, margin: 0, letterSpacing: '-0.02em', lineHeight: 1.05 }}>{t('title')}</h1>
          <div style={{ color: 'var(--muted)', fontSize: 14, marginTop: 7 }}>{t('subtitle')}</div>
        </div>
        <button className="btn btn-primary" onClick={() => setCreateOpen(true)} style={{ fontWeight: 600, flexShrink: 0 }}>
          <Plus size={16} /> {t('newBase')}
        </button>
      </div>

      {bases === null ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}><Spinner size={22} /></div>
      ) : (
        <div className="db-bento">
          {bases.map((b, i) => (
            <BaseCard
              key={b.id}
              base={b}
              accent={accentOf(b, i)}
              index={i}
              onOpen={() => router.push(`/database/${b.id}`)}
              onRename={() => { setRenameTarget(b); setRenameVal(b.name); }}
              onRecolor={(c) => recolor(b, c)}
              onShare={() => setShareId(b.id)}
              onDelete={() => setDeleteTarget(b)}
            />
          ))}
          <GhostCard index={bases.length} label={bases.length === 0 ? t('createBase') : t('newBase')} onClick={() => setCreateOpen(true)} />
        </div>
      )}

      <Modal open={createOpen} onClose={() => { setCreateOpen(false); setCreateErr(null); }} title={t('createBase')} width={420}>
        <label className="field-label">{t('baseName')}</label>
        <input className="field" autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && create()} placeholder={t('baseNamePlaceholder')} style={{ width: '100%', marginBottom: createErr ? 8 : 18 }} />
        {createErr && <div style={{ color: 'var(--danger)', fontSize: 12.5, marginBottom: 14 }}>{createErr}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn btn-ghost" onClick={() => setCreateOpen(false)}>{tc('cancel')}</button>
          <button className="btn btn-primary" onClick={create} disabled={!name.trim() || busy}>{busy ? <Spinner size={15} /> : t('createBase')}</button>
        </div>
      </Modal>

      <Modal open={!!renameTarget} onClose={() => setRenameTarget(null)} title={t('renameBaseTitle')} width={420}>
        <input className="field" autoFocus value={renameVal} onChange={(e) => setRenameVal(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && doRename()} style={{ width: '100%', marginBottom: 18 }} />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn btn-ghost" onClick={() => setRenameTarget(null)}>{tc('cancel')}</button>
          <button className="btn btn-primary" onClick={doRename} disabled={!renameVal.trim()}>{tc('save')}</button>
        </div>
      </Modal>

      <Modal open={!!deleteTarget} onClose={() => setDeleteTarget(null)} title={t('deleteBase')} width={420}>
        <p style={{ margin: '0 0 18px', color: 'var(--text-2)', fontSize: 14, lineHeight: 1.5 }}>{t('confirmDeleteBase')}</p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn btn-ghost" onClick={() => setDeleteTarget(null)}>{tc('cancel')}</button>
          <button className="btn" onClick={doDelete} style={{ background: 'var(--danger)', color: 'var(--on-accent)', fontWeight: 600 }}>{t('deleteBase')}</button>
        </div>
      </Modal>

      {shareId && <ShareModal open={!!shareId} baseId={shareId} onClose={() => setShareId(null)} />}
      </div>
    </div>
  );
}

const chipStyle: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', maxWidth: '100%', padding: '2px 9px', borderRadius: 7,
  background: 'var(--surface-2)', border: '1px solid var(--border)', fontSize: 11.5, color: 'var(--text-2)',
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};

function BaseCard({
  base, accent, index, onOpen, onRename, onRecolor, onShare, onDelete,
}: {
  base: BaseSummary; accent: string; index: number;
  onOpen: () => void; onRename: () => void; onRecolor: (c: string) => void; onShare: () => void; onDelete: () => void;
}) {
  const t = useTranslations('database');
  const [hover, setHover] = useState(false);
  const [menu, setMenu] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(false);
    window.addEventListener('scroll', close, true);
    document.addEventListener('mousedown', close);
    return () => { window.removeEventListener('scroll', close, true); document.removeEventListener('mousedown', close); };
  }, [menu]);

  const previews = (base.tables ?? []).slice(0, 4);
  const more = base.tableCount - previews.length;

  return (
    <div
      onClick={onOpen}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        position: 'relative', cursor: 'pointer', borderRadius: 14, background: 'var(--surface)', overflow: 'hidden',
        border: `1px solid ${hover ? 'var(--border-2, var(--border))' : 'var(--border)'}`,
        minHeight: 162, display: 'flex',
        transform: hover ? 'translateY(-2px)' : 'none', boxShadow: hover ? '0 14px 36px -16px var(--overlay)' : 'none',
        transition: 'transform .14s, border-color .14s, box-shadow .14s', animation: 'fadeIn .35s ease both', animationDelay: `${index * 45}ms`,
      }}
    >
      <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 4, background: accent }} />
      <div style={{ padding: '16px 16px 14px 22px', display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <div style={{ width: 42, height: 42, borderRadius: 12, background: `color-mix(in oklab, ${accent} 22%, transparent)`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Table2 size={21} style={{ color: accent }} />
          </div>
          <button
            ref={btnRef}
            aria-label={t('menu')}
            className="btn btn-ghost btn-icon"
            style={{ width: 30, height: 30, opacity: hover || menu ? 1 : 0, transition: 'opacity .12s' }}
            onClick={(e) => { e.stopPropagation(); const r = btnRef.current!.getBoundingClientRect(); setPos({ left: r.right - 196, top: r.bottom }); setMenu((m) => !m); }}
          >
            <MoreHorizontal size={16} />
          </button>
        </div>

        <div style={{ fontSize: 16, fontWeight: 600, marginTop: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{base.name}</div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 11, flex: 1, alignContent: 'flex-start' }}>
          {previews.length === 0 ? (
            <span style={{ fontSize: 12, color: 'var(--muted-2, var(--muted))' }}>—</span>
          ) : (
            previews.map((n, i) => (
              <span key={i} style={chipStyle}><Table2 size={10} style={{ marginRight: 5, opacity: 0.6 }} />{n || t('untitled')}</span>
            ))
          )}
          {more > 0 && <span style={{ ...chipStyle, color: 'var(--muted)' }}>+{more}</span>}
        </div>

        <div className="mono" style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 11.5, color: 'var(--muted)', marginTop: 12 }}>
          <span>{t('tableCount', { count: base.tableCount })}</span>
          {base.visibility === 'restricted' && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}><Lock size={11} /> {t('accessRestrictedShort')}</span>
          )}
        </div>
      </div>

      {menu && pos && typeof document !== 'undefined' &&
        createPortal(
          <div
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            style={{ position: 'fixed', left: Math.max(pos.left, 8), top: pos.top + 4, width: 196, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 12, boxShadow: '0 14px 44px var(--overlay)', padding: 6, zIndex: 2000 }}
          >
            <MenuRow icon={<Pencil size={14} />} label={t('rename')} onClick={() => { setMenu(false); onRename(); }} />
            <MenuRow icon={<Share2 size={14} />} label={t('share')} onClick={() => { setMenu(false); onShare(); }} />
            <div style={{ display: 'flex', gap: 5, padding: '8px 10px 6px', flexWrap: 'wrap' }}>
              {CHOICE_COLORS.slice(0, 8).map((c) => (
                <button key={c} onClick={() => onRecolor(c)} title={t('recolor')} style={{ width: 18, height: 18, borderRadius: 5, background: c, border: base.color === c ? '2px solid var(--text)' : '1px solid var(--hover-2)', cursor: 'pointer' }} />
              ))}
            </div>
            <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />
            <MenuRow icon={<Trash2 size={14} />} label={t('deleteBase')} danger onClick={() => { setMenu(false); onDelete(); }} />
          </div>,
          document.body,
        )}
    </div>
  );
}

function GhostCard({ onClick, index, label }: { onClick: () => void; index: number; label: string }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        minHeight: 162, borderRadius: 14, cursor: 'pointer',
        border: `1.5px dashed ${hover ? 'var(--accent)' : 'var(--border)'}`,
        background: hover ? 'color-mix(in oklab, var(--accent) 7%, transparent)' : 'transparent',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10,
        color: hover ? 'var(--accent)' : 'var(--muted)', transition: 'border-color .14s, background .14s, color .14s',
        animation: 'fadeIn .35s ease both', animationDelay: `${index * 45}ms`,
      }}
    >
      <Plus size={24} />
      <span style={{ fontWeight: 600, fontSize: 14 }}>{label}</span>
    </button>
  );
}

function MenuRow({ icon, label, onClick, danger }: { icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      style={{ display: 'flex', alignItems: 'center', gap: 9, width: '100%', padding: '8px 10px', border: 'none', borderRadius: 8, background: 'transparent', color: danger ? 'var(--danger)' : 'var(--text)', cursor: 'pointer', fontSize: 13, textAlign: 'left' }}
      onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--surface-2)')}
      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
    >
      {icon} {label}
    </button>
  );
}
