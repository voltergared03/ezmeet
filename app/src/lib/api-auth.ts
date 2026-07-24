import type { Session } from 'next-auth';
import { auth } from './auth';
import { userCanAccessMeeting } from './access';
import { getCurrentOrgId } from './org';
import { jsonError } from './http';

// Shared route guards. Routes currently copy-paste `const session = await auth();
// if (!session?.user) return 401` (~44 files), role checks (~19 files), and
// meeting-access logic (re-implemented inline despite lib/access.ts existing).
//
// Usage in a route handler:
//   const session = await requireAuth();
//   if (session instanceof Response) return session;
//   // session is fully typed here
//
// Adopt incrementally — each migrated route should gain a test (Phase 2).

/**
 * A disabled account keeps a valid JWT until it expires. The (app) layout bounces
 * them out of the UI, but every API route stayed reachable — so "disabling" a
 * user did not actually cut off their access to meetings, transcripts, recordings
 * or the vault. Status is refreshed from the DB on every token read, so this costs
 * nothing extra.
 */
function isDisabled(session: Session): boolean {
  return session.user?.status === 'disabled';
}

/** Require any authenticated, active user. Returns the session, or a 401 / 403 response. */
export async function requireAuth(): Promise<Session | Response> {
  const session = await auth();
  if (!session?.user) return jsonError('unauthorized', 401);
  if (isDisabled(session)) return jsonError('forbidden', 403);
  return session;
}

/** Require an active admin. Returns the session, or a 401 / 403 response. */
export async function requireAdmin(): Promise<Session | Response> {
  const session = await auth();
  if (!session?.user) return jsonError('unauthorized', 401);
  if (isDisabled(session)) return jsonError('forbidden', 403);
  if (session.user.role !== 'admin') return jsonError('forbidden', 403);
  return session;
}

/**
 * Require access to a meeting (admin, creator, or participant). Returns the
 * session, or a 401 / 403 response.
 */
export async function requireMeetingAccess(meetingId: string): Promise<Session | Response> {
  const session = await auth();
  if (!session?.user) return jsonError('unauthorized', 401);
  if (isDisabled(session)) return jsonError('forbidden', 403);
  const ok = await userCanAccessMeeting(meetingId, session.user.id, session.user.role);
  if (!ok) return jsonError('forbidden', 403);
  return session;
}

/**
 * Require an authenticated user AND resolve their active organization.
 * Returns `{ session, orgId }`, or a 401 / 403 response. Use in routes that
 * read or write tenant-scoped data so every query can filter / stamp by orgId.
 */
export async function requireOrg(): Promise<{ session: Session; orgId: string } | Response> {
  const session = await auth();
  if (!session?.user) return jsonError('unauthorized', 401);
  if (isDisabled(session)) return jsonError('forbidden', 403);
  const orgId = await getCurrentOrgId(session);
  if (!orgId) return jsonError('no_org', 403);
  return { session, orgId };
}
