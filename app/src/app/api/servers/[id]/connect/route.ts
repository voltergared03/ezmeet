import { NextResponse, type NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { requireOrg } from '@/lib/api-auth';
import { withRoute } from '@/lib/with-route';
import { jsonError } from '@/lib/http';
import { userCanAccessServer } from '@/lib/server-access';
import { decryptServerSecret } from '@/lib/server-credentials';
import { rdpGatewayEnabled, rdpGatewayUrl } from '@/lib/rdp-gateway';
import { mintConnectionToken } from '@/lib/rdp-token';
import { rateLimit } from '@/lib/rate-limit';
import { guacEnabled, guacTunnelUrl, mintGuacToken } from '@/lib/guac';

type Ctx = { params: Promise<{ id: string }> };

// POST /api/servers/[id]/connect — issue a short-lived gateway connection token for
// a server the caller may access. NOTE: because the in-browser IronRDP client performs
// CredSSP/NLA itself, the vault password is decrypted server-side and returned to the
// (already access-checked) caller's browser in the response — it is NOT injected into the
// gateway token on this path. That reveal is throttled + audited below; a stolen session
// must not be able to dump the whole fleet's credentials in a burst.
export const POST = withRoute('servers.connect', async (req: NextRequest, ctx: Ctx) => {
  const r = await requireOrg();
  if (r instanceof Response) return r;
  const { id } = await ctx.params;
  const conn = await prisma.serverConnection.findFirst({ where: { id, orgId: r.orgId } });
  if (!conn) return jsonError('not_found', 404);
  if (!(await userCanAccessServer(id, r.session.user.id, r.session.user.role))) {
    return jsonError('forbidden', 403);
  }
  // Throttle the cleartext-credential reveal per caller: a compromised session can no
  // longer iterate connect to exfiltrate every server's password at machine speed.
  if (!(await rateLimit(`connect:${r.session.user.id}`, 8, 60_000)).ok) {
    return jsonError('rate_limited', 429);
  }

  const clientIp =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || req.headers.get('x-real-ip') || null;

  // ── RDP v2 (Apache Guacamole) — opt-in via ?v=2, coexists with v1 below. guacd does
  // native decode; the vault password is injected server-side into the encrypted guac
  // token and, unlike v1, is NEVER returned to the browser (closes finding F-01).
  if (req.nextUrl.searchParams.get('v') === '2') {
    if (!guacEnabled()) return jsonError('guac_unconfigured', 503);
    const sess = await prisma.serverSession.create({
      data: { connectionId: conn.id, userId: r.session.user.id, orgId: r.orgId, status: 'active', clientIp, lastSeenAt: new Date() },
      select: { id: true },
    });
    const gtoken = mintGuacToken({
      hostname: conn.host,
      port: conn.port,
      username: conn.username,
      password: decryptServerSecret(conn.secretCipher),
      domain: conn.domain,
    });
    return NextResponse.json({ method: 'guac', tunnelUrl: guacTunnelUrl(), token: gtoken, sessionId: sess.id });
  }

  // ── v1 (Devolutions Gateway / in-browser IronRDP) ──
  if (!rdpGatewayEnabled()) return jsonError('gateway_unconfigured', 503);

  const password = decryptServerSecret(conn.secretCipher); // '' when no stored secret

  // The IronRDP web client performs CredSSP/NLA itself over the gateway's RDCleanPath
  // relay — the gateway forwards but does NOT inject credentials on this path (injection
  // is only for native Jet clients via a pushed credential mapping + KDC). So the token is
  // a pure forwarding authorization (no creds), and the stored credentials are returned to
  // the already-access-checked caller's browser to drive NLA. They travel only over HTTPS
  // to an authorized user and live in WASM memory for the session (never persisted).
  const token = await mintConnectionToken({ host: conn.host, port: conn.port });

  // Audit: open a session row (the gateway closes it with byte counts + end time).
  const sess = await prisma.serverSession.create({
    data: {
      connectionId: conn.id,
      userId: r.session.user.id,
      orgId: r.orgId,
      status: 'active',
      clientIp,
      lastSeenAt: new Date(), // first heartbeat; the live client refreshes it every ~30s
    },
    select: { id: true },
  });

  return NextResponse.json({
    gatewayUrl: rdpGatewayUrl(),
    token,
    sessionId: sess.id,
    destination: `${conn.host}:${conn.port}`,
    username: conn.username,
    domain: conn.domain,
    hasStoredPassword: !!password,
    password, // '' when none stored → the client prompts the user for it
  });
});
