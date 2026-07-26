'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Power, Loader2, Maximize2, GripVertical, Upload, HardDrive, Download, X, RotateCw } from 'lucide-react';

// Anchor-download a Blob to the user's local machine (generic browser, no library).
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

// Mac ⌘ reaches Guacamole.Keyboard as the Meta/Win keysym, which does nothing on Windows;
// a capture-phase handler (below) intercepts ⌘ and sends Control (0xFFE3) + the key instead.
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '');
const CTRL_KEYSYM = 0xffe3; // Control_L

// guacd can't scale the Windows UI (no DesktopScaleFactor — unlike v1's IronRDP), so the render
// resolution alone sets BOTH sharpness and UI size: lower = bigger UI but softer, higher =
// crisper but smaller. Two modes only (no picker): normal 1× and HD 1.25×, set by the session
// page and applied on connect — see SCALE_NORMAL/SCALE_HD there.

/**
 * RDP v2 (Apache Guacamole) client. Full-viewport takeover (native-client feel) with a
 * draggable floating pill for controls, mirroring v1's RdpClient. guacd does the native
 * decode; the display is sized to the viewport × devicePixelRatio for a crisp HiDPI
 * render, then scaled to CSS size, and re-negotiated on resize/fullscreen. Mouse
 * coordinates come from getBoundingClientRect (transform/fullscreen-safe). Bidirectional
 * text clipboard + Mac ⌘→Ctrl remap are wired below; two-way file transfer is the
 * remaining parity item. The RDP password is inside the opaque `token`; it never reaches here.
 *
 * hostRef holds ONLY the manually-appended guac element (NO JSX children) — mixing
 * manual DOM with React children in one node throws removeChild on reconcile.
 */
