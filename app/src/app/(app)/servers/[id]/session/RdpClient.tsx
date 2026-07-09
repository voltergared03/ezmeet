'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, Power, RefreshCw, AlertTriangle, Upload, Download, GripVertical, FolderSync } from 'lucide-react';

/* ─── Minimal structural types for the dynamically-imported IronRDP API ───────
 * The real types live in @devolutions/iron-remote-desktop(.rdp), but those modules
 * register a custom element + init WASM at import time, so they may ONLY be loaded
 * in the browser (a server import crashes on `customElements`). We therefore import
 * them lazily inside an effect and describe just the surface we touch here. */
interface ConfigBuilderLike {
  withUsername(v: string): ConfigBuilderLike;
  withPassword(v: string): ConfigBuilderLike;
  withDestination(v: string): ConfigBuilderLike;
  withProxyAddress(v: string): ConfigBuilderLike;
  withServerDomain(v: string): ConfigBuilderLike;
  withAuthToken(v: string): ConfigBuilderLike;
  withDesktopSize(v: { width: number; height: number }): ConfigBuilderLike;
  withExtension(v: unknown): ConfigBuilderLike;
  build(): unknown;
}
interface UserInteractionLike {
  configBuilder(): ConfigBuilderLike;
  connect(config: unknown): Promise<{
    run(): Promise<{ reason(): string }>;
    /** Framebuffer the server actually granted (it clamps oversized HD requests). */
    initialDesktopSize?: { width: number; height: number };
  }>;
  setVisibility(v: boolean): void;
  setScale(scale: number): void;
  resize(width: number, height: number, scale?: number): void;
  ctrlAltDel(): void;
  metaKey(): void;
  // Send a Ctrl+C / Ctrl+V special combination STRAIGHT to the backend
  // (sendSpecialCombination) — bypasses the component's key-forward focus gate, so
  // copy/paste works regardless of which element is document.activeElement.
  ctrlC?(): void;
  ctrlV?(): void;
  // Unicode keyboard mode: send the typed CHARACTER (event.key) instead of the
  // physical-key SCANCODE, so the result is independent of the server's active
  // keyboard layout. The RDP backend reports supportsUnicodeKeyboardShortcuts=false,
  // so the component only takes the Unicode path for modifier-free printable keys —
  // anything with Ctrl/Alt/⌘ held, and all named keys (Enter/Tab/arrows/F-keys),
  // still go through scancodes, so shortcuts keep working.
  setKeyboardUnicodeMode?(useUnicode: boolean): void;
  shutdown(): void;
  setEnableClipboard(v: boolean): void;
  setEnableAutoClipboard?(v: boolean): void;
  enableFileTransfer?(provider: unknown): unknown;
  // Manual clipboard path (the component falls back to this when the auto monitor
  // can't read without a user gesture). remote→local: saveRemoteClipboardData();
  // local→remote: sendClipboardData(). Notified of remote changes via the callback.
  onClipboardRemoteUpdateCallback?(cb: () => void): void;
  onWarningCallback?(cb: (msg: string) => void): void;
  saveRemoteClipboardData?(): Promise<void>;
  sendClipboardData?(): Promise<void>;
}
// Bidirectional file transfer over the RDP clipboard channel (CLIPRDR file copy).
interface RdpFileInfo {
  name: string;
  size: number;
  lastModified: number;
  path?: string;
}
interface FileTransferProviderLike {
  on(event: string, handler: (...args: never[]) => void): void;
  handleDrop(e: DragEvent): Promise<unknown[]>;
  handleDragOver(e: DragEvent): void;
  uploadFiles(files: unknown[]): unknown;
  downloadFile(info: RdpFileInfo, index: number): { completion: Promise<Blob> };
}
type IronElement = HTMLElement & {
  module: unknown;
  scale: string;
  verbose: boolean;
  flexcenter: boolean;
};

// ScreenScale numeric values (from the reference svelte client: Fit=1, Full=2, Real=3).
const SCALE = { FIT: 1, FULL: 2, REAL: 3 } as const;

// init() is global to the WASM module — run it at most once per page load.
let _initPromise: Promise<void> | null = null;

const isMac = () =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

// RDP framebuffers must be 4-pixel aligned or partial codec tiles tear; the
// protocol caps either dimension at 8192 (MS-RDPEDISP hard-errors past it).
const align4 = (n: number) => Math.min(8192, Math.max(640, Math.floor(n / 4) * 4));

// HiDPI ("HD") mode: render the session at the display's real pixel density
// (devicePixelRatio, capped at 2) and ask Windows for matching UI scaling, so a
// Retina screen gets a pixel-for-pixel image instead of a 2× CSS upscale. Costs
// DPR²× bitmap data per frame — kept as an explicit user toggle in the status
// pill. Windows only honors the scale factor at connect time, so switching
// reconnects the session.
const HIDPI_KEY = 'garely-rdp-hidpi';
const hiDpiEnabled = () => {
  try {
    return localStorage.getItem(HIDPI_KEY) === '1';
  } catch {
    return false;
  }
};
const dprFactor = () => (hiDpiEnabled() ? Math.min(Math.max(window.devicePixelRatio || 1, 1), 2) : 1);

// Shared FILE clipboard (CLIPRDR file copy), toggleable from the pill. When off, a
// server-side file copy no longer auto-downloads to the local machine and drag-drop
// upload is paused — so a user can work with files INSIDE the server. The TEXT
// clipboard is a separate channel and always stays on. Default ON.
const FILECLIP_KEY = 'garely-rdp-fileclip';
const fileClipEnabled = () => {
  try { return localStorage.getItem(FILECLIP_KEY) !== '0'; } catch { return true; }
};


// IronError isn't a JS Error — it exposes kind()/backtrace(). Surface the real
// reason instead of the "[object Object]" you get from String(an opaque object).
function describeError(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { backtrace?: () => string; kind?: () => string; message?: string };
    if (typeof e.backtrace === 'function') {
      try {
        const kind = typeof e.kind === 'function' ? e.kind() : '';
        const trace = e.backtrace();
        return [kind, trace].filter(Boolean).join(': ') || 'connection error';
      } catch {
        /* fall through */
      }
    }
    if (typeof e.message === 'string' && e.message) return e.message;
  }
  return err instanceof Error ? err.message : String(err);
}

