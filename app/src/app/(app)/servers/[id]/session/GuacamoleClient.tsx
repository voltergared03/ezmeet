'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Power, Loader2, Maximize2, GripVertical } from 'lucide-react';

/**
 * RDP v2 (Apache Guacamole) client. Full-viewport takeover (native-client feel) with a
 * draggable floating pill for controls, mirroring v1's RdpClient. guacd does the native
 * decode; the display is sized to the viewport × devicePixelRatio for a crisp HiDPI
 * render, then scaled to CSS size, and re-negotiated on resize/fullscreen. Mouse
 * coordinates come from getBoundingClientRect (transform/fullscreen-safe). Clipboard +
 * file transfer are the remaining parity items. The RDP password is inside the opaque
 * `token`; it never reaches here.
 *
 * hostRef holds ONLY the manually-appended guac element (NO JSX children) — mixing
 * manual DOM with React children in one node throws removeChild on reconcile.
 */
export default function GuacamoleClient({
  tunnelUrl,
  token,
  serverName,
  onExit,
}: {
  tunnelUrl: string;
  token: string;
  serverName: string;
  onExit?: () => void;
}) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const clientRef = useRef<any>(null);
  const [status, setStatus] = useState('connecting');

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

      const dpr = () => Math.min(window.devicePixelRatio || 1, 2);
      // Ask guacd to render at frame×dpr (crisp HiDPI). Debounced by callers.
      const pushSize = () => {
        const box = frameRef.current;
        if (!box) return;
        const d = dpr();
        try { client.sendSize(Math.max(640, Math.round(box.clientWidth * d)), Math.max(480, Math.round(box.clientHeight * d))); } catch { /* noop */ }
      };
      // Fit the rendered display into the frame. display.scale() is a CSS transform, so
      // the element's LAYOUT box stays at full remote resolution — the host must be sized
      // to the SCALED box, else the centering flex parent offsets/clips it. That mismatch
      // is what looked "broken" on entry until a fullscreen toggle forced a re-fit.
      const fit = () => {
        const box = frameRef.current, host = hostRef.current;
        const w = display.getWidth(), h = display.getHeight();
        if (!box || !host || !w || !h) return;
        const scale = Math.min(box.clientWidth / w, box.clientHeight / h);
        display.scale(scale);
        host.style.width = Math.floor(w * scale) + 'px';
        host.style.height = Math.floor(h * scale) + 'px';
      };

      const STATES = ['idle', 'connecting', 'waiting', 'connected', 'disconnecting', 'disconnected'];
      client.onstatechange = (s: number) => {
        const name = STATES[s] ?? String(s);
        setStatus(name);
        if (name === 'connected') { pushSize(); requestAnimationFrame(fit); }
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

      keyboard = new Guacamole.Keyboard(document);
      keyboard.onkeydown = (k: number) => client.sendKeyEvent(1, k);
      keyboard.onkeyup = (k: number) => client.sendKeyEvent(0, k);

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

  const toolBtn = (onClick: () => void, label: string, icon: React.ReactNode, danger?: boolean) => (
    <button
      type="button" onClick={onClick} title={label} aria-label={label} className="gc-tool"
      style={{ color: danger ? '#f87171' : 'var(--muted)', background: 'none', border: 'none', cursor: 'pointer', display: 'inline-flex', padding: 6, borderRadius: 8 }}
    >
      {icon}
    </button>
  );

  return (
    <div ref={frameRef} style={{ position: 'fixed', inset: 0, zIndex: 200, background: '#000' }}>
      <style>{`
        @keyframes gc-spin { to { transform: rotate(360deg); } }
        .gc-spin { animation: gc-spin 1s linear infinite; }
        .gc-tool:hover { background: rgba(255,255,255,.08) !important; color: #e7e9ee !important; }
        @media (prefers-reduced-motion: reduce) { .gc-spin { animation: none; } }
      `}</style>

      {/* display fills the viewport; hostRef holds ONLY the guac element */}
      <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
        <div ref={hostRef} tabIndex={0} style={{ outline: 'none', overflow: 'hidden' }} />
      </div>

      {!connected && !dead && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, color: 'rgba(231,233,238,.7)', pointerEvents: 'none' }}>
          <Loader2 size={20} className="gc-spin" /> connecting…
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
        {toolBtn(goFullscreen, 'Fullscreen', <Maximize2 size={15} />)}
        {toolBtn(exit, 'Disconnect', <Power size={15} />, true)}
      </div>
    </div>
  );
}