export default function GuacamoleClient({
  tunnelUrl,
  token,
  serverName,
  scale = 1,
  hd = false,
  onToggleHd,
  onExit,
}: {
  tunnelUrl: string;
  token: string;
  serverName: string;
  scale?: number; // render multiplier for this mount (normal 1× / HD 1.25×), owned by the session page
  hd?: boolean;
  onToggleHd?: () => void;
  onExit?: () => void;
}) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const clientRef = useRef<any>(null);
  const [status, setStatus] = useState('connecting');
  const renderScaleRef = useRef(scale); // read by pushSize; fixed for this mount (scale change → remount)

  // ── two-way file transfer (RDP drive redirection). Functions that need the guac client +
  // the dynamically-imported Guacamole namespace are built inside the effect and exposed here. ──
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const fsObjectRef = useRef<any>(null); // the redirected-drive Guacamole.Object
  const uploadFilesRef = useRef<((files: File[]) => void) | null>(null);
  const browseRef = useRef<(() => void) | null>(null);
  const downloadRef = useRef<((path: string, name: string) => void) | null>(null);
  const [transfer, setTransfer] = useState<{ dir: 'up' | 'down'; name: string; pct: number | null } | null>(null);
  const [filesOpen, setFilesOpen] = useState(false);
  const [fileList, setFileList] = useState<Array<{ path: string; name: string; dir: boolean }> | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0); // enter/leave bubble through child elements — count depth, not target identity
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flash = useCallback((msg: string, ms = 7000) => {
    setNotice(msg);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), ms);
  }, []);

  // ── guac connection ──────────────────────────────────────────────────────────
  useEffect(() => {
    let disposed = false;
    let client: any = null;
    let keyboard: any = null;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const cleanups: Array<() => void> = [];

    (async () => {
      const Guacamole = (await import('guacamole-common-js')).default as any;
      if (disposed || !hostRef.current) return;

      const tunnel = new Guacamole.WebSocketTunnel(tunnelUrl.replace(/\/$/, '') + '/');
      client = new Guacamole.Client(tunnel);
      clientRef.current = client;

      const display = client.getDisplay();
      const el = display.getElement();
      while (hostRef.current.firstChild) hostRef.current.removeChild(hostRef.current.firstChild);
      hostRef.current.appendChild(el);
      el.style.transformOrigin = '0 0'; // scale from top-left so it aligns with the sized host

      // Ask guacd to render at the frame's CSS size × the current render scale (1 normally,
      // HD_SCALE in HD mode). No ×dpr: guacd can't scale the Windows UI, so full HiDPI would
      // make everything tiny. Debounced by callers.
      const pushSize = () => {
        const box = frameRef.current;
        if (!box) return;
        const s = renderScaleRef.current;
        try { client.sendSize(Math.max(640, Math.round(box.clientWidth * s)), Math.max(480, Math.round(box.clientHeight * s))); } catch { /* noop */ }
      };
      // Fit the rendered display into the frame. display.scale() is a CSS transform, so
      // the element's LAYOUT box stays at full remote resolution — the host must be sized
      // to the SCALED box, else the centering flex parent offsets/clips it. That mismatch
      // is what looked "broken" on entry until a fullscreen toggle forced a re-fit.
      const fit = () => {
        const box = frameRef.current, host = hostRef.current;
        const w = display.getWidth(), h = display.getHeight();
        if (!box || !host || !w || !h) return;
        const fitScale = Math.min(box.clientWidth / w, box.clientHeight / h);
        display.scale(fitScale);
        host.style.width = Math.floor(w * fitScale) + 'px';
        host.style.height = Math.floor(h * fitScale) + 'px';
      };

      // Re-negotiate size a few times over the first ~2.5s after connect. guacd's
      // display-update resize and the browser's final layout/DPR settle a beat late, so a
      // single push at 'connected' can leave the remote at guacd's default resolution
      // (soft, less content on screen) until something forces a re-fit — which is why a
      // fullscreen toggle "fixed" it. Repeated pushes converge on the correct size
      // automatically; sendSize is a no-op once the remote already matches, so no flicker.
      const settle = () => { pushSize(); requestAnimationFrame(fit); };
      const settleTimers: Array<ReturnType<typeof setTimeout>> = [];
      cleanups.push(() => settleTimers.forEach(clearTimeout));

      const STATES = ['idle', 'connecting', 'waiting', 'connected', 'disconnecting', 'disconnected'];
      client.onstatechange = (s: number) => {
        const name = STATES[s] ?? String(s);
        setStatus(name);
        if (name === 'connected') {
          settleTimers.forEach(clearTimeout);
          settleTimers.length = 0;
          [0, 150, 400, 800, 1500, 2500].forEach((ms) => settleTimers.push(setTimeout(settle, ms)));
        }
      };
      client.onerror = () => setStatus('error');
      tunnel.onerror = () => setStatus('tunnel-error');

      display.onresize = fit;

      // Mouse via getBoundingClientRect (transform/fullscreen-safe) → remote pixels.
      el.style.cursor = 'none';
      const btn = { left: false, middle: false, right: false, up: false, down: false };
      const remoteXY = (clientX: number, clientY: number) => {
        const rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height) return { x: 0, y: 0 };
        return {
          x: Math.round(((clientX - rect.left) / rect.width) * display.getWidth()),
          y: Math.round(((clientY - rect.top) / rect.height) * display.getHeight()),
        };
      };
      const sendAt = (clientX: number, clientY: number) => {
        const { x, y } = remoteXY(clientX, clientY);
        client.sendMouseState(new Guacamole.Mouse.State({ x, y, ...btn }));
      };
      const BTN: Record<number, 'left' | 'middle' | 'right'> = { 0: 'left', 1: 'middle', 2: 'right' };
      const onMove = (e: MouseEvent) => sendAt(e.clientX, e.clientY);
      const onDown = (e: MouseEvent) => { const b = BTN[e.button]; if (b) btn[b] = true; sendAt(e.clientX, e.clientY); };
      const onUp = (e: MouseEvent) => { const b = BTN[e.button]; if (b) btn[b] = false; sendAt(e.clientX, e.clientY); };
      const onCtx = (e: Event) => e.preventDefault();
      const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        const { x, y } = remoteXY(e.clientX, e.clientY);
        const dir = e.deltaY < 0 ? 'up' : 'down';
        client.sendMouseState(new Guacamole.Mouse.State({ x, y, ...btn, [dir]: true }));
        client.sendMouseState(new Guacamole.Mouse.State({ x, y, ...btn, [dir]: false }));
      };
      el.addEventListener('mousemove', onMove);
      el.addEventListener('mousedown', onDown);
      el.addEventListener('mouseup', onUp);
      el.addEventListener('contextmenu', onCtx);
      el.addEventListener('wheel', onWheel, { passive: false });
      cleanups.push(() => {
        el.removeEventListener('mousemove', onMove);
        el.removeEventListener('mousedown', onDown);
        el.removeEventListener('mouseup', onUp);
        el.removeEventListener('contextmenu', onCtx);
        el.removeEventListener('wheel', onWheel);
      });

      // Bidirectional text clipboard. Remote→local: guacd streams the server clipboard via
      // onclipboard → write it to navigator.clipboard (StringReader does NOT auto-ack — ack
      // manually). Local→remote: push navigator.clipboard to the server on focus / canvas-enter
      // / ⌘-down (gated by focus + the clipboard-read grant), so a following ⌘V pastes it.
      let lastClip = '';
      client.onclipboard = (stream: any, mimetype: string) => {
        if (typeof mimetype !== 'string' || mimetype.indexOf('text/') !== 0) { try { stream.sendAck('Unsupported', 0x030f); } catch { /* noop */ } return; }
        const reader = new Guacamole.StringReader(stream);
        let data = '';
        reader.ontext = (text: string) => { data += text; try { stream.sendAck('OK', 0x0000); } catch { /* noop */ } };
        reader.onend = () => { lastClip = data; try { void navigator.clipboard?.writeText(data); } catch { /* noop */ } };
      };
      const pushLocalClip = async () => {
        try {
          if (!navigator.clipboard?.readText) return;
          const text = await navigator.clipboard.readText();
          if (text === lastClip) return; // don't echo what we just pulled, or re-push unchanged text
          lastClip = text;
          const s = client.createClipboardStream('text/plain');
          const w = new Guacamole.StringWriter(s);
          w.sendText(text); w.sendEnd();
        } catch { /* no focus / no permission / empty — best effort */ }
      };
      const onFocusClip = () => void pushLocalClip();
      window.addEventListener('focus', onFocusClip);
      el.addEventListener('mouseenter', onFocusClip);
      cleanups.push(() => window.removeEventListener('focus', onFocusClip));
      cleanups.push(() => el.removeEventListener('mouseenter', onFocusClip));

      // Standard keyboard: Guacamole.Keyboard maps browser keys → X11 keysyms → guacd. On
      // non-Mac, Ctrl/Alt/Shift pass through natively. reset() on blur/hidden clears any key
      // the OS left held.
      keyboard = new Guacamole.Keyboard(document);
      keyboard.onkeydown = (k: number) => client.sendKeyEvent(1, k);
      keyboard.onkeyup = (k: number) => client.sendKeyEvent(0, k);
      const releaseAll = () => { try { keyboard.reset(); } catch { /* noop */ } };
      const onVis = () => { if (document.hidden) releaseAll(); };
      window.addEventListener('blur', releaseAll);
      document.addEventListener('visibilitychange', onVis);
      cleanups.push(() => window.removeEventListener('blur', releaseAll));
      cleanups.push(() => document.removeEventListener('visibilitychange', onVis));

      // Mac ⌘→Ctrl: Guacamole.Keyboard forwards ⌘ as the Meta/Win keysym and its deferred-Meta
      // heuristic drops many ⌘ combos, so ⌘A/⌘Z/⌘X/⌘S do nothing on Windows. Intercept ⌘ in the
      // CAPTURE phase on window (before Guacamole's document listener), stop it reaching
      // Guacamole, and drive Ctrl+<key> straight to guacd. ⌘C/⌘V ride the same path (Ctrl+C/V),
      // with ⌘V first syncing the local clipboard to the server so the paste has the text.
      if (IS_MAC) {
        let metaDown = false;
        const isMetaCode = (c: string) => c === 'MetaLeft' || c === 'MetaRight';
        const isModifierCode = (c: string) => c === 'ShiftLeft' || c === 'ShiftRight' || c === 'AltLeft' || c === 'AltRight' || c === 'ControlLeft' || c === 'ControlRight';
        const pressCtrl = () => { if (!metaDown) { metaDown = true; try { client.sendKeyEvent(1, CTRL_KEYSYM); } catch { /* noop */ } } };
        const releaseCtrl = () => { if (metaDown) { metaDown = false; try { client.sendKeyEvent(0, CTRL_KEYSYM); } catch { /* noop */ } } };
        const NAMED: Record<string, number> = { ArrowLeft: 0xff51, ArrowUp: 0xff52, ArrowRight: 0xff53, ArrowDown: 0xff54, Backspace: 0xff08, Delete: 0xffff, Enter: 0xff0d, Tab: 0xff09, Escape: 0xff1b, Home: 0xff50, End: 0xff57 };
        const keysymForKey = (e: KeyboardEvent): number => {
          if (e.key && e.key.length === 1) { const c = e.key.toLowerCase().charCodeAt(0); return c >= 0x20 && c <= 0x7e ? c : 0; }
          return NAMED[e.key] ?? 0;
        };
        const tap = (ks: number) => { try { client.sendKeyEvent(1, ks); client.sendKeyEvent(0, ks); } catch { /* noop */ } };
        const onKeyDownCap = (e: KeyboardEvent) => {
          if (!e.isTrusted) return;
          if (metaDown && !e.metaKey && !isMetaCode(e.code)) releaseCtrl(); // self-heal a ⌘ whose keyup was swallowed (⌘Space)
          if (isMetaCode(e.code)) { e.preventDefault(); e.stopImmediatePropagation(); pressCtrl(); void pushLocalClip(); return; }
          if (metaDown || e.metaKey) {
            e.preventDefault(); e.stopImmediatePropagation();
            // Swallow Shift/Alt/Ctrl while ⌘ is held (else Guacamole leaks Meta/Win to the
            // remote); re-synthesize them around the tap from the event's live modifier flags.
            if (isModifierCode(e.code)) return;
            pressCtrl();
            const ks = keysymForKey(e);
            if (!ks) return;
            const mods: number[] = [];
            if (e.shiftKey) mods.push(0xffe1); // Shift_L
            if (e.altKey) mods.push(0xffe9);   // Alt_L
            const send = () => {
              for (const m of mods) { try { client.sendKeyEvent(1, m); } catch { /* noop */ } }
              tap(ks);
              for (let i = mods.length - 1; i >= 0; i--) { try { client.sendKeyEvent(0, mods[i]); } catch { /* noop */ } }
            };
            if ((e.key || '').toLowerCase() === 'v') {
              void pushLocalClip().finally(() => setTimeout(send, 60)); // ensure local clip reached the server, then paste
            } else {
              send();
            }
          }
        };
        const onKeyUpCap = (e: KeyboardEvent) => {
          if (!e.isTrusted) return;
          if (isMetaCode(e.code)) { e.preventDefault(); e.stopImmediatePropagation(); releaseCtrl(); }
        };
        window.addEventListener('keydown', onKeyDownCap, true);
        window.addEventListener('keyup', onKeyUpCap, true);
        window.addEventListener('blur', releaseCtrl);
        cleanups.push(() => window.removeEventListener('keydown', onKeyDownCap, true));
        cleanups.push(() => window.removeEventListener('keyup', onKeyUpCap, true));
        cleanups.push(() => window.removeEventListener('blur', releaseCtrl));
      }

      const onWinResize = () => { fit(); if (resizeTimer) clearTimeout(resizeTimer); resizeTimer = setTimeout(pushSize, 250); };
      const onFsChange = () => { pushSize(); requestAnimationFrame(fit); };
      window.addEventListener('resize', onWinResize);
      document.addEventListener('fullscreenchange', onFsChange);
      cleanups.push(() => window.removeEventListener('resize', onWinResize));
      cleanups.push(() => document.removeEventListener('fullscreenchange', onFsChange));

      // Catch the initial layout settle + any frame size change, uniformly re-fitting
      // without waiting for a manual fullscreen toggle. fit() is cheap (local rescale);
      // the remote renegotiation (pushSize) stays debounced.
      const ro = new ResizeObserver(() => { fit(); if (resizeTimer) clearTimeout(resizeTimer); resizeTimer = setTimeout(pushSize, 250); });
      if (frameRef.current) ro.observe(frameRef.current);
      cleanups.push(() => ro.disconnect());

      // ── two-way file transfer via RDP drive redirection (the "Garely" drive) ──
      const STREAM_INDEX_MIME = 'application/vnd.glyptodon.guacamole.stream-index+json';
      // guacd hands us the redirected drive as a filesystem Object; keep it for browse/download.
      client.onfilesystem = (object: any) => { fsObjectRef.current = object; };
      // Server-pushed file (rare) → save it locally.
      client.onfile = (stream: any, mimetype: string, filename: string) => {
        try {
          const reader = new Guacamole.BlobReader(stream, mimetype || 'application/octet-stream');
          setTransfer({ dir: 'down', name: filename, pct: null });
          reader.onend = () => { saveBlob(reader.getBlob(), filename); setTransfer(null); };
        } catch { setTransfer(null); }
      };
      // Local → server: stream each File to the drive via a "file" output stream (BlobWriter
      // has built-in ack back-pressure; call sendEnd on complete).
      // Upload files SEQUENTIALLY (a queue): one BlobWriter at a time keeps the single
      // `transfer` indicator accurate — concurrent writers would overwrite each other's
      // progress and the first completion would hide the pill while others were still going.
      uploadFilesRef.current = (files: File[]) => {
        const queue = [...files];
        const total = queue.length;
        let index = 0;
        const next = () => {
          const f = queue.shift();
          if (!f) { setTransfer(null); return; }
          index += 1;
          const label = total > 1 ? `${f.name} (${index}/${total})` : f.name;
          let done = false;
          const advance = () => { if (done) return; done = true; next(); };
          try {
            const stream = client.createFileStream(f.type || 'application/octet-stream', f.name);
            const writer = new Guacamole.BlobWriter(stream);
            setTransfer({ dir: 'up', name: label, pct: 0 });
            writer.onprogress = (_blob: Blob, offset: number) => setTransfer({ dir: 'up', name: label, pct: Math.min(100, Math.round((offset / Math.max(1, f.size)) * 100)) });
            writer.oncomplete = () => { try { writer.sendEnd(); } catch { /* noop */ } advance(); };
            // BlobWriter only fires onerror on a LOCAL read failure; a guacd rejection (drive
            // full / read-only) surfaces ONLY via onack with an error status — without this the
            // upload would stall forever and leak a half-open stream.
            writer.onack = (status: any) => { if (status?.isError?.()) { try { writer.sendEnd(); } catch { /* noop */ } flash('Не вдалося надіслати файл (диск сервера недоступний або переповнений).'); advance(); } };
            writer.onerror = () => { try { stream.sendEnd(); } catch { /* noop */ } flash('Не вдалося надіслати файл.'); advance(); };
            writer.sendBlob(f);
          } catch { advance(); }
        };
        next();
      };
      // List the drive root (a JSON stream-index of { path: mimetype }).
      browseRef.current = () => {
        const obj = fsObjectRef.current;
        if (!obj) { setFileList([]); return; }
        setFileList(null);
        obj.requestInputStream(Guacamole.Object.ROOT_STREAM, (stream: any, mimetype: string) => {
          if (mimetype !== STREAM_INDEX_MIME) { try { stream.sendAck('Unexpected', 0x030f); } catch { /* noop */ } setFileList([]); return; }
          const reader = new Guacamole.StringReader(stream);
          let json = '';
          reader.ontext = (t: string) => { json += t; try { stream.sendAck('OK', 0x0000); } catch { /* noop */ } };
          reader.onend = () => {
            try {
              const entries = JSON.parse(json) as Record<string, string>;
              const list = Object.keys(entries).map((path) => ({ path, name: path.replace(/^.*\//, ''), dir: entries[path] === STREAM_INDEX_MIME }));
              list.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
              setFileList(list);
            } catch { setFileList([]); }
          };
        });
      };
      // Server → local: read a named stream to a Blob (BlobReader auto-acks) and save it.
      downloadRef.current = (path: string, name: string) => {
        const obj = fsObjectRef.current;
        if (!obj) return;
        obj.requestInputStream(path, (stream: any, mimetype: string) => {
          try {
            const reader = new Guacamole.BlobReader(stream, mimetype || 'application/octet-stream');
            setTransfer({ dir: 'down', name, pct: null });
            reader.onend = () => { saveBlob(reader.getBlob(), name); setTransfer(null); };
          } catch { setTransfer(null); }
        });
      };

      client.connect('token=' + encodeURIComponent(token));
    })().catch(() => setStatus('error'));

    return () => {
      disposed = true;
      if (resizeTimer) clearTimeout(resizeTimer);
      cleanups.forEach((c) => c());
      try { keyboard?.reset(); } catch { /* noop */ }
      try { client?.disconnect(); } catch { /* noop */ }
    };
  }, [tunnelUrl, token]);

  const connected = status === 'connected';
  const dead = status === 'disconnected' || status === 'error' || status === 'tunnel-error';

  // Keepalive: a backgrounded tab is frozen after ~5 min, killing the tunnel WebSocket. A tab
  // playing audio is exempt, so run one inaudible oscillator for the life of the session.
  useEffect(() => {
    if (!connected) return;
    let ctx: AudioContext | null = null;
    let osc: OscillatorNode | null = null;
    try {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      const gain = ctx.createGain(); gain.gain.value = 0.0015; // effectively silent, non-zero → tab counts as audible
      osc = ctx.createOscillator(); osc.frequency.value = 30;  // sub-audible
      osc.connect(gain).connect(ctx.destination); osc.start();
      if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
      const resume = () => { if (ctx && ctx.state === 'suspended') void ctx.resume().catch(() => {}); };
      document.addEventListener('visibilitychange', resume);
      return () => {
        document.removeEventListener('visibilitychange', resume);
        try { osc?.stop(); } catch { /* noop */ }
        try { void ctx?.close(); } catch { /* noop */ }
      };
    } catch { /* AudioContext blocked — session still works, just not freeze-proof */ }
  }, [connected]);

  // ── draggable floating pill (mirrors v1 RdpClient) ────────────────────────────
  const PILL_KEY = 'garely-guac-pill-pos';
  const pillRef = useRef<HTMLDivElement | null>(null);
  const pillDrag = useRef<{ id: number; sx: number; sy: number; ox: number; oy: number } | null>(null);
  const [pillPos, setPillPos] = useState<{ x: number; y: number } | null>(null);
  const [pillDragging, setPillDragging] = useState(false);
  const clampPill = useCallback((x: number, y: number) => {
    const w = pillRef.current?.offsetWidth ?? 200;
    const h = pillRef.current?.offsetHeight ?? 38;
    const m = 8;
    return {
      x: Math.min(Math.max(m, x), Math.max(m, window.innerWidth - w - m)),
      y: Math.min(Math.max(m, y), Math.max(m, window.innerHeight - h - m)),
    };
  }, []);
  useEffect(() => {
    if (!connected) return;
    try {
      const raw = localStorage.getItem(PILL_KEY);
      const p = raw ? JSON.parse(raw) : null;
      if (p && typeof p.x === 'number' && typeof p.y === 'number') {
        requestAnimationFrame(() => setPillPos(clampPill(p.x, p.y)));
      }
    } catch { /* ignore */ }
    const onResize = () => setPillPos((prev) => (prev ? clampPill(prev.x, prev.y) : prev));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [connected, clampPill]);
  const onPillDown = useCallback((e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return; // let control clicks through
    const el = pillRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    pillDrag.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top };
    setPillPos({ x: r.left, y: r.top });
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
      if (prev) { try { localStorage.setItem(PILL_KEY, JSON.stringify(prev)); } catch { /* noop */ } }
      return prev;
    });
  }, []);

  const goFullscreen = () => {
    const box = frameRef.current;
    if (!box) return;
    if (document.fullscreenElement) void document.exitFullscreen?.();
    else void box.requestFullscreen?.();
  };
  const exit = () => { try { clientRef.current?.disconnect(); } catch { /* noop */ } onExit?.(); };

  const doUpload = (files: File[]) => {
    if (!files.length) return;
    if (!uploadFilesRef.current) { flash('Сесія ще не готова — спробуй за мить.'); return; }
    uploadFilesRef.current(files);
    flash('Файли надсилаються на диск «Garely». Відкрий диск «Garely» у Провіднику Windows, щоб дістати їх.', 10000);
  };
  const toggleFiles = () => setFilesOpen((o) => { const n = !o; if (n) browseRef.current?.(); return n; });

  const toolBtn = (onClick: () => void, label: string, icon: React.ReactNode, opts?: { danger?: boolean; active?: boolean }) => (
    <button
      type="button" onClick={onClick} title={label} aria-label={label} className="gc-tool"
      style={{ color: opts?.danger ? '#f87171' : opts?.active ? 'var(--accent)' : 'var(--muted)', background: 'none', border: 'none', cursor: 'pointer', display: 'inline-flex', padding: 6, borderRadius: 8 }}
    >
      {icon}
    </button>
  );

  return (
    <div
      ref={frameRef}
      style={{ position: 'fixed', inset: 0, zIndex: 200, background: '#000' }}
      onDragEnter={(e) => { e.preventDefault(); dragDepth.current += 1; setDragOver(true); }}
      onDragOver={(e) => { e.preventDefault(); }}
      onDragLeave={(e) => { e.preventDefault(); dragDepth.current = Math.max(0, dragDepth.current - 1); if (dragDepth.current === 0) setDragOver(false); }}
      onDrop={(e) => { e.preventDefault(); dragDepth.current = 0; setDragOver(false); doUpload(Array.from(e.dataTransfer?.files || [])); }}
    >
      <style>{`
        @keyframes gc-spin { to { transform: rotate(360deg); } }
        .gc-spin { animation: gc-spin 1s linear infinite; }
        .gc-tool:hover { background: rgba(255,255,255,.08) !important; color: #e7e9ee !important; }
        @media (prefers-reduced-motion: reduce) { .gc-spin { animation: none; } }
      `}</style>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        onChange={(e) => { const files = e.target.files ? Array.from(e.target.files) : []; e.target.value = ''; doUpload(files); }}
        style={{ display: 'none' }}
        aria-hidden
      />

      {/* display fills the viewport; hostRef holds ONLY the guac element */}
      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        <div ref={hostRef} tabIndex={0} style={{ outline: 'none', overflow: 'hidden' }} />
      </div>

      {dragOver && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 25, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(4,7,12,.62)', border: '3px dashed rgba(255,255,255,.35)', color: '#fff', fontSize: 16, fontWeight: 600, pointerEvents: 'none', textAlign: 'center', padding: 24 }}>
          Відпусти, щоб надіслати файли на диск «Garely»
        </div>
      )}

      {transfer && (
        <div style={{ position: 'absolute', left: 12, bottom: 12, zIndex: 22, display: 'flex', alignItems: 'center', gap: 9, padding: '8px 13px', borderRadius: 999, background: 'rgba(5,7,10,.92)', border: '1px solid rgba(255,255,255,.1)', color: '#e7e9ee', fontSize: 12 }}>
          {transfer.dir === 'up' ? <Upload size={14} /> : <Download size={14} />}
          <span style={{ maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{transfer.name}</span>
          {transfer.pct !== null ? <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{transfer.pct}%</strong> : <Loader2 size={13} className="gc-spin" />}
        </div>
      )}

      {notice && (
        <div style={{ position: 'absolute', left: '50%', bottom: 16, transform: 'translateX(-50%)', zIndex: 22, maxWidth: 'min(560px, 92vw)', padding: '9px 14px', borderRadius: 10, background: 'rgba(5,7,10,.94)', border: '1px solid rgba(255,255,255,.12)', color: '#e7e9ee', fontSize: 12.5, textAlign: 'center', lineHeight: 1.4 }}>
          {notice}
        </div>
      )}

      {filesOpen && (
        <div style={{ position: 'absolute', top: 64, left: '50%', transform: 'translateX(-50%)', zIndex: 24, width: 'min(460px, 92vw)', maxHeight: '62vh', display: 'flex', flexDirection: 'column', background: 'rgba(10,13,18,.97)', border: '1px solid rgba(255,255,255,.12)', borderRadius: 14, boxShadow: '0 24px 70px -22px rgba(0,0,0,.85)', color: '#e7e9ee', overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px', borderBottom: '1px solid rgba(255,255,255,.08)' }}>
            <HardDrive size={15} /> <strong style={{ fontSize: 13 }}>Диск «Garely»</strong>
            <span style={{ flex: 1 }} />
            <button type="button" className="gc-tool" style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 6, borderRadius: 8, display: 'inline-flex' }} onClick={() => browseRef.current?.()} title="Оновити"><RotateCw size={14} /></button>
            <button type="button" className="gc-tool" style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 6, borderRadius: 8, display: 'inline-flex' }} onClick={() => setFilesOpen(false)} title="Закрити"><X size={15} /></button>
          </div>
          <div style={{ padding: '8px 12px', fontSize: 11.5, color: 'var(--muted)', borderBottom: '1px solid rgba(255,255,255,.06)' }}>
            Щоб забрати файл із сервера — скопіюй його на диск «Garely» у Провіднику Windows, тоді натисни <RotateCw size={11} style={{ verticalAlign: '-1px' }} /> і завантаж тут.
          </div>
          <div style={{ overflow: 'auto', padding: 4 }}>
            {fileList === null ? (
              <div style={{ padding: 16, color: 'var(--muted)', fontSize: 12, display: 'flex', alignItems: 'center', gap: 8 }}><Loader2 size={14} className="gc-spin" /> Завантаження…</div>
            ) : fileList.length === 0 ? (
              <div style={{ padding: 16, color: 'var(--muted)', fontSize: 12 }}>Порожньо. Скопіюй файли на диск «Garely» на сервері й натисни оновити.</div>
            ) : (
              fileList.map((f) => (
                <div key={f.path} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 8px', borderRadius: 8 }}>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 12.5 }}>{f.dir ? '📁 ' : ''}{f.name}</span>
                  {!f.dir && (
                    <button type="button" className="gc-tool" style={{ background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', padding: 6, borderRadius: 8, display: 'inline-flex' }} onClick={() => downloadRef.current?.(f.path, f.name)} title="Завантажити"><Download size={15} /></button>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {!connected && !dead && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, color: 'rgba(231,233,238,.7)', pointerEvents: 'none' }}>
          <Loader2 size={20} className="gc-spin" /> connecting…
        </div>
      )}

      {/* A dropped tunnel / guacd error used to leave just a black screen — no message,
          no way out but the tiny red pill dot. Show what happened and how to recover. */}
      {dead && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 30, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, background: 'rgba(4,7,12,.86)', padding: 24, textAlign: 'center' }}>
          <div style={{ width: 44, height: 44, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(248,113,113,.14)', color: '#f87171' }}>
            <Power size={22} />
          </div>
          <div style={{ color: '#e7e9ee', fontSize: 16, fontWeight: 600 }}>
            {status === 'tunnel-error' ? 'Втрачено зʼєднання з сервером' : status === 'error' ? 'Помилка зʼєднання' : 'Сесію завершено'}
          </div>
          <div style={{ color: 'rgba(231,233,238,.6)', fontSize: 13, maxWidth: 360, lineHeight: 1.5 }}>
            {status === 'disconnected'
              ? 'Віддалений сеанс закрито. Можна підключитися знову.'
              : 'Мережа або віддалений сервер розірвали зʼєднання. Спробуй підключитися знову.'}
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
            <button
              type="button"
              onClick={() => onExit?.()}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '9px 16px', borderRadius: 10, border: 'none', cursor: 'pointer', background: 'var(--accent)', color: '#fff', fontSize: 13.5, fontWeight: 600 }}
            >
              <RotateCw size={15} /> Підключитися знову
            </button>
          </div>
        </div>
      )}

      {/* floating, draggable status pill — grab the body to reposition; buttons stay clickable */}
      <div
        ref={pillRef}
        onPointerDown={onPillDown}
        onPointerMove={onPillMove}
        onPointerUp={onPillUp}
        onPointerCancel={onPillUp}
        style={{
          position: 'absolute',
          ...(pillPos ? { left: pillPos.x, top: pillPos.y } : { top: 12, right: 12 }),
          zIndex: 12,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '5px 6px',
          borderRadius: 999,
          background: 'rgba(5,7,10,.88)',
          border: `1px solid rgba(255,255,255,${pillDragging ? 0.22 : 0.1})`,
          boxShadow: pillDragging ? '0 10px 30px -8px rgba(0,0,0,.7)' : 'none',
          cursor: pillDragging ? 'grabbing' : 'grab',
          touchAction: 'none',
          userSelect: 'none',
          transition: 'border-color .15s ease, box-shadow .15s ease',
        }}
      >
        <GripVertical size={14} style={{ color: 'rgba(255,255,255,.4)', flexShrink: 0 }} aria-hidden />
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12, fontWeight: 600, color: '#e7e9ee', maxWidth: 240 }}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: connected ? '#10b981' : dead ? '#f87171' : 'var(--accent)' }} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{serverName}</span>
        </span>
        {toolBtn(() => fileInputRef.current?.click(), 'Надіслати файли на диск «Garely»', <Upload size={15} />)}
        {toolBtn(toggleFiles, 'Диск «Garely» — завантажити файли з сервера', <HardDrive size={15} />, { active: filesOpen })}
        {toolBtn(() => onToggleHd?.(), hd ? 'HD увімкнено — натисни для звичайного' : 'HD — чіткіша картинка', <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.04em' }}>HD</span>, { active: hd })}
        {toolBtn(goFullscreen, 'Fullscreen', <Maximize2 size={15} />)}
        {toolBtn(exit, 'Disconnect', <Power size={15} />, { danger: true })}
      </div>
    </div>
  );
}