// Stream a downloaded blob to the user's machine (server → client file transfer).
function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name || 'download';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// The IronRDP web component attaches the CLIPRDR (clipboard) static channel only if
// its remote-clipboard callback was registered on the SessionBuilder BEFORE connect().
// That registration is done by the component's own async initClipboard() in onMount,
// which runs right AFTER the 'ready' event and awaits a clipboard-read permission query.
// We await the same query + a margin so the registration lands before we connect —
// otherwise cliprdr is never negotiated and clipboard/file-transfer are dead on the wire.
async function waitForClipboardWiring(): Promise<void> {
  try {
    await navigator.permissions?.query?.({ name: 'clipboard-read' as PermissionName });
  } catch {
    /* permission name unsupported in this browser — rely on the timed margin */
  }
  await new Promise((r) => setTimeout(r, 400));
}

export type Phase = 'init' | 'connecting' | 'connected' | 'closed' | 'error';

export interface RdpClientProps {
  connectionId: string;
  gatewayUrl: string;
  token: string;
  destination: string; // host:port
  sessionId: string;
  serverName: string;
  username: string;
  domain: string | null;
  /** Credentials the client uses for CredSSP/NLA (from /connect or a user prompt). */
  password: string;
  /** Back to the pre-connect screen (user disconnected or the session ended). */
  onExit: () => void;
  /** Report the live RDP phase up so the page status pill reflects reality. */
  onPhase?: (phase: Phase) => void;
  /** Re-run /connect and remount with a fresh token (used by the HD-mode toggle). */
  onRequestReconnect?: () => void;
}

