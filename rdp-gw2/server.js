// Garely RDP v2 tunnel (guacamole-lite). Bridges a browser WebSocket to guacd.
//
// SECURITY: the browser connects with `?token=<opaque>` minted by Garely's connect
// route (lib/guac.ts mintGuacToken) — an AES-256-CBC blob carrying the target host +
// the decrypted vault password. This process decrypts it and hands the settings to
// guacd; the RDP password is NEVER sent to the browser (a strict improvement over v1,
// where /connect returned the cleartext password for in-browser NLA).
//
// Runs as an isolated compose service (profile "rdp2"), reachable only via host-nginx.
const http = require('http');
const GuacamoleLite = require('guacamole-lite');

const PORT = Number(process.env.PORT || 8080);
const GUACD_HOST = process.env.GUACD_HOST || 'guacd';
const GUACD_PORT = Number(process.env.GUACD_PORT || 4822);
const KEY = process.env.GUAC_TOKEN_KEY || '';

if (Buffer.byteLength(KEY, 'utf8') !== 32) {
  console.error('[guac-tunnel] FATAL: GUAC_TOKEN_KEY must be exactly 32 bytes (got ' +
    Buffer.byteLength(KEY, 'utf8') + ')');
  process.exit(1);
}

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  res.writeHead(426, { 'Content-Type': 'text/plain' }); // everything else must be a WS upgrade
  res.end('websocket only');
});

const guac = new GuacamoleLite(
  { server },
  { host: GUACD_HOST, port: GUACD_PORT },
  { crypt: { cypher: 'AES-256-CBC', key: KEY }, log: { level: process.env.LOG_LEVEL || 'NORMAL' } },
);
guac.on('error', (clientConnection, err) =>
  console.error('[guac-tunnel] connection error:', err && err.message));

server.listen(PORT, () =>
  console.log(`[guac-tunnel] listening on :${PORT} -> guacd ${GUACD_HOST}:${GUACD_PORT}`));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { console.log('[guac-tunnel] shutting down'); server.close(() => process.exit(0)); });
}
