'use client';

import { useRef, useState, useEffect, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import { Paperclip, FileText, X, Download } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import type { FileRef } from '../lib/types';

const MAX = 25 * 1024 * 1024; // mirror lib/base-files MAX_FILE_SIZE

const asFiles = (value: unknown): FileRef[] =>
  Array.isArray(value)
    ? (value.filter(
        (f) => f && typeof f === 'object' && typeof (f as FileRef).id === 'string' && typeof (f as FileRef).path === 'string',
      ) as FileRef[])
    : [];

const isImage = (mime?: string | null) => !!mime && mime.startsWith('image/') && mime !== 'image/svg+xml';

/**
 * Attachment cell. Uploads go to the base file store; the cell value is the
 * descriptor list (persisted via onCommit → row PATCH). Images preview in a
 * lightbox; PDFs open inline in a new tab; everything else downloads.
 */
export function FileCell({
  value,
  baseId,
  rowId,
  fieldId,
  onCommit,
  readOnly = false,
}: {
  value: unknown;
  baseId?: string;
  rowId?: string;
  fieldId: string;
  onCommit: (value: unknown) => void;
  /** Viewer mode: can open/download files (reads), but cannot upload/remove. */
  readOnly?: boolean;
}) {
  const t = useTranslations('database');
  const files = asFiles(value);
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);
  const [preview, setPreview] = useState<FileRef | null>(null);

  // Gates BOTH the upload button and each chip's remove-X. Reads (open/download) stay.
  const canUpload = !readOnly && !!baseId && !!rowId;
  const serveUrl = (f: FileRef) => `/api/bases/${baseId}/files/${f.id}?row=${rowId}&field=${fieldId}`;

  async function upload(list: FileList) {
    if (!canUpload) return;
    setErr(false);
    setBusy(true);
    const added: FileRef[] = [];
    for (const file of Array.from(list)) {
      if (file.size > MAX) { setErr(true); continue; }
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(`/api/bases/${baseId}/files`, { method: 'POST', body: fd });
      if (res.ok) added.push(await res.json());
      else setErr(true);
    }
    setBusy(false);
    if (added.length) onCommit([...files, ...added]);
  }

  function remove(f: FileRef) {
    onCommit(files.filter((x) => x.id !== f.id));
    if (baseId) fetch(`/api/bases/${baseId}/files?path=${encodeURIComponent(f.path)}`, { method: 'DELETE' }).catch(() => {});
  }

  function openFile(f: FileRef) {
    if (isImage(f.mime)) setPreview(f);
    else window.open(serveUrl(f), '_blank', 'noopener,noreferrer');
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 5, width: '100%', height: '100%', padding: '0 8px', overflow: 'hidden' }}>
      {files.map((f) => (
        <span key={f.id} style={chip} title={f.name}>
          <button type="button" onClick={() => openFile(f)} style={chipOpen}>
            {isImage(f.mime) ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={serveUrl(f)} alt="" style={{ width: 22, height: 22, borderRadius: 4, objectFit: 'cover', flexShrink: 0 }} />
            ) : (
              <FileText size={13} style={{ opacity: 0.7, flexShrink: 0 }} />
            )}
            <span style={chipName}>{f.name}</span>
          </button>
          {canUpload && (
            <button type="button" onClick={() => remove(f)} aria-label={t('removeFile')} style={chipX}>
              <X size={11} />
            </button>
          )}
        </span>
      ))}

      {canUpload && (
        <button type="button" onClick={() => inputRef.current?.click()} disabled={busy} aria-label={t('attachFile')} title={t('attachFile')} style={addBtn}>
          {busy ? <Spinner size={13} /> : <Paperclip size={13} />}
        </button>
      )}
      {err && <span style={{ fontSize: 11, color: 'var(--danger)', flexShrink: 0 }} title={t('fileTooLarge')}>!</span>}

      <input
        ref={inputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => { if (e.target.files?.length) upload(e.target.files); e.target.value = ''; }}
      />

      {preview && typeof document !== 'undefined' &&
        createPortal(<Lightbox file={preview} url={serveUrl(preview)} downloadLabel={t('download')} onClose={() => setPreview(null)} />, document.body)}
    </div>
  );
}

function Lightbox({ file, url, downloadLabel, onClose }: { file: FileRef; url: string; downloadLabel: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, zIndex: 3000, background: 'rgba(0,0,0,.82)', backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 32, animation: 'fadeIn .15s ease' }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: '92vw' }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt={file.name} style={{ maxWidth: '92vw', maxHeight: '82vh', objectFit: 'contain', borderRadius: 12, boxShadow: '0 24px 70px var(--overlay)' }} />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <span style={{ color: 'var(--on-accent)', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.name}</span>
          <a
            href={url}
            download={file.name}
            onClick={(e) => e.stopPropagation()}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--on-accent)', fontSize: 13, textDecoration: 'none', background: 'rgba(255,255,255,.16)', padding: '6px 12px', borderRadius: 8, flexShrink: 0 }}
          >
            <Download size={14} /> {downloadLabel}
          </a>
        </div>
      </div>
      <button
        onClick={onClose}
        aria-label="Close"
        style={{ position: 'fixed', top: 20, right: 20, width: 38, height: 38, borderRadius: '50%', border: 'none', background: 'rgba(255,255,255,.16)', color: 'var(--on-accent)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      >
        <X size={18} />
      </button>
    </div>
  );
}

const chip: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 2, background: 'var(--surface-2)', borderRadius: 8,
  paddingRight: 2, maxWidth: 150, flexShrink: 0, height: 26,
};
const chipOpen: CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 5, border: 'none', background: 'transparent',
  cursor: 'pointer', padding: '2px 4px 2px 6px', minWidth: 0, color: 'var(--text)',
};
const chipName: CSSProperties = { fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const chipX: CSSProperties = {
  border: 'none', background: 'transparent', color: 'var(--muted)', cursor: 'pointer',
  display: 'inline-flex', padding: 2, borderRadius: 4, flexShrink: 0,
};
const addBtn: CSSProperties = {
  border: '1px dashed var(--border-2, var(--border))', background: 'transparent', color: 'var(--muted)',
  cursor: 'pointer', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  width: 26, height: 26, borderRadius: 7, flexShrink: 0,
};