export default function RdpClient(props: RdpClientProps) {
  const t = useTranslations('servers');
  const hostRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const uiRef = useRef<UserInteractionLike | null>(null);
  const elRef = useRef<IronElement | null>(null);
  const fileProviderRef = useRef<FileTransferProviderLike | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const exitedRef = useRef(false);
  // Wall-clock ms when the session last reached 'connected' (0 until then). Lets the
  // auto-reconnect effect tell a real drop from a never-connected / flapping failure.
  const connectedAtRef = useRef(0);
  // Framebuffer the server actually granted at connect. The server clamps an oversized
  // HD request to its own max, so HD resizes are bounded to this AREA (aspect-preserving)
  // — otherwise it re-clamps every resize and the picture stops re-fitting the window.
  const grantedRef = useRef<{ w: number; h: number } | null>(null);
  // Timestamp (ms) until which a local→remote clipboard push is suppressed, so a
  // freshly-dropped file's FormatList on the remote clipboard isn't overwritten by a
  // text/image push before the user can Ctrl+V it. Time-based + self-expiring so it
  // can NEVER get stuck blocking the clipboard (the earlier boolean-flag version did).
  const clobberUntilRef = useRef(0);
  // Set when the server's clipboard changed but the local write hasn't landed yet;
  // a later gesture (which guarantees focus) retries the pull.
  const remotePullPendingRef = useRef(false);

  // Pull the latest remote clipboard into the local one (server→Mac). Wrapped so a
  // "clipboard has no data" / focus IronError can never surface as an uncaught
  // rejection. Clears the pending flag only on success so a gesture can retry.
  const flushRemoteClipboard = useCallback(async () => {
    if (!remotePullPendingRef.current) return;
    try {
      await uiRef.current?.saveRemoteClipboardData?.();
      remotePullPendingRef.current = false;
    } catch {
      /* leave pending; a later gesture retries */
    }
  }, []);

  const [phase, setPhase] = useState<Phase>('init');
  const [errMsg, setErrMsg] = useState<string>('');
  // True once the RDP file-transfer provider is wired (CLIPRDR file copy available).
  // Gates the pill's file-upload button so it only shows when uploads can actually work.
  const [canUpload, setCanUpload] = useState(false);

  useEffect(() => {
    props.onPhase?.(phase);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);
  const [dragOver, setDragOver] = useState(false);
  const [transfer, setTransfer] = useState<{ dir: 'up' | 'down'; label: string; pct: number } | null>(null);
  const [notice, setNotice] = useState<string>('');
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = useCallback((msg: string, durationMs = 6000) => {
    setNotice(msg);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(''), durationMs);
  }, []);

  // ── Draggable status pill ──────────────────────────────────────────────────
  // The pill (server name + disconnect) defaults to the top-right corner but the
  // user can grab it and drop it anywhere over the canvas — its viewport position
  // persists in localStorage so it stays put across reconnects/reloads.
  const PILL_POS_KEY = 'garely-rdp-pill-pos';
  const pillRef = useRef<HTMLDivElement | null>(null);
  const pillDrag = useRef<{ id: number; sx: number; sy: number; ox: number; oy: number } | null>(null);
  const [pillPos, setPillPos] = useState<{ x: number; y: number } | null>(null);
  const [pillDragging, setPillDragging] = useState(false);
  const clampPill = useCallback((x: number, y: number) => {
    const w = pillRef.current?.offsetWidth ?? 200;
    const h = pillRef.current?.offsetHeight ?? 38;
    const m = 6;
    return {
      x: Math.min(Math.max(m, x), Math.max(m, window.innerWidth - w - m)),
      y: Math.min(Math.max(m, y), Math.max(m, window.innerHeight - h - m)),
    };
  }, []);
  // Restore a saved position once the pill has painted (so offsetWidth is real),
  // and keep it on-screen if the window shrinks.
  useEffect(() => {
    if (phase !== 'connected') return;
    try {
      const raw = localStorage.getItem(PILL_POS_KEY);
      const p = raw ? JSON.parse(raw) : null;
      if (p && typeof p.x === 'number' && typeof p.y === 'number') {
        requestAnimationFrame(() => setPillPos(clampPill(p.x, p.y)));
      }
    } catch {
      /* ignore bad/absent storage */
    }
    const onResize = () => setPillPos((prev) => (prev ? clampPill(prev.x, prev.y) : prev));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [phase, clampPill]);
  const onPillDown = useCallback((e: React.PointerEvent) => {
    // Let the disconnect button click through — only the pill body is a drag handle.
    if ((e.target as HTMLElement).closest('button')) return;
    const el = pillRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    pillDrag.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top };
    setPillPos({ x: r.left, y: r.top }); // switch from right-anchored to left/top, no jump
    setPillDragging(true);
    try { el.setPointerCapture(e.pointerId); } catch { /* noop */ }
    e.preventDefault();
    e.stopPropagation();
  }, []);
  const onPillMove = useCallback((e: React.PointerEvent) => {
    const d = pillDrag.current;
    if (!d || d.id !== e.pointerId) return;
    setPillPos(clampPill(d.ox + (e.clientX - d.sx), d.oy + (e.clientY - d.sy)));
    e.preventDefault();
  }, [clampPill]);
  const onPillUp = useCallback((e: React.PointerEvent) => {
    const d = pillDrag.current;
    if (!d || d.id !== e.pointerId) return;
    pillDrag.current = null;
    setPillDragging(false);
    try { pillRef.current?.releasePointerCapture(e.pointerId); } catch { /* noop */ }
    setPillPos((prev) => {
      if (prev) { try { localStorage.setItem(PILL_POS_KEY, JSON.stringify(prev)); } catch { /* noop */ } }
      return prev;
    });
  }, []);

  // Close the audit session row (best-effort; the gateway will later add byte counts).
  const closeAudit = useCallback(() => {
    const body = JSON.stringify({ sessionId: props.sessionId });
    const url = `/api/servers/${props.connectionId}/disconnect`;
    // sendBeacon survives page unload; fall back to fetch+keepalive.
    if (navigator.sendBeacon) navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
    else void fetch(url, { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, keepalive: true });
  }, [props.connectionId, props.sessionId]);

  const exit = useCallback(() => {
    if (exitedRef.current) return;
    exitedRef.current = true;
    try {
      uiRef.current?.shutdown();
    } catch {
      /* already gone */
    }
    closeAudit();
    props.onExit();
  }, [closeAudit, props]);

  /* HD (HiDPI) toggle — persists the preference, then tears the session down and
   * asks the page for a fresh /connect: Windows only honors desktopScaleFactor in
   * the connect-time core data, so a live switch is not possible. */
  const [hiDpi, setHiDpi] = useState(hiDpiEnabled);
  const dprCapable = typeof window !== 'undefined' && (window.devicePixelRatio || 1) > 1.05;

  /* Shared FILE clipboard toggle — takes effect live (no reconnect): gates the
   * server→local auto-download and the local→server drag-drop upload. */
  const [fileClipboard, setFileClipboard] = useState(fileClipEnabled);
  const fileClipboardRef = useRef(fileClipboard);
  useEffect(() => { fileClipboardRef.current = fileClipboard; }, [fileClipboard]);
  const toggleFileClipboard = useCallback(() => {
    setFileClipboard((v) => {
      const next = !v;
      try { localStorage.setItem(FILECLIP_KEY, next ? '1' : '0'); } catch { /* noop */ }
      return next;
    });
  }, []);
  const toggleHiDpi = useCallback(() => {
    const next = !hiDpi;
    try {
      localStorage.setItem(HIDPI_KEY, next ? '1' : '0');
    } catch {
      /* noop */
    }
    setHiDpi(next);
    if (exitedRef.current) return;
    exitedRef.current = true;
    try {
      uiRef.current?.shutdown();
    } catch {
      /* already gone */
    }
    closeAudit();
    props.onRequestReconnect?.();
  }, [hiDpi, closeAudit, props]);

  /* ─── Presence heartbeat ──────────────────────────────────────────────────
   * While connected, ping the server every 30s so other users with access see this
   * server as "in use by <me>". When the beats stop (disconnect, tab close, crash)
   * the audit row goes stale and presence drops it within ~90s — no ghost occupancy. */
  useEffect(() => {
    if (phase !== 'connected') return;
    const ping = () => {
      void fetch(`/api/servers/${props.connectionId}/heartbeat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: props.sessionId }),
        keepalive: true,
      }).catch(() => {});
    };
    ping(); // immediate, then on an interval
    const id = setInterval(ping, 30_000);
    return () => clearInterval(id);
  }, [phase, props.connectionId, props.sessionId]);

  /* ─── Auto-reconnect after an UNEXPECTED drop ─────────────────────────────────
   * On macOS, Chrome/Safari freeze or discard a backgrounded tab (Memory Saver) and
   * an idle reverse-proxy can close the WebSocket when the remote desktop is static —
   * either one kills the session while the user works in another window, stranding
   * them on the manual reconnect screen. Instead we resume automatically the moment
   * the tab is focused again. RDP keeps the Windows session alive across a disconnect,
   * so the desktop returns exactly as it was.
   *
   * Guard rails so this can never spin: only a session that stayed live for 10s+ is
   * retried (a connect failure never reaches 'connected'; a session that flaps within
   * seconds falls back to the manual button), never after a user Disconnect or HD
   * toggle (exitedRef), and at most once per mount — doConnect remounts us, which
   * re-arms it for the next drop. */
  const onReconnectRef = useRef(props.onRequestReconnect);
  onReconnectRef.current = props.onRequestReconnect;
  useEffect(() => {
    if (phase === 'connected') {
      connectedAtRef.current = Date.now();
      return;
    }
    if (phase !== 'closed' && phase !== 'error') return;
    if (exitedRef.current || !onReconnectRef.current) return;
    const uptimeMs = connectedAtRef.current ? Date.now() - connectedAtRef.current : 0;
    if (uptimeMs < 10_000) return; // never connected, or flapping → leave the manual button
    let done = false;
    const resume = () => {
      if (done || exitedRef.current) return;
      done = true;
      onReconnectRef.current?.();
    };
    if (document.visibilityState === 'visible') {
      const id = setTimeout(resume, 1_000); // foreground blip — let the network settle first
      return () => clearTimeout(id);
    }
    // Backgrounded drop (the common macOS case): wait until the user comes back, so we
    // don't reconnect into a still-throttled tab that would just drop again.
    const onVisible = () => {
      if (document.visibilityState === 'visible') resume();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [phase]);

  /* ─── Keep a backgrounded tab awake while connected ───────────────────────────
   * Chrome/Safari freeze a tab backgrounded for ~5 min, severing the RDP WebSocket
   * (the desktop is static, so nothing keeps the socket busy). A tab that is playing
   * audio is EXEMPT from freezing, so we run one inaudible WebAudio loop for the life
   * of the session — a very low frequency at a tiny gain, below what hardware can
   * reproduce, but enough to keep the tab "audible". Best-effort: if the AudioContext
   * is blocked, the auto-reconnect-on-focus effect above is the fallback. */
  useEffect(() => {
    if (phase !== 'connected') return;
    let ctx: AudioContext | null = null;
    let osc: OscillatorNode | null = null;
    try {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      const gain = ctx.createGain();
      gain.gain.value = 0.0015; // effectively silent, non-zero so the tab counts as audible
      osc = ctx.createOscillator();
      osc.frequency.value = 30; // sub-audible; laptop/most speakers can't reproduce it
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
      // Autoplay policy may re-suspend on background; nudge it back on return.
      const resume = () => { if (ctx && ctx.state === 'suspended') void ctx.resume().catch(() => {}); };
      document.addEventListener('visibilitychange', resume);
      return () => {
        document.removeEventListener('visibilitychange', resume);
        try { osc?.stop(); } catch { /* ignore */ }
        try { void ctx?.close(); } catch { /* ignore */ }
      };
    } catch {
      return () => { try { osc?.stop(); } catch { /* ignore */ } try { void ctx?.close(); } catch { /* ignore */ } };
    }
  }, [phase]);

  /* ─── Mount the web component + run the session lifecycle (once) ─── */
  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    if (!host) return;

    (async () => {
      try {
        // Browser-only dynamic import — registers <iron-remote-desktop> + the RDP backend.
        const rdp = await import('@devolutions/iron-remote-desktop-rdp');
        await import('@devolutions/iron-remote-desktop'); // side effect: customElements.define
        if (!_initPromise) _initPromise = rdp.init('INFO');
        await _initPromise;
        if (cancelled) return;

        const el = document.createElement('iron-remote-desktop') as IronElement;
        el.module = rdp.Backend;
        el.scale = 'full'; // 'fit' letterboxes (preserves aspect); 'full' fills the window
        el.verbose = false;
        el.flexcenter = true;
        el.style.width = '100%';
        el.style.height = '100%';
        el.style.display = 'block';

        el.addEventListener('ready', (e) => {
          const detail = (e as CustomEvent).detail;
          const ui: UserInteractionLike = detail?.irgUserInteraction ?? detail;
          uiRef.current = ui;
          void startSession(ui, rdp);
        });

        host.appendChild(el);
        elRef.current = el;
      } catch (err) {
        if (!cancelled) {
          setErrMsg(describeError(err));
          setPhase('error');
        }
      }
    })();

    async function startSession(ui: UserInteractionLike, rdp: typeof import('@devolutions/iron-remote-desktop-rdp')) {
      try {
        setPhase('connecting');
        // Keyboard layout sync: in the default SCANCODE mode the server interprets the
        // physical key position with ITS OWN active layout, so typing Ukrainian (or any
        // non-US layout) on the Mac while the server sits on US-English produces the wrong
        // characters. Unicode mode sends the actual character the user typed, so it lands
        // correctly regardless of the server's active layout — and since the RDP backend
        // forces modifier combos + named keys through scancodes anyway, shortcuts are safe.
        try {
          ui.setKeyboardUnicodeMode?.(true);
        } catch {
          /* older backend without the toggle */
        }
        ui.setEnableClipboard(true); // clipboard channel on
        // MANUAL clipboard mode. AUTO mode runs a 100ms navigator.clipboard.read()
        // monitor that — once the tab is focused — throws an UNCAUGHT IronError every
        // tick (confirmed live: two "Uncaught (in promise) IronError kind=General" right
        // after "Start RDP session", present only when document.hasFocus()===true). That
        // erroring monitor is what broke the clipboard both ways. In manual mode no
        // monitor runs; we drive sync deterministically: local→remote on the ⌘-down /
        // pointer-enter gesture (sendClipboardData), remote→local on the component's
        // remote-clipboard-change callback (saveRemoteClipboardData). All wrapped in
        // .catch so a "clipboard has no data" IronError can never surface uncaught.
        try {
          ui.setEnableAutoClipboard?.(false);
        } catch {
          /* older backend without the toggle */
        }
        // server→Mac: fires for BOTH keyboard ⌘C/Ctrl+C AND right-click→Copy on the
        // server (any remote clipboard change). The canvas is focused at copy time, so
        // the write usually lands immediately; if it doesn't, retry on the next gesture.
        try {
          ui.onClipboardRemoteUpdateCallback?.(() => {
            remotePullPendingRef.current = true;
            void flushRemoteClipboard();
          });
        } catch {
          /* older backend */
        }

        // Bidirectional file transfer over the RDP clipboard channel. Must be enabled
        // BEFORE connect. Drag files onto the canvas → uploaded to the remote clipboard
        // (paste with Ctrl+V there); copy files on the remote → auto-downloaded here.
        try {
          // The component's enableFileTransfer() already composes in its own
          // suppress/resume of the 100ms clipboard monitor around uploads, so we do
          // NOT pass onUploadStarted/onUploadFinished. Our separate, time-based
          // clobber window (set in onDrop) guards only OUR manual ⌘-down/pointer-enter
          // pushes — it can't get stuck and never blocks text clipboard for long.
          const provider = new rdp.RdpFileTransferProvider({ chunkSize: 64 * 1024 });
          provider.on('files-available', async (files) => {
            // File clipboard off → don't auto-download server-copied files to the local
            // machine, so the user can copy/move files INSIDE the server undisturbed.
            if (!fileClipboardRef.current) return;
            for (let i = 0; i < files.length; i++) {
              try {
                const blob = await provider.downloadFile(files[i], i).completion;
                saveBlob(blob, files[i].name);
              } catch {
                /* one file failed — keep going */
              }
            }
          });
          provider.on('download-progress', (p) =>
            setTransfer({ dir: 'down', label: p.fileName, pct: Math.round(p.percentage) }),
          );
          provider.on('upload-progress', (p) =>
            setTransfer({ dir: 'up', label: p.fileName, pct: Math.round(p.percentage) }),
          );
          provider.on('download-complete', () => setTimeout(() => setTransfer(null), 1500));
          provider.on('upload-complete', () => setTimeout(() => setTransfer(null), 1500));
          provider.on('error', () => {
            setTransfer(null);
            flash(t('fileError'));
          });
          ui.enableFileTransfer?.(provider);
          fileProviderRef.current = provider as unknown as FileTransferProviderLike;
          setCanUpload(true);
        } catch {
          /* backend without file transfer — display/clipboard still work */
        }

        // Negotiate the framebuffer 1:1 with the browser window. In standard mode this
        // is CSS pixels; in HD mode it's multiplied by devicePixelRatio so a Retina
        // display gets a pixel-for-pixel image (with Windows scaling its UI to match —
        // the desktopScaleFactor extension below). Kept in sync live by the debounced
        // resize effect (DisplayControl / ui.resize). scale='full' CSS-stretches the
        // canvas during a drag for instant feedback until the new resolution settles.
        const factor = dprFactor();
        const size = {
          width: align4(window.innerWidth * factor),
          height: align4(window.innerHeight * factor),
        };
        // The browser IronRDP client performs CredSSP/NLA itself over the gateway's
        // RDCleanPath relay (the gateway forwards; it does NOT inject credentials on
        // this path). So the client needs the username/password — delivered from the
        // access-checked /connect response and held only in WASM memory for this session.
        let builder = ui
          .configBuilder()
          .withDestination(props.destination)
          .withProxyAddress(props.gatewayUrl)
          .withAuthToken(props.token)
          .withServerDomain(props.domain || '')
          .withUsername(props.username)
          .withPassword(props.password)
          .withDesktopSize(size)
          .withExtension(rdp.displayControl(true))
          // NLA / CredSSP — required by modern Windows hosts.
          .withExtension(rdp.enableCredssp(true));
        // HD mode: ask Windows to scale its UI to the density we render at, so
        // elements keep their apparent size while text gains real pixels.
        if (factor > 1) {
          builder = builder.withExtension(rdp.desktopScaleFactor(Math.round(factor * 100)));
        }
        const config = builder.build();

        // CRITICAL — wait for the component to wire its clipboard callback BEFORE we
        // connect, or the CLIPRDR channel is never negotiated. The WASM connector
        // attaches the cliprdr static channel ONLY if the component called the
        // low-level SessionBuilder.remoteClipboardChangedCallback before connect()
        // (guarded by `onRemoteClipboardChanged != null && enableClipboard`). That
        // callback is registered by the component's own initClipboard(), which runs in
        // its onMount RIGHT AFTER the 'ready' event we're in — and awaits a
        // clipboard-read permission query first. If we connect synchronously here, the
        // callback isn't set yet → ConnectInitial lists only "drdynvc", no "cliprdr",
        // and clipboard + file transfer are dead on the wire. So we await the same
        // permission query (the only async gap) + a margin so initClipboard's
        // registration lands first. (Devolutions' own client connects on a later user
        // action, which is why clipboard works for them.)
        await waitForClipboardWiring();

        const info = await ui.connect(config);
        if (cancelled) return;
        // Remember the framebuffer the server actually granted (it clamps oversized HD
        // requests to its own max). The resize effect never asks for more area than this,
        // so the server keeps honoring resizes instead of re-clamping to a fixed size.
        const granted = info.initialDesktopSize;
        if (granted && granted.width >= 640 && granted.height >= 480) {
          grantedRef.current = { w: granted.width, h: granted.height };
        }
        ui.setVisibility(true);
        setPhase('connected');
        // Focus the canvas so clipboard read/write (gated on document focus + the
        // shadow-root canvas) works and keystrokes land. delegatesFocus forwards it.
        try {
          elRef.current?.focus();
        } catch {
          /* noop */
        }

        const term = await info.run(); // resolves when the session ends
        if (cancelled) return;
        setErrMsg(term?.reason?.() || '');
        setPhase('closed');
        closeAudit();
      } catch (err) {
        if (cancelled) return;
        setErrMsg(describeError(err));
        setPhase('error');
        closeAudit();
      }
    }

    return () => {
      cancelled = true;
      try {
        uiRef.current?.shutdown();
      } catch {
        /* noop */
      }
      try {
        elRef.current?.remove();
      } catch {
        /* noop */
      }
    };
    // Connect params are fixed for the lifetime of this component instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ─── Mac ⌘ → server copy/paste + shortcut remap ──────────────────────────
   * ROOT CAUSE (confirmed in the component source): the component only forwards a
   * key to the remote when its OWN focus gate is true — `document.activeElement ===
   * <iron-remote-desktop>` — and it sends ⌘ as the Win key. The canvas often isn't
   * the activeElement (stays BODY), so a synthetic ControlLeft we dispatch may never
   * be forwarded → ⌘C/⌘V did nothing. FIX: drive copy/paste through the backend
   * DIRECTLY via ui.ctrlC()/ui.ctrlV() (sendSpecialCombination), which bypasses that
   * focus gate entirely. Clipboard SYNC rides alongside: push local→remote before a
   * paste, pull remote→local after a copy. Other ⌘+letter combos are best-effort
   * remapped to Ctrl. Gate on window focus; reset on blur so nothing sticks. */
  useEffect(() => {
    if (!isMac() || phase !== 'connected') return;
    const isMeta = (code: string) => code === 'MetaLeft' || code === 'MetaRight';
    const focused = () => document.hasFocus();
    let metaDown = false;
    let ctrlHeld = false;
    const synthCtrl = (type: 'keydown' | 'keyup') =>
      window.dispatchEvent(new KeyboardEvent(type, { code: 'ControlLeft', key: 'Control', ctrlKey: type === 'keydown', bubbles: true, cancelable: true }));
    const releaseCtrl = () => { if (ctrlHeld) { ctrlHeld = false; synthCtrl('keyup'); } };
    const reset = () => { metaDown = false; releaseCtrl(); };
    const pushLocal = () => {
      if (Date.now() <= clobberUntilRef.current) return;
      void Promise.resolve(uiRef.current?.sendClipboardData?.()).catch(() => {});
    };

    const onDown = (e: KeyboardEvent) => {
      // IGNORE our own synthetic events (isTrusted=false). Without this, the synthetic
      // Ctrl+letter we dispatch in the "other combo" branch below is re-caught by this
      // same capture listener (metaDown is still true) → re-dispatched → INFINITE
      // RECURSION → "RangeError: Maximum call stack size exceeded", which also blew up
      // the concurrent clipboard handlers (the IronError clipboard failures). Real key
      // presses are trusted; our synthetic re-dispatches are not — and they still reach
      // the component's own (bubble-phase) key listener to be forwarded to the server.
      if (!e.isTrusted) return;
      if (!focused()) return;
      // SELF-HEAL a stuck ⌘ state. metaDown is otherwise only cleared on the ⌘ keyup or
      // on blur — but macOS input-source switching (⌘+Space and friends) is consumed by
      // the OS, which routinely SWALLOWS the ⌘ keyup. Switching layouts doesn't blur the
      // window either, so metaDown would stay stuck true forever and every subsequent
      // keystroke (e.g. a Ukrainian letter) gets mis-routed through the ⌘→Ctrl scancode
      // remap below → the server applies its own (US) layout → wrong characters. The OS
      // sets e.metaKey accurately on every real event, so if it says ⌘ is up while our
      // flag says down, trust the OS and reset (also releases any held synthetic Ctrl).
      if (!isMeta(e.code) && !e.metaKey && (metaDown || ctrlHeld)) reset();
      // Swallow the ⌘ key itself so it never reaches the server as the Win key.
      if (isMeta(e.code)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        metaDown = true;
        pushLocal();                 // pre-stage the Mac clipboard for a paste
        void flushRemoteClipboard(); // and flush any pending server→Mac pull
        return;
      }
      if (!metaDown && !e.metaKey) return;       // only ⌘+key combos below
      const k = e.key.toLowerCase();
      const ui = uiRef.current;
      if (k === 'c') {
        // server COPY (direct, bypasses focus gate) → then pull the server clipboard
        // into the Mac clipboard once the CLIPRDR round-trip lands.
        e.preventDefault();
        e.stopImmediatePropagation();
        releaseCtrl();
        ui?.ctrlC?.();
        remotePullPendingRef.current = true;
        setTimeout(() => void flushRemoteClipboard(), 300);
        return;
      }
      if (k === 'v') {
        // push the freshest Mac clipboard, then server PASTE (small delay so the
        // CLIPRDR format-data round-trip reaches the server before Ctrl+V fires).
        e.preventDefault();
        e.stopImmediatePropagation();
        releaseCtrl();
        pushLocal();
        setTimeout(() => ui?.ctrlV?.(), 140);
        return;
      }
      // Other ⌘+letter (a/x/z/…): best-effort Ctrl+letter via a held synthetic Ctrl.
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!ctrlHeld) { ctrlHeld = true; synthCtrl('keydown'); }
      window.dispatchEvent(new KeyboardEvent('keydown', { code: e.code, key: e.key, ctrlKey: true, bubbles: true, cancelable: true }));
    };
    const onUp = (e: KeyboardEvent) => {
      if (!e.isTrusted) return;
      if (isMeta(e.code)) reset();
    };
    window.addEventListener('keydown', onDown, true);
    window.addEventListener('keyup', onUp, true);
    window.addEventListener('blur', reset);
    document.addEventListener('visibilitychange', reset);
    return () => {
      window.removeEventListener('keydown', onDown, true);
      window.removeEventListener('keyup', onUp, true);
      window.removeEventListener('blur', reset);
      document.removeEventListener('visibilitychange', reset);
      releaseCtrl();
    };
  }, [phase]);

  /* ─── Heal a stranded Shift ────────────────────────────────────────────────────
   * macOS eats the keyUP when the OS grabs a shortcut (⌘⇧5 screenshot…), leaving Shift
   * "down" on the server. Releasing on blur/focus doesn't work (the component's focus
   * gate is closed while unfocused). The reliable moment is the NEXT real keystroke —
   * the user is typing, so the canvas is focused and the gate is open. On a real,
   * non-⌘ keystroke, if the OS says Shift is UP, force-release it (a keyup for an
   * already-up key is a no-op). SCOPED TO SHIFT and SKIPPED while ⌘ is held: the Mac
   * ⌘ effect above owns Ctrl/⌘ (its ⌘C/⌘V remap uses a synthetic Ctrl), so touching
   * those here previously broke ⌘V paste. `e.shiftKey` is the OS's accurate live
   * state, so we never release Shift while the user is genuinely holding it. */
  useEffect(() => {
    if (phase !== 'connected') return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.isTrusted || e.metaKey) return;                 // ignore synthetic + any ⌘-combo
      if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') return; // Shift being pressed now
      if (!e.shiftKey) {
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'ShiftLeft', key: 'Shift', bubbles: true, cancelable: true }));
        window.dispatchEvent(new KeyboardEvent('keyup', { code: 'ShiftRight', key: 'Shift', bubbles: true, cancelable: true }));
      }
    };
    window.addEventListener('keydown', onKeyDown, true); // capture: run before the component forwards the key
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [phase]);

  // Dynamic resolution — match the remote desktop to the browser window and re-negotiate
  // it (DisplayControl channel, ui.resize) whenever the window settles after a resize,
  // like the native RDP client. DEBOUNCED so the legacy-bitmap codec redraws once per
  // settle, not continuously (continuous per-pixel resize was the earlier tear cause);
  // scale='full' keeps the canvas CSS-stretched for instant feedback until the crisp
  // reflow lands ~350ms after the window stops moving.
  //
  // HD caveat: the server clamps a 2×-density framebuffer to its own max area, which
  // pins the resolution so the picture merely CSS-stretches instead of re-fitting the
  // window. computeTarget() never requests more pixels than the server granted at
  // connect (grantedRef) — it trades density for a correctly-shaped, re-fitting picture.
  useEffect(() => {
    if (phase !== 'connected') return;
    try {
      uiRef.current?.setScale(SCALE.FULL);
    } catch {
      /* noop */
    }
    const computeTarget = () => {
      const iw = window.innerWidth;
      const ih = window.innerHeight;
      // Re-read the factor each time: devicePixelRatio changes when the window moves to a
      // display with a different density. 1 in standard mode, up to 2 in HD on Retina.
      let f = dprFactor();
      const g = grantedRef.current;
      if (f > 1 && g) {
        // Bound HD to the area the server proved it accepts (its connect-time grant),
        // keeping the window's aspect ratio. Below that ceiling f stays at full density.
        const fit = Math.sqrt((g.w * g.h) / (iw * ih));
        if (fit < f) f = Math.max(1, fit);
      }
      const w = align4(iw * f);
      const h = align4(ih * f);
      // 3rd arg is DesktopScaleFactor in PERCENT (valid 100–500, NOT a 1.0 multiplier —
      // passing 1 throws "out of range"). Match the density we actually render at.
      const scale = Math.min(500, Math.max(100, Math.round(f * 100)));
      return { w, h, scale };
    };
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Seed from the framebuffer we're actually showing (the server's grant) so the first
    // aspect-changing resize corrects it — even a small one.
    let last: { w: number; h: number };
    const g0 = grantedRef.current;
    if (g0) {
      last = { w: g0.w, h: g0.h };
    } else {
      const t = computeTarget();
      last = { w: t.w, h: t.h };
    }
    const applyResize = () => {
      const next = computeTarget();
      if (next.w === last.w && next.h === last.h) return; // no real change
      last = { w: next.w, h: next.h };
      try {
        uiRef.current?.resize(next.w, next.h, next.scale);
      } catch {
        /* noop */
      }
    };
    const onResize = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(applyResize, 350);
    };
    window.addEventListener('resize', onResize);
    document.addEventListener('fullscreenchange', onResize);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener('resize', onResize);
      document.removeEventListener('fullscreenchange', onResize);
    };
  }, [phase]);

  // Pin the remote <canvas> to the window's CSS size. Our debounced ui.resize() drives a
  // DisplayControl reactivation that swaps the canvas BACKING STORE (set_width) underneath
  // the web component, but the component does not re-apply the CSS downscale afterwards — so
  // on a Retina display the canvas renders at its intrinsic 2× pixel size and overflows the
  // window ("the picture zooms in"). Forcing the canvas to fill the window makes the browser
  // downscale the high-density buffer by devicePixelRatio: crisp AND correctly fit. Verified
  // live: without this, after a resize css==fb (e.g. 1976px) while the window is 1190px.
  useEffect(() => {
    if (phase !== 'connected') return;
    const root = elRef.current?.shadowRoot;
    if (!root) return;
    const fit = () => {
      const canvas = root.querySelector('canvas') as HTMLCanvasElement | null;
      if (!canvas) return;
      const w = `${window.innerWidth}px`;
      const h = `${window.innerHeight}px`;
      // The component sizes the canvas's WRAPPER (not the canvas's own inline style) to a
      // fit-box that goes stale after a reactivation; pin it to the window so nothing clips.
      const wrap = canvas.parentElement;
      if (wrap && (wrap.style.width !== w || wrap.style.height !== h)) {
        wrap.style.setProperty('width', w, 'important');
        wrap.style.setProperty('height', h, 'important');
        wrap.style.setProperty('max-width', w, 'important');
        wrap.style.setProperty('max-height', h, 'important');
        wrap.style.setProperty('min-width', '0', 'important');
        wrap.style.setProperty('min-height', '0', 'important');
      }
      if (canvas.style.width !== '100%' || canvas.style.height !== '100%') {
        canvas.style.setProperty('width', '100%', 'important');
        canvas.style.setProperty('height', '100%', 'important');
      }
    };
    // Re-fit whenever the backing store changes (reactivation), the canvas node is replaced,
    // or the wrapper is re-sized by the component. The diff-guard above stops a set→observe
    // feedback loop. Also re-fit on window resize, ahead of the debounced reactivation.
    const observer = new MutationObserver(fit);
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['width', 'height', 'style'] });
    window.addEventListener('resize', fit);
    fit();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', fit);
    };
  }, [phase]);

  // Bidirectional file transfer via drag & drop onto the canvas.
  const onDragOver = (e: React.DragEvent) => {
    if (phase !== 'connected' || !fileProviderRef.current || !fileClipboardRef.current) return;
    e.preventDefault();
    try {
      fileProviderRef.current.handleDragOver(e.nativeEvent);
    } catch {
      /* noop */
    }
    if (!dragOver) setDragOver(true);
  };
  const onDragLeave = (e: React.DragEvent) => {
    // Only clear when the pointer actually leaves the frame (not on child enter).
    if (e.relatedTarget && (e.currentTarget as Node).contains(e.relatedTarget as Node)) return;
    setDragOver(false);
  };
  const onDrop = async (e: React.DragEvent) => {
    setDragOver(false);
    const provider = fileProviderRef.current;
    if (phase !== 'connected' || !provider || !fileClipboardRef.current) return;
    e.preventDefault();
    try {
      const files = await provider.handleDrop(e.nativeEvent);
      if (files.length) {
        provider.uploadFiles(files);
        // Suppress our local→remote clipboard pushes for a short window so they don't
        // overwrite the file FormatList before the user pastes it on the server.
        clobberUntilRef.current = Date.now() + 8000;
        // CLIPRDR file copy: the file now sits on the remote clipboard. The user must
        // click into a Windows folder / the Desktop and press Ctrl+V to drop it there
        // (plain RDP without a server agent can't auto-place it). Keep the hint up
        // longer since they have to switch focus before pasting.
        flash(t('fileUploadHint'), 13_000);
      }
    } catch {
      /* noop */
    }
  };

  // File-picker upload (the pill button): same destination as drag & drop — the files
  // land on the SERVER's clipboard, ready to paste (Ctrl+V) into a Windows folder there.
  // Gives a path to send files without dragging onto the canvas.
  const onFilesPicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const provider = fileProviderRef.current;
    const files = e.target.files ? Array.from(e.target.files) : [];
    e.target.value = ''; // reset so re-picking the same file fires onChange again
    if (phase !== 'connected' || !provider || !files.length) return;
    try {
      provider.uploadFiles(files);
      // Suppress our local→remote clipboard pushes briefly so they don't overwrite the
      // file FormatList before the user pastes it on the server (mirrors onDrop).
      clobberUntilRef.current = Date.now() + 8000;
      flash(t('fileUploadHint'), 13_000);
    } catch {
      /* noop */
    }
  };

  // Focus the canvas so keystrokes land + the async Clipboard API is unblocked, and
  // push the freshest Mac clipboard to the remote so a paste there is ready. Suppressed
  // briefly after a file drop so it doesn't clobber the file FormatList.
  const onCanvasEnter = () => {
    if (phase !== 'connected') return;
    try {
      elRef.current?.focus();
      if (Date.now() > clobberUntilRef.current) void Promise.resolve(uiRef.current?.sendClipboardData?.()).catch(() => {});
      // Retry a pending server→Mac pull now that the pointer (focus) is here.
      void flushRemoteClipboard();
    } catch {
      /* noop */
    }
  };

  const toolBtn = (
    onClick: () => void,
    label: string,
    icon: React.ReactNode,
    opts?: { danger?: boolean; active?: boolean; disabled?: boolean },
  ) => (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      disabled={opts?.disabled}
      className="rdp-tool"
      style={{
        color: opts?.danger ? '#f87171' : opts?.active ? 'var(--accent)' : 'var(--muted)',
        opacity: opts?.disabled ? 0.4 : 1,
        cursor: opts?.disabled ? 'default' : 'pointer',
      }}
    >
      {icon}
    </button>
  );

  const liveControls = phase === 'connected';

  return (
    // Full-viewport RDP takeover (native-client feel). The component scales the canvas
    // to window.innerWidth/Height, so the host MUST be the full window or it tears/clips.
    <div ref={frameRef} style={{ position: 'fixed', inset: 0, zIndex: 200, background: '#000' }}>
      <style>{`
        .rdp-tool { display:inline-flex; align-items:center; justify-content:center; width:32px; height:28px; border-radius:8px; background:transparent; border:1px solid transparent; transition:background .15s ease, color .15s ease; }
        .rdp-tool:hover:not(:disabled) { background:rgba(255,255,255,.08); }
        @keyframes rdp-spin { to { transform: rotate(360deg); } }
        .rdp-spin { animation: rdp-spin 1s linear infinite; }
        .rdp-bar { opacity:.4; transition:opacity .2s ease; }
        .rdp-bar:hover { opacity:1; }
      `}</style>

      {/* full-viewport canvas host + drag & drop target */}
      <div
        style={{ position: 'absolute', inset: 0 }}
        onDragOver={onDragOver}
        onDragEnter={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onPointerEnter={onCanvasEnter}
      >
        <div ref={hostRef} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />

        {/* drop-to-upload overlay */}
        {dragOver && liveControls && (
          <div
            style={{
              position: 'absolute',
              inset: 10,
              zIndex: 8,
              border: '2px dashed color-mix(in oklab, var(--accent) 70%, transparent)',
              borderRadius: 14,
              background: 'color-mix(in oklab, var(--accent) 14%, rgba(5,7,10,.55))',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
              color: '#e7e9ee',
              pointerEvents: 'none',
            }}
          >
            <Upload size={30} style={{ color: 'var(--accent)' }} />
            <div style={{ fontSize: 15, fontWeight: 640 }}>{t('dropToUpload')}</div>
          </div>
        )}

        {/* transient notice (file hints / errors) */}
        {notice && liveControls && (
          <div
            style={{
              position: 'absolute',
              top: 14,
              left: '50%',
              transform: 'translateX(-50%)',
              zIndex: 9,
              maxWidth: '80%',
              padding: '9px 15px',
              borderRadius: 10,
              background: 'rgba(5,7,10,.92)',
              border: '1px solid rgba(255,255,255,.14)',
              color: '#e7e9ee',
              fontSize: 13,
              textAlign: 'center',
              boxShadow: '0 8px 30px -10px rgba(0,0,0,.7)',
            }}
          >
            {notice}
          </div>
        )}

        {/* transfer progress chip */}
        {transfer && liveControls && (
          <div
            style={{
              position: 'absolute',
              left: 14,
              bottom: 14,
              zIndex: 8,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 9,
              padding: '8px 13px',
              borderRadius: 10,
              background: 'rgba(5,7,10,.88)',
              border: '1px solid rgba(255,255,255,.12)',
              color: '#e7e9ee',
              fontSize: 12.5,
              maxWidth: '60%',
            }}
          >
            {transfer.dir === 'up' ? (
              <Upload size={14} style={{ color: 'var(--accent)' }} />
            ) : (
              <Download size={14} style={{ color: '#10b981' }} />
            )}
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 220 }}>
              {transfer.label}
            </span>
            <span style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)', color: 'var(--muted)' }}>
              {transfer.pct}%
            </span>
          </div>
        )}

        {/* overlays */}
        {(phase === 'init' || phase === 'connecting') && (
          <div style={overlayStyle}>
            <Loader2 size={20} className="rdp-spin" />
            <span style={{ marginTop: 12 }}>{phase === 'init' ? t('initializing') : t('connecting')}</span>
          </div>
        )}
        {phase === 'error' && (
          <div style={overlayStyle}>
            <AlertTriangle size={30} style={{ color: '#f87171' }} />
            <div style={{ marginTop: 12, fontSize: 16, fontWeight: 640, color: '#e7e9ee' }}>{t('connectFailed')}</div>
            {errMsg && (
              <div style={{ marginTop: 6, fontSize: 12.5, maxWidth: 460, color: 'var(--muted)', wordBreak: 'break-word' }}>
                {errMsg}
              </div>
            )}
            <button className="btn" style={{ marginTop: 18 }} onClick={exit}>
              <RefreshCw size={15} style={{ marginRight: 6 }} /> {t('reconnect')}
            </button>
          </div>
        )}
        {phase === 'closed' && (
          <div style={overlayStyle}>
            <Power size={28} style={{ color: 'var(--muted)' }} />
            <div style={{ marginTop: 12, fontSize: 16, fontWeight: 640, color: '#e7e9ee' }}>{t('sessionEnded')}</div>
            {errMsg && <div style={{ marginTop: 6, fontSize: 12.5, color: 'var(--muted)' }}>{errMsg}</div>}
            <button className="btn" style={{ marginTop: 18 }} onClick={exit}>
              <RefreshCw size={15} style={{ marginRight: 6 }} /> {t('reconnect')}
            </button>
          </div>
        )}
      </div>

      {/* hidden file picker behind the pill's upload button → server clipboard */}
      <input ref={fileInputRef} type="file" multiple onChange={onFilesPicked} style={{ display: 'none' }} aria-hidden />

      {/* floating, draggable status pill — grab anywhere on the body to reposition;
          the disconnect button stays clickable. Position persists in localStorage. */}
      <div
        ref={pillRef}
        className="rdp-bar"
        onPointerDown={liveControls ? onPillDown : undefined}
        onPointerMove={onPillMove}
        onPointerUp={onPillUp}
        onPointerCancel={onPillUp}
        title={liveControls ? t('dragHint') : undefined}
        style={{
          position: 'absolute',
          ...(pillPos ? { left: pillPos.x, top: pillPos.y } : { top: 10, right: 10 }),
          zIndex: 12,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '5px 6px 5px 6px',
          borderRadius: 999,
          // No backdrop-filter here: a blur over the RDP canvas forces the browser
          // to re-composite the blurred layer on every canvas update; a denser
          // background keeps the pill readable at zero per-frame cost.
          background: 'rgba(5,7,10,.88)',
          border: `1px solid rgba(255,255,255,${pillDragging ? 0.22 : 0.1})`,
          boxShadow: pillDragging ? '0 10px 30px -8px rgba(0,0,0,.7)' : 'none',
          cursor: liveControls ? (pillDragging ? 'grabbing' : 'grab') : 'default',
          touchAction: 'none',
          userSelect: 'none',
          transition: 'border-color .15s ease, box-shadow .15s ease',
        }}
      >
        {liveControls && (
          <GripVertical size={14} style={{ color: 'rgba(255,255,255,.4)', flexShrink: 0 }} aria-hidden />
        )}
        {liveControls && canUpload &&
          toolBtn(
            () => fileInputRef.current?.click(),
            t('uploadFiles'),
            <Upload size={15} />,
          )}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12, fontWeight: 600, color: '#e7e9ee', maxWidth: 240, paddingLeft: liveControls ? 0 : 7 }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: liveControls ? '#10b981' : phase === 'error' ? '#f87171' : 'var(--accent)' }} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{props.serverName}</span>
        </span>
        {liveControls && canUpload &&
          toolBtn(
            toggleFileClipboard,
            t(fileClipboard ? 'fileClipOff' : 'fileClipOn'),
            <FolderSync size={15} />,
            { active: fileClipboard },
          )}
        {liveControls && dprCapable &&
          toolBtn(
            toggleHiDpi,
            t(hiDpi ? 'hiDpiOff' : 'hiDpiOn'),
            <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.05em' }}>HD</span>,
            { active: hiDpi },
          )}
        {toolBtn(exit, t('disconnect'), <Power size={15} />, { danger: true })}
      </div>
    </div>
  );
}

const overlayStyle: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  textAlign: 'center',
  padding: 24,
  color: 'var(--muted)',
  background: 'rgba(5,7,10,.72)',
  backdropFilter: 'blur(2px)',
  zIndex: 5,
};
