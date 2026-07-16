'use client';

import { useEffect, useRef, useState } from 'react';
import { Power, Loader2, Maximize2 } from 'lucide-react';

/**
 * RDP v2 (Apache Guacamole) client — validation build. Renders guacd's display via
 * guacamole-common-js with HiDPI-correct sizing: it sends guacd the container's native
 * pixel size (× devicePixelRatio) so the remote renders crisp, then scales the display
 * back down to CSS size. Dynamic resize (guacd resize-method=display-update) re-fits on
 * window/fullscreen changes. Display + keyboard + mouse only — clipboard/files/⌘-remap
 * come later. The RDP password is inside the opaque `token`; it never reaches here.
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
  const frameRef = useRef<HTMLDivElement | null>(null); // fullscreen target + size source
  const hostRef = useRef<HTMLDivElement | null>(null); // holds only the guac display element
  const clientRef = useRef<any>(null);
  const [status, setStatus] = useState('connecting');

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

      const dpr = () => Math.min(window.devicePixelRatio || 1, 2);
      const pushSize = () => {
        const box = frameRef.current;
        if (!box) return;
        const d = dpr();
        const w = Math.max(640, Math.round(box.clientWidth * d));
        const h = Math.max(480, Math.round(box.clientHeight * d));
        try { client.sendSize(w, h); } catch { /* noop */ }
      };

      const STATES = ['idle', 'connecting', 'waiting', 'connected', 'disconnecting', 'disconnected'];
      client.onstatechange = (s: number) => {
        const name = STATES[s] ?? String(s);
        setStatus(name);
        if (name === 'connected') pushSize(); // negotiate the real container resolution
      };
      client.onerror = () => setStatus('error');
      tunnel.onerror = () => setStatus('tunnel-error');

      // Scale the (dpr-resolution) display down to CSS size → crisp HiDPI, correct fit.
      display.onresize = () => {
        const box = frameRef.current;
        const w = display.getWidth();
        if (!box || !w) return;
        display.scale(box.clientWidth / w);
      };

      // Mouse: compute coordinates ourselves from getBoundingClientRect (transform- AND
      // fullscreen-safe) mapped to the remote pixel space. Guacamole.Mouse walks the
      // offsetParent chain instead, which misplaces clicks under CSS scale / fullscreen
      // (the reported "clicks land in the wrong / multiple places"). Hide the local
      // cursor so only guacd's remote cursor shows (no double cursor).
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

      const onWinResize = () => { if (resizeTimer) clearTimeout(resizeTimer); resizeTimer = setTimeout(pushSize, 300); };
      const onFsChange = () => pushSize();
      window.addEventListener('resize', onWinResize);
      document.addEventListener('fullscreenchange', onFsChange);
      cleanups.push(() => window.removeEventListener('resize', onWinResize));
      cleanups.push(() => document.removeEventListener('fullscreenchange', onFsChange));

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

  const goFullscreen = () => {
    const box = frameRef.current;
    if (!box) return;
    if (document.fullscreenElement) void document.exitFullscreen?.();
    else void box.requestFullscreen?.();
  };

  const connected = status === 'connected';
  const dead = status === 'disconnected' || status === 'error' || status === 'tunnel-error';

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 16, overflow: 'hidden', background: '#0a0d12' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderBottom: '1px solid rgba(255,255,255,.07)', background: 'rgba(255,255,255,.02)' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 12.5, fontWeight: 600, color: '#e7e9ee' }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: connected ? '#10b981' : dead ? '#f87171' : 'var(--accent)' }} />
          {serverName} · <span style={{ fontFamily: 'var(--font-mono, ui-monospace, monospace)', color: 'var(--muted)' }}>Guacamole (v2 beta) — {status}</span>
        </span>
        <span style={{ flex: 1 }} />
        <button className="btn btn-ghost" style={{ padding: '5px 10px' }} onClick={goFullscreen} title="Fullscreen">
          <Maximize2 size={15} style={{ marginRight: 6 }} /> Fullscreen
        </button>
        <button className="btn btn-ghost" style={{ padding: '5px 10px' }} onClick={() => { try { clientRef.current?.disconnect(); } catch { /* noop */ } onExit?.(); }}>
          <Power size={15} style={{ marginRight: 6 }} /> Disconnect
        </button>
      </div>
      {/* frame: fullscreen target + size source. hostRef and the loader overlay are SIBLINGS. */}
      <div ref={frameRef} style={{ position: 'relative', minHeight: 'min(74vh, 760px)', overflow: 'auto', display: 'flex', justifyContent: 'center', alignItems: 'center', background: '#000' }}>
        <div ref={hostRef} tabIndex={0} style={{ outline: 'none' }} />
        {!connected && !dead && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, color: 'var(--muted)', pointerEvents: 'none' }}>
            <Loader2 size={18} className="spin" /> connecting…
          </div>
        )}
      </div>
    </div>
  );
}
