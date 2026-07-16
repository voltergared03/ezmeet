/**
 * RDP v2 (Apache Guacamole) — mint the connection token the browser hands to the
 * guac-tunnel (guacamole-lite). SECURITY-CRITICAL, NODE-ONLY.
 *
 * The token is an AES-256-CBC blob (guacamole-lite's format) carrying the target
 * host + the DECRYPTED vault password. The browser receives an opaque token it
 * cannot read; only the tunnel (which shares GUAC_TOKEN_KEY) decrypts it and passes
 * the settings to guacd. So the RDP password NEVER reaches the browser — a strict
 * improvement over v1's /connect, which returned the cleartext password for
 * in-browser NLA. Coexists with v1; gated by RDP_V2 config until v1 is retired.
 *
 * Env:
 *   GUAC_TOKEN_KEY   32-byte shared secret with the guac-tunnel (AES-256-CBC)
 *   GUAC_TUNNEL_URL  wss base the browser opens, e.g. wss://meet.example.com/guac2
 */
import { createCipheriv, randomBytes } from 'node:crypto';

export function guacTokenKey(): string {
  return (process.env.GUAC_TOKEN_KEY || '').trim();
}
export function guacTunnelUrl(): string {
  return (process.env.GUAC_TUNNEL_URL || '').trim();
}
/** RDP v2 is available only when the tunnel URL + a valid 32-byte token key are set. */
export function guacEnabled(): boolean {
  return Buffer.byteLength(guacTokenKey(), 'utf8') === 32 && !!guacTunnelUrl();
}

export interface GuacRdpParams {
  hostname: string;
  port: number;
  username: string;
  password?: string; // decrypted vault secret; omitted → guacd prompts / no NLA
  domain?: string | null;
  width?: number;
  height?: number;
  dpi?: number;
  /** guacd 1.6 Graphics-Pipeline (H.264/RemoteFX) lever. Default OFF: native decode +
   *  copy-rect already fixes the v1 motion lag WITHOUT loading GPU-less targets with a
   *  software H.264 encode. Flip per-target once a target proves it can afford it. */
  gfx?: boolean;
}

/**
 * Mint a guacamole-lite connection token. Opaque to the browser; the tunnel decrypts
 * it and drives guacd. Throws if the key is misconfigured (fail-closed — never ship a
 * token the tunnel can't read).
 */
export function mintGuacToken(p: GuacRdpParams): string {
  const key = guacTokenKey();
  if (Buffer.byteLength(key, 'utf8') !== 32) {
    throw new Error('GUAC_TOKEN_KEY must be exactly 32 bytes');
  }
  const settings: Record<string, unknown> = {
    hostname: p.hostname,
    port: p.port,
    username: p.username,
    security: 'any',
    'ignore-cert': true,
    'resize-method': 'display-update',
    width: p.width ?? 1280,
    height: p.height ?? 800,
    dpi: p.dpi ?? 96,
    'enable-wallpaper': true,
    'enable-theming': true,
    'enable-font-smoothing': true,
    'disable-gfx': !p.gfx,
  };
  if (p.password) settings.password = p.password;
  if (p.domain) settings.domain = p.domain;

  const payload = { connection: { type: 'rdp', settings } };
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  let enc = cipher.update(JSON.stringify(payload), 'utf8', 'base64');
  enc += cipher.final('base64');
  const data = { iv: iv.toString('base64'), value: enc };
  return Buffer.from(JSON.stringify(data)).toString('base64');
}
