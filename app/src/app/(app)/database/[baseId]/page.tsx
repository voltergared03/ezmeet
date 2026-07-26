'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ChevronLeft, Plus, Table2, MoreHorizontal, Pencil, Trash2, Share2, Lock, Download, ArrowRightLeft } from 'lucide-react';
import { Modal } from '@/components/ui/modal';
import { Spinner } from '@/components/ui/spinner';
import { useSaveErrorToast } from '@/components/save-toast';
import { GridView } from '../components/GridView';
import { GridToolbar } from '../components/GridToolbar';
import { KanbanView } from '../components/KanbanView';
import { CalendarView } from '../components/CalendarView';
import { ViewTabs } from '../components/ViewTabs';
import { RecordModal } from '../components/RecordModal';
import { ShareModal } from '../components/ShareModal';
import { TransferModal } from '../components/TransferModal';
import { PopMenu, MenuRow } from '../components/Menu';
import { buildCsv, downloadCsv, fetchAllRows } from '../lib/export-csv';
import { CHOICE_COLORS, type BaseDetail, type TableTab, type TableT, type RowT, type OrgMember, type FieldType, type FilterCond, type SortCond, type ViewT, type ViewConfig } from '../lib/types';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

export default function BaseDetailPage() {
  const t = useTranslations('database');
  const tc = useTranslations('common');
  const { showSaveError, saveToast } = useSaveErrorToast();
  const router = useRouter();
  const { baseId } = useParams<{ baseId: string }>();
  const search = useSearchParams();
  const recordParam = search.get('record');
  const tableParam = search.get('table');
  const deepLinkDone = useRef(false);
  const [copied, setCopied] = useState(false);

  const [base, setBase] = useState<BaseDetail | null>(null);
  const [activeTableId, setActiveTableId] = useState<string | null>(null);
  const [table, setTable] = useState<TableT | null>(null);
  const [rows, setRows] = useState<RowT[]>([]);
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [loading, setLoading] = useState(true);

  const [newTableOpen, setNewTableOpen] = useState(false);
  const [newTableName, setNewTableName] = useState('');
  const [tableErr, setTableErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [renameBaseOpen, setRenameBaseOpen] = useState(false);
  const [renameBaseVal, setRenameBaseVal] = useState('');
  const [confirmDelBase, setConfirmDelBase] = useState(false);
  const [renameTableT, setRenameTableT] = useState<TableTab | null>(null);
  const [renameTableVal, setRenameTableVal] = useState('');
  const [delTableT, setDelTableT] = useState<TableTab | null>(null);
  const [transferTableT, setTransferTableT] = useState<TableTab | null>(null);
  const [activeViewId, setActiveViewId] = useState<string | null>(null);
  const [detailRowId, setDetailRowId] = useState<string | null>(null);
  const [renameViewT, setRenameViewT] = useState<ViewT | null>(null);
  const [renameViewVal, setRenameViewVal] = useState('');
  const [delViewT, setDelViewT] = useState<ViewT | null>(null);

  useEffect(() => {
    (async () => {
      const [bRes, mRes] = await Promise.all([fetch(`/api/bases/${baseId}`), fetch('/api/org/members')]);
      if (bRes.ok) {
        const b: BaseDetail = await bRes.json();
        setBase(b);
        // Honor a deep-link ?table= if it points at a real table, else first table.
        const deepTable = tableParam && b.tables.some((x) => x.id === tableParam) ? tableParam : null;
        setActiveTableId(deepTable ?? b.tables[0]?.id ?? null);
      }
      if (mRes.ok) setMembers(await mRes.json());
      setLoading(false);
    })();
  }, [baseId]);

  const reloadRows = useCallback(async (tableId: string, viewId?: string) => {
    const rRes = await fetch(`/api/tables/${tableId}/rows${viewId ? `?view=${viewId}` : ''}`);
    if (rRes.ok) {
      const d = await rRes.json();
      setRows((d.rows as RowT[]).map((r) => ({ ...r, data: r.data || {} })));
    } else setRows([]);
  }, []);

  const loadTable = useCallback(async (tableId: string) => {
    const tRes = await fetch(`/api/tables/${tableId}`);
    if (!tRes.ok) return;
    const tbl: TableT = await tRes.json();
    setTable(tbl);
    const firstView = [...tbl.views].sort((a, b) => a.position - b.position)[0];
    setActiveViewId(firstView?.id ?? null);
    await reloadRows(tableId, firstView?.id);
  }, [reloadRows]);

  useEffect(() => {
    if (activeTableId) { setTable(null); loadTable(activeTableId); }
  }, [activeTableId, loadTable]);

  // Deep link: open ?record= once its row has loaded.
  useEffect(() => {
    if (deepLinkDone.current || !recordParam) return;
    if (rows.some((r) => r.id === recordParam)) { setDetailRowId(recordParam); deepLinkDone.current = true; }
  }, [rows, recordParam]);

  const patchBase = (body: Record<string, unknown>) =>
    fetch(`/api/bases/${baseId}`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(body) });

  const [exporting, setExporting] = useState(false);
  // Export the active table (current view's filtered/sorted rows) to a CSV file.
  async function exportCsv() {
    if (!table || exporting) return;
    setExporting(true);
    try {
      const all = await fetchAllRows(table.id, activeViewId);
      const csv = buildCsv(table, all, members);
      const safe = (table.name || 'table').replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(0, 80);
      downloadCsv(`${safe || 'table'}.csv`, csv);
    } finally {
      setExporting(false);
    }
  }

  async function createTable() {
    const n = newTableName.trim();
    if (!n || busy) return;
    setBusy(true);
    setTableErr(null);
    const res = await fetch(`/api/bases/${baseId}/tables`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ name: n }) });
    setBusy(false);
    if (res.ok) {
      const { table: newT } = await res.json();
      const tab: TableTab = { id: newT.id, name: newT.name, icon: newT.icon, position: newT.position, primaryFieldId: newT.primaryFieldId };
      setBase((b) => (b ? { ...b, tables: [...b.tables, tab] } : b));
      setNewTableOpen(false);
      setNewTableName('');
      setActiveTableId(newT.id);
    } else {
      setTableErr(t('actionFailed'));
    }
  }

  async function renameBase() {
    const nm = renameBaseVal.trim();
    if (!nm) return;
    setBase((b) => (b ? { ...b, name: nm } : b));
    setRenameBaseOpen(false);
    await patchBase({ name: nm });
  }
  async function recolorBase(color: string) {
    setBase((b) => (b ? { ...b, color } : b));
    await patchBase({ color });
  }
  async function deleteBase() {
    await fetch(`/api/bases/${baseId}`, { method: 'DELETE' });
    router.push('/database');
  }

  async function renameTable() {
    if (!renameTableT) return;
    const id = renameTableT.id;
    const nm = renameTableVal.trim();
    if (!nm) return;
    setBase((b) => (b ? { ...b, tables: b.tables.map((x) => (x.id === id ? { ...x, name: nm } : x)) } : b));
    setTable((t0) => (t0 && t0.id === id ? { ...t0, name: nm } : t0));
    setRenameTableT(null);
    await fetch(`/api/tables/${id}`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ name: nm }) });
  }
  async function deleteTable() {
    if (!delTableT) return;
    const id = delTableT.id;
    const remaining = (base?.tables ?? []).filter((x) => x.id !== id);
    setBase((b) => (b ? { ...b, tables: remaining } : b));
    setDelTableT(null);
    if (activeTableId === id) setActiveTableId(remaining[0]?.id ?? null);
    await fetch(`/api/tables/${id}`, { method: 'DELETE' });
  }
  async function transferTable(userId: string): Promise<boolean> {
    if (!transferTableT) return false;
    const id = transferTableT.id;
    const res = await fetch(`/api/tables/${id}/transfer`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ userId }) });
    if (!res.ok) return false;
    setBase((b) => (b ? { ...b, tables: b.tables.map((x) => (x.id === id ? { ...x, createdById: userId } : x)) } : b));
    setTable((t0) => (t0 && t0.id === id ? { ...t0, ownerId: userId } : t0));
    return true;
  }

  // --- grid handlers (unchanged) ---
  async function reloadSchema() {
    if (!activeTableId) return;
    const res = await fetch(`/api/tables/${activeTableId}`);
    if (res.ok) { const tbl: TableT = await res.json(); setTable((t0) => (t0 ? { ...t0, fields: tbl.fields, primaryFieldId: tbl.primaryFieldId } : tbl)); }
  }
  async function addRow(initial?: Record<string, unknown>) {
    if (!activeTableId) return;
    const body = initial && Object.keys(initial).length ? JSON.stringify({ data: initial }) : '{}';
    const res = await fetch(`/api/tables/${activeTableId}/rows`, { method: 'POST', headers: JSON_HEADERS, body });
    if (res.ok) { const row: RowT = await res.json(); setRows((rs) => [...rs, { ...row, data: row.data || {} }]); }
  }
  async function updateCell(rowId: string, fieldId: string, value: unknown) {
    const prev = rows.find((r) => r.id === rowId)?.data;
    setRows((rs) => rs.map((r) => (r.id === rowId ? { ...r, data: { ...r.data, [fieldId]: value } } : r)));
    try {
      const res = await fetch(`/api/rows/${rowId}`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ data: { [fieldId]: value } }) });
      if (res.ok) { const updated = await res.json(); setRows((rs) => rs.map((r) => (r.id === rowId ? { ...r, data: updated.data || {} } : r))); }
      else { setRows((rs) => rs.map((r) => (r.id === rowId ? { ...r, data: prev ?? {} } : r))); showSaveError(tc('saveFailed')); } // server rejected → revert, don't leave a phantom edit
    } catch { setRows((rs) => rs.map((r) => (r.id === rowId ? { ...r, data: prev ?? {} } : r))); showSaveError(tc('saveFailed')); }
  }
  async function addField(name: string, type: FieldType, options?: unknown) {
    if (!activeTableId) return;
    const res = await fetch(`/api/tables/${activeTableId}/fields`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(options === undefined ? { name, type } : { name, type, options }) });
    if (res.ok) { const f = await res.json(); setTable((t0) => (t0 ? { ...t0, fields: [...t0.fields, f] } : t0)); }
  }
  async function editField(fieldId: string, patch: { name: string; type: FieldType; options?: unknown }) {
    setTable((t0) => (t0 ? { ...t0, fields: t0.fields.map((f) => (f.id === fieldId ? { ...f, name: patch.name, type: patch.type } : f)) } : t0));
    const res = await fetch(`/api/fields/${fieldId}`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify(patch) });
    if (res.ok) { const f = await res.json(); setTable((t0) => (t0 ? { ...t0, fields: t0.fields.map((x) => (x.id === fieldId ? f : x)) } : t0)); }
  }
  async function deleteRow(rowId: string) { setRows((rs) => rs.filter((r) => r.id !== rowId)); await fetch(`/api/rows/${rowId}`, { method: 'DELETE' }); }
  async function deleteField(fieldId: string) { setTable((t0) => (t0 ? { ...t0, fields: t0.fields.filter((f) => f.id !== fieldId) } : t0)); await fetch(`/api/fields/${fieldId}`, { method: 'DELETE' }); reloadSchema(); }
  async function setPrimary(fieldId: string) { if (!activeTableId) return; setTable((t0) => (t0 ? { ...t0, primaryFieldId: fieldId } : t0)); await fetch(`/api/tables/${activeTableId}`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ primaryFieldId: fieldId }) }); }
  async function resizeField(fieldId: string, width: number) { setTable((t0) => (t0 ? { ...t0, fields: t0.fields.map((f) => (f.id === fieldId ? { ...f, width } : f)) } : t0)); await fetch(`/api/fields/${fieldId}`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ width }) }); }
  async function reorderFields(orderedIds: string[]) {
    if (!activeTableId) return;
    const rank = new Map(orderedIds.map((id, i) => [id, i]));
    setTable((t0) => (t0 ? { ...t0, fields: t0.fields.map((f) => (rank.has(f.id) ? { ...f, position: rank.get(f.id)! } : f)) } : t0));
    await fetch(`/api/tables/${activeTableId}/fields/reorder`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ order: orderedIds }) });
  }
  async function reorderRows(orderedIds: string[]) {
    if (!activeTableId) return;
    setRows((rs) => { const by = new Map(rs.map((r) => [r.id, r])); return orderedIds.map((id) => by.get(id)).filter((r): r is RowT => !!r); });
    await fetch(`/api/tables/${activeTableId}/rows/reorder`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ order: orderedIds }) });
  }
  async function insertRows(anchorId: string, position: 'above' | 'below', count: number) {
    if (!activeTableId) return;
    const res = await fetch(`/api/tables/${activeTableId}/rows/insert`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ anchorId, position, count }) });
    if (!res.ok) return;
    const d = await res.json();
    const created: RowT[] = (d.rows ?? []).map((r: RowT) => ({ ...r, data: r.data || {} }));
    setRows((rs) => {
      const idx = rs.findIndex((r) => r.id === anchorId);
      if (idx < 0) return [...rs, ...created];
      const at = position === 'above' ? idx : idx + 1;
      return [...rs.slice(0, at), ...created, ...rs.slice(at)];
    });
  }
  async function duplicateRows(ids: string[]) {
    if (!activeTableId || !ids.length) return;
    const res = await fetch(`/api/tables/${activeTableId}/rows/duplicate`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ ids }) });
    if (!res.ok) return;
    const d = await res.json();
    const created: RowT[] = (d.rows ?? []).map((r: RowT) => ({ ...r, data: r.data || {} }));
    setRows((rs) => {
      const idxs = ids.map((id) => rs.findIndex((r) => r.id === id)).filter((i) => i >= 0);
      const at = idxs.length ? Math.max(...idxs) + 1 : rs.length;
      return [...rs.slice(0, at), ...created, ...rs.slice(at)];
    });
  }
  async function bulkDeleteRows(ids: string[]) {
    if (!activeTableId || !ids.length) return;
    const set = new Set(ids);
    setRows((rs) => rs.filter((r) => !set.has(r.id)));
    await fetch(`/api/tables/${activeTableId}/rows/bulk-delete`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ ids }) });
  }
  async function copyRowLink(rowId: string) {
    if (typeof window === 'undefined' || !activeTableId) return;
    const url = `${window.location.origin}/database/${baseId}?table=${activeTableId}&record=${rowId}`;
    try { await navigator.clipboard.writeText(url); setCopied(true); setTimeout(() => setCopied(false), 1600); } catch { /* clipboard blocked */ }
  }
  async function patchViewConfig(patch: Partial<ViewConfig>, reload = false) {
    if (!table || !activeTableId) return;
    const view = table.views.find((v) => v.id === activeViewId) ?? table.views[0];
    if (!view) return;
    const nextConfig = { ...(view.config ?? {}), ...patch };
    setTable((t0) => (t0 ? { ...t0, views: t0.views.map((v) => (v.id === view.id ? { ...v, config: nextConfig } : v)) } : t0));
    await fetch(`/api/views/${view.id}`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ config: nextConfig }) });
    if (reload) await reloadRows(activeTableId, view.id);
  }

  function switchView(viewId: string) {
    if (!activeTableId || viewId === activeViewId) return;
    setActiveViewId(viewId);
    reloadRows(activeTableId, viewId);
  }

  async function addView(type: ViewT['type']) {
    if (!activeTableId || !table) return;
    const label = type === 'kanban' ? t('kanbanView') : type === 'calendar' ? t('calendarView') : t('gridView');
    const config: Record<string, unknown> = {};
    if (type === 'kanban') { const f = table.fields.find((x) => x.type === 'singleSelect'); if (f) config.kanbanStackFieldId = f.id; }
    if (type === 'calendar') { const f = table.fields.find((x) => x.type === 'date'); if (f) config.calendarDateFieldId = f.id; }
    const res = await fetch(`/api/tables/${activeTableId}/views`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ name: label, type, config }) });
    if (res.ok) {
      const v: ViewT = await res.json();
      setTable((t0) => (t0 ? { ...t0, views: [...t0.views, v] } : t0));
      setActiveViewId(v.id);
      reloadRows(activeTableId, v.id);
    }
  }

  async function renameView() {
    if (!renameViewT) return;
    const id = renameViewT.id;
    const nm = renameViewVal.trim();
    if (!nm) return;
    setTable((t0) => (t0 ? { ...t0, views: t0.views.map((v) => (v.id === id ? { ...v, name: nm } : v)) } : t0));
    setRenameViewT(null);
    await fetch(`/api/views/${id}`, { method: 'PATCH', headers: JSON_HEADERS, body: JSON.stringify({ name: nm }) });
  }

  async function deleteView() {
    if (!delViewT || !table || table.views.length <= 1) { setDelViewT(null); return; }
    const id = delViewT.id;
    const remaining = table.views.filter((v) => v.id !== id);
    setTable((t0) => (t0 ? { ...t0, views: remaining } : t0));
    setDelViewT(null);
    if (activeViewId === id) {
      const nextV = [...remaining].sort((a, b) => a.position - b.position)[0];
      setActiveViewId(nextV?.id ?? null);
      if (activeTableId && nextV) reloadRows(activeTableId, nextV.id);
    }
    await fetch(`/api/views/${id}`, { method: 'DELETE' });
  }

  if (loading) return <div style={{ display: 'flex', justifyContent: 'center', padding: 60 }}><Spinner size={22} /></div>;
  if (!base) return <div style={{ padding: 40 }}><Link href="/database" className="btn btn-ghost"><ChevronLeft size={16} /> {t('title')}</Link></div>;

  const accent = base.color || '#3b82f6';
  const restricted = base.visibility === 'restricted';
  // Whether the caller may edit this table's data. Prefer the table-scoped flag
  // (per-table owners exist); fall back to the base flag. Fail-closed: a missing
  // flag (e.g. an old cached response) yields read-only, never accidental edit.
  const canEdit = table?.canEdit ?? base.canEdit ?? false;
  const activeView = table ? (table.views.find((v) => v.id === activeViewId) ?? [...table.views].sort((a, b) => a.position - b.position)[0] ?? null) : null;
  const detailRow = detailRowId ? rows.find((r) => r.id === detailRowId) ?? null : null;

  return (
    <div style={{ padding: '18px clamp(12px, 3vw, 28px)', display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      {saveToast}
      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <Link href="/database" className="btn btn-ghost btn-icon" style={{ width: 32, height: 32 }}><ChevronLeft size={18} /></Link>
        <span style={{ width: 11, height: 11, borderRadius: 3, background: accent, flexShrink: 0 }} />
        <h1 style={{ fontSize: 18, fontWeight: 700, margin: 0, letterSpacing: '-0.01em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{base.name}</h1>
        <div style={{ flex: 1 }} />
        <button className="btn btn-ghost" onClick={() => setShareOpen(true)} style={{ fontWeight: 600, gap: 7 }}>
          {restricted ? <Lock size={15} /> : <Share2 size={15} />} {t('share')}
        </button>
        <PopMenu trigger={<MoreHorizontal size={18} />} label={t('menu')}>
          {(close) => (
            <>
              <MenuRow icon={<Pencil size={14} />} label={t('rename')} onClick={() => { close(); setRenameBaseVal(base.name); setRenameBaseOpen(true); }} />
              <MenuRow icon={<Share2 size={14} />} label={t('share')} onClick={() => { close(); setShareOpen(true); }} />
              <MenuRow icon={<Download size={14} />} label={exporting ? t('exporting') : t('exportCsv')} disabled={!table || exporting} onClick={() => { close(); exportCsv(); }} />
              <div style={{ display: 'flex', gap: 5, padding: '8px 10px 6px', flexWrap: 'wrap' }}>
                {CHOICE_COLORS.slice(0, 8).map((c) => (
                  <button key={c} onClick={() => recolorBase(c)} title={t('recolor')} style={{ width: 18, height: 18, borderRadius: 5, background: c, border: base.color === c ? '2px solid var(--text)' : '1px solid rgba(255,255,255,.12)', cursor: 'pointer' }} />
                ))}
              </div>
              <div style={{ height: 1, background: 'var(--border)', margin: '4px 0' }} />
              <MenuRow icon={<Trash2 size={14} />} label={t('deleteBase')} danger onClick={() => { close(); setConfirmDelBase(true); }} />
            </>
          )}
        </PopMenu>
      </div>

      {/* Table tabs */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 2, borderBottom: '1px solid var(--border)', marginBottom: 16, overflowX: 'auto', overflowY: 'hidden' }}>
        {base.tables.map((tab) => {
          const active = tab.id === activeTableId;
          const tabOwner = members.find((u) => u.id === tab.createdById) ?? null;
          const ownsTab = !!base.currentUserId && tab.createdById === base.currentUserId;
          const tabCanManage = !!base.canManage || ownsTab; // rename/delete/structure
          const tabCanTransfer = !!base.canTransfer || ownsTab; // hand it to someone else
          return (
            <div key={tab.id} style={{ display: 'inline-flex', alignItems: 'center', borderBottom: `2px solid ${active ? 'var(--accent)' : 'transparent'}`, marginBottom: -1 }}>
              <button
                onClick={() => setActiveTableId(tab.id)}
                style={{ border: 'none', background: 'transparent', padding: '8px 6px 8px 12px', cursor: 'pointer', fontSize: 13.5, fontWeight: active ? 700 : 500, color: active ? 'var(--text)' : 'var(--text-2)', whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 6 }}
              >
                <Table2 size={14} /> {tab.name}
              </button>
              {active ? (
                <PopMenu trigger={<MoreHorizontal size={14} />} width={200} small label={t('menu')}>
                  {(close) => (
                    <>
                      {tabOwner && (
                        <div style={{ padding: '8px 12px 6px', fontSize: 11.5, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {t('tableOwner')}: <span style={{ color: 'var(--text-2)', fontWeight: 600 }}>{tabOwner.name || tabOwner.email}</span>
                        </div>
                      )}
                      <MenuRow icon={<Pencil size={14} />} label={t('renameTable')} onClick={() => { close(); setRenameTableVal(tab.name); setRenameTableT(tab); }} />
                      {tabCanTransfer && <MenuRow icon={<ArrowRightLeft size={14} />} label={t('transferTable')} onClick={() => { close(); setTransferTableT(tab); }} />}
                      {tabCanManage && <MenuRow icon={<Trash2 size={14} />} label={t('deleteTable')} danger onClick={() => { close(); setDelTableT(tab); }} />}
                    </>
                  )}
                </PopMenu>
              ) : (
                <span style={{ width: 8 }} />
              )}
            </div>
          );
        })}
        <button onClick={() => setNewTableOpen(true)} className="btn btn-ghost btn-icon" title={t('newTable')} style={{ width: 28, height: 28, marginLeft: 4 }}><Plus size={15} /></button>
      </div>

      {/* Body */}
      {base.tables.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '48px 24px' }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>{t('noTables')}</div>
          <button className="btn btn-primary" onClick={() => setNewTableOpen(true)} style={{ marginTop: 14 }}><Plus size={16} /> {t('newTable')}</button>
        </div>
      ) : !table || !activeView ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}><Spinner size={20} /></div>
      ) : (
        <>
          <ViewTabs
            views={table.views}
            activeId={activeView.id}
            onSwitch={switchView}
            onAdd={addView}
            onRename={(v) => { setRenameViewVal(v.name); setRenameViewT(v); }}
            onDelete={(v) => setDelViewT(v)}
          />
          <GridToolbar
            key={activeView.id}
            fields={table.fields}
            members={members}
            filters={activeView.config?.filters ?? []}
            sorts={activeView.config?.sorts ?? []}
            rowCount={rows.length}
            onChange={(next) => patchViewConfig(next, true)}
            readOnly={!canEdit}
          />
          {activeView.type === 'kanban' ? (
            <KanbanView table={table} rows={rows} members={members} stackFieldId={activeView.config?.kanbanStackFieldId} onSetStackField={(fid) => patchViewConfig({ kanbanStackFieldId: fid })} onCellChange={updateCell} onAddRow={addRow} onOpenRecord={setDetailRowId} readOnly={!canEdit} />
          ) : activeView.type === 'calendar' ? (
            <CalendarView table={table} rows={rows} members={members} dateFieldId={activeView.config?.calendarDateFieldId} onSetDateField={(fid) => patchViewConfig({ calendarDateFieldId: fid })} onAddRow={addRow} onOpenRecord={setDetailRowId} readOnly={!canEdit} />
          ) : (
            <GridView table={table} rows={rows} members={members} onCellChange={updateCell} onAddRow={addRow} onAddField={addField} onEditField={editField} onDeleteRow={deleteRow} onDeleteField={deleteField} onSetPrimary={setPrimary} onResizeField={resizeField} onReorderFields={reorderFields} onReorderRows={reorderRows} canReorderRows={!(activeView.config?.sorts?.length)} onInsertRow={insertRows} onDuplicateRows={duplicateRows} onBulkDelete={bulkDeleteRows} onCopyRowLink={copyRowLink} readOnly={!canEdit} />
          )}
        </>
      )}

      {/* Modals */}
      <Modal open={newTableOpen} onClose={() => { setNewTableOpen(false); setTableErr(null); }} title={t('newTable')} width={420}>
        <label className="field-label">{t('tableName')}</label>
        <input className="field" autoFocus value={newTableName} onChange={(e) => setNewTableName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && createTable()} placeholder={t('tableNamePlaceholder')} style={{ width: '100%', marginBottom: tableErr ? 8 : 18 }} />
        {tableErr && <div style={{ color: 'var(--red, #ef4444)', fontSize: 12.5, marginBottom: 14 }}>{tableErr}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn btn-ghost" onClick={() => setNewTableOpen(false)}>{tc('cancel')}</button>
          <button className="btn btn-primary" onClick={createTable} disabled={!newTableName.trim() || busy}>{busy ? <Spinner size={15} /> : t('createTable')}</button>
        </div>
      </Modal>

      <Modal open={renameBaseOpen} onClose={() => setRenameBaseOpen(false)} title={t('renameBaseTitle')} width={420}>
        <input className="field" autoFocus value={renameBaseVal} onChange={(e) => setRenameBaseVal(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && renameBase()} style={{ width: '100%', marginBottom: 18 }} />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn btn-ghost" onClick={() => setRenameBaseOpen(false)}>{tc('cancel')}</button>
          <button className="btn btn-primary" onClick={renameBase} disabled={!renameBaseVal.trim()}>{tc('save')}</button>
        </div>
      </Modal>

      <Modal open={confirmDelBase} onClose={() => setConfirmDelBase(false)} title={t('deleteBase')} width={420}>
        <p style={{ margin: '0 0 18px', color: 'var(--text-2)', fontSize: 14, lineHeight: 1.5 }}>{t('confirmDeleteBase')}</p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn btn-ghost" onClick={() => setConfirmDelBase(false)}>{tc('cancel')}</button>
          <button className="btn" onClick={deleteBase} style={{ background: 'var(--red, #ef4444)', color: '#fff', fontWeight: 600 }}>{t('deleteBase')}</button>
        </div>
      </Modal>

      <Modal open={!!renameTableT} onClose={() => setRenameTableT(null)} title={t('renameTable')} width={420}>
        <input className="field" autoFocus value={renameTableVal} onChange={(e) => setRenameTableVal(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && renameTable()} style={{ width: '100%', marginBottom: 18 }} />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn btn-ghost" onClick={() => setRenameTableT(null)}>{tc('cancel')}</button>
          <button className="btn btn-primary" onClick={renameTable} disabled={!renameTableVal.trim()}>{tc('save')}</button>
        </div>
      </Modal>

      <Modal open={!!delTableT} onClose={() => setDelTableT(null)} title={t('deleteTable')} width={420}>
        <p style={{ margin: '0 0 18px', color: 'var(--text-2)', fontSize: 14, lineHeight: 1.5 }}>{t('confirmDeleteTable')}</p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn btn-ghost" onClick={() => setDelTableT(null)}>{tc('cancel')}</button>
          <button className="btn" onClick={deleteTable} style={{ background: 'var(--red, #ef4444)', color: '#fff', fontWeight: 600 }}>{t('deleteTable')}</button>
        </div>
      </Modal>

      {detailRow && table && (
        <RecordModal table={table} row={detailRow} members={members} onCellChange={updateCell} onClose={() => setDetailRowId(null)} readOnly={!canEdit} />
      )}

      <Modal open={!!renameViewT} onClose={() => setRenameViewT(null)} title={t('renameView')} width={420}>
        <input className="field" autoFocus value={renameViewVal} onChange={(e) => setRenameViewVal(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && renameView()} style={{ width: '100%', marginBottom: 18 }} />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn btn-ghost" onClick={() => setRenameViewT(null)}>{tc('cancel')}</button>
          <button className="btn btn-primary" onClick={renameView} disabled={!renameViewVal.trim()}>{tc('save')}</button>
        </div>
      </Modal>

      <Modal open={!!delViewT} onClose={() => setDelViewT(null)} title={t('deleteView')} width={420}>
        <p style={{ margin: '0 0 18px', color: 'var(--text-2)', fontSize: 14, lineHeight: 1.5 }}>{t('confirmDeleteView')}</p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn btn-ghost" onClick={() => setDelViewT(null)}>{tc('cancel')}</button>
          <button className="btn" onClick={deleteView} style={{ background: 'var(--red, #ef4444)', color: '#fff', fontWeight: 600 }}>{t('deleteView')}</button>
        </div>
      </Modal>

      {shareOpen && (
        <ShareModal
          open={shareOpen}
          baseId={baseId}
          onClose={() => setShareOpen(false)}
          onVisibility={(v) => setBase((b) => (b ? { ...b, visibility: v } : b))}
          onOwnerChanged={(ownerId) => setBase((b) => (b ? { ...b, ownerId, createdById: ownerId } : b))}
        />
      )}

      <TransferModal
        open={!!transferTableT}
        title={t('transferTableTitle')}
        subject={transferTableT?.name}
        members={members}
        currentOwnerId={transferTableT?.createdById ?? null}
        hint={t('transferTableHint')}
        onClose={() => setTransferTableT(null)}
        onTransfer={transferTable}
      />

      {copied && (
        <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', zIndex: 3000, background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, padding: '8px 14px', fontSize: 13, fontWeight: 600, color: 'var(--text)', boxShadow: '0 10px 30px rgba(0,0,0,.4)' }}>
          {t('linkCopied')}
        </div>
      )}
    </div>
  );
}

