'use client';

import { useEffect, useRef, useState } from 'react';
import { Power, Loader2 } from 'lucide-react';

/**
 * RDP v2 (Apache Guacamole) client — MINIMAL validation build. Renders guacd's display
 * stream via guacamole-common-js (display + keyboard + mouse only). Clipboard, file
 * transfer, dynamic resize and the Mac ⌘-remap are deliberately NOT here yet — this
 * exists to validate motion/quality on a real target before investing in full parity.
 * The RDP password is inside the opaque `token`; it never reaches this component.
 *
 * IMPORTANT: `hostRef` is left EMPTY from React's view (no JSX children) — the guac
 * display element is appended manually. Mixing manual DOM ops with React-rendered
 * children in the same node throws "removeChild: node is not a child" on reconcile, so
 * the loading overlay is a SEPARATE sibling, never a child of hostRef.
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
  const hostRef = useRef<HTMLDivElement | null>(null);
  const clientRef = useRef<any>(null);
  const [status, setStatus] = useState('connecting');

  useEffect(() => {
    let disposed = false;
    let client: any = null;
    let keyboard: any = null;
    let onWinResize: (() => void) | null = null;

    (async () => {
      const Guacamole = (await import('guacamole-common-js')).default as any;
      if (disposed || !hostRef.current) return;

      const base = tunnelUrl.replace(/\/$/, '') + '/';
      const tunnel = new Guacamole.WebSocketTunnel(base);
      client = new Guacamole.Client(tunnel);
      clientRef.current = client;

      const display = client.getDisplay();
      const el = display.getElement();
      // hostRef holds ONLY this element (React never renders children into it).
      while (hostRef.current.firstChild) hostRef.current.removeChild(hostRef.current.firstChild);
      hostRef.current.appendChild(el);

      const STATES = ['idle', 'connecting', 'waiting', 'connected', 'disconnecting', 'disconnected'];
      client.onstatechange = (s: number) => setStatus(STATES[s] ?? String(s));
      client.onerror = () => setStatus('error');
      tunnel.onerror = () => setStatus('tunnel-error');

      // Scale the display to fit the container width (keeps the whole remote visible).
      const fit = () => {
        const w = display.getWidth();
        if (!w || !hostRef.current) return;
        display.scale(Math.min(1, hostRef.current.clientWidth / w));
      };
      display.onresize = fit;
      onWinResize = fit;
      window.addEventListener('resize', onWinResize);

      // Input.
      const mouse = new Guacamole.Mouse(el);
      mouse.onmousedown = mouse.onmouseup = mouse.onmousemove = (st: any) => client.sendMouseState(st);
      keyboard = new Guacamole.Keyboard(document);
      keyboard.onkeydown = (k: number) => client.sendKeyEvent(1, k);
      keyboard.onkeyup = (k: number) => client.sendKeyEvent(0, k);

      client.connect('token=' + encodeURIComponent(token));
    })().catch(() => setStatus('error'));

    return () => {
      disposed = true;
      if (onWinResize) window.removeEventListener('resize', onWinResize);
      try { keyboard?.reset(); } catch { /* noop */ }
      try { client?.disconnect(); } catch { /* noop */ }
    };
  }, [tunnelUrl, token]);

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
        <button className="btn btn-ghost" style={{ padding: '5px 10px' }} onClick={() => { try { clientRef.current?.disconnect(); } catch { /* noop */ } onExit?.(); }}>
          <Power size={15} style={{ marginRight: 6 }} /> Disconnect
        </button>
      </div>
      {/* relative wrapper: hostRef (manual DOM) + the loader overlay are SIBLINGS */}
      <div style={{ position: 'relative', minHeight: 'min(72vh, 720px)', overflow: 'auto', display: 'flex', justifyContent: 'center', alignItems: 'flex-start' }}>
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
