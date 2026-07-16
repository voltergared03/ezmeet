import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';
import Credentials from 'next-auth/providers/credentials';
import { PrismaAdapter } from '@auth/prisma-adapter';
import { prisma } from './prisma';
import { readConfig, CONFIG_DEFAULTS, getGoogleConfig, getAuthConfig } from './config';
import { verifyPassword } from './password';
import { rateLimit, rateLimitReset } from './rate-limit';
import { getSingletonOrgId } from './org';
import { linkGoogleCalendarFromSSO } from './calendar-sync';

// Lazy / per-request config so the enabled sign-in methods + Google OAuth
// credentials can be read from the database (set during /setup) instead of
// baked into env. Providers are added conditionally per getAuthConfig(), so an
// existing Google-only deployment is unaffected until password auth is enabled.
export const { handlers, auth, signIn, signOut } = NextAuth(async () => {
  const [google, authCfg] = await Promise.all([getGoogleConfig(), getAuthConfig()]);

  const providers: any[] = [];

  if (authCfg.googleEnabled && google.clientId && google.clientSecret) {
    providers.push(
      Google({
        clientId: google.clientId,
        clientSecret: google.clientSecret,
        // Link Google login to a pre-created (invited) user with the same email
        allowDangerousEmailAccountLinking: true,
        // Request Calendar access at login (incremental consent) + a refresh
        // token, so signing in with Google auto-enables two-way calendar sync.
        // No `prompt:consent` → Google only re-prompts the first time the new
        // scope appears, not every login; the Settings "Connect" button (which
        // does force consent) remains the guaranteed fallback.
        authorization: {
          params: {
            scope: 'openid email profile https://www.googleapis.com/auth/calendar',
            access_type: 'offline',
            include_granted_scopes: 'true',
          },
        },
        // Pin the account id to Google's stable `sub` (mirrors next-auth's
        // default mapping). Added 2026-05-29 after a transient
        // OAuthAccountNotLinked incident, to keep the OIDC account lookup
        // deterministic.
        profile(p: any) {
          return { id: p.sub, name: p.name, email: p.email, image: p.picture };
        },
      }),
    );
  }

  if (authCfg.passwordEnabled) {
    providers.push(
      Credentials({
        name: 'credentials',
        credentials: {
          email: { label: 'Email', type: 'email' },
          password: { label: 'Password', type: 'password' },
        },
        async authorize(creds) {
          const email = String(creds?.email || '').trim().toLowerCase();
          const password = String(creds?.password || '');
          if (!email || !password) return null;

          // Brute-force throttle (in-process; single-container deployment).
          const key = `login:${email}`;
          if (!(await rateLimit(key, 10, 5 * 60_000)).ok) return null;

          const user = (await prisma.user.findUnique({
            where: { email },
            select: {
              id: true, email: true, name: true, image: true,
              passwordHash: true, status: true,
            } as any,
          })) as any;

          // Must be an active account that actually has a password set.
          if (!user || !user.passwordHash || user.status !== 'active') return null;
          if (!(await verifyPassword(password, user.passwordHash))) return null;

          await rateLimitReset(key);
          return { id: user.id, email: user.email, name: user.name, image: user.image };
        },
      }),
    );
  }

  return {
    trustHost: true,
    adapter: PrismaAdapter(prisma),
    providers,
    session: {
      strategy: 'jwt',
    },
    callbacks: {
      async jwt({ token, user, account }) {
        if (user) {
          token.id = user.id;
        }
        // On a Google SSO sign-in, capture the OAuth tokens to auto-enable
        // two-way calendar sync. Fire-and-forget — never blocks/breaks login;
        // no-op for credentials login or when the calendar scope wasn't granted.
        if (account?.provider === 'google' && token.id) {
          void linkGoogleCalendarFromSSO(token.id as string, account as any);
        }
        // Always fetch the latest role + 2FA status from DB (read by middleware via getToken)
        if (token.id) {
          const dbUser = (await prisma.user.findUnique({
            where: { id: token.id as string },
            select: { role: true, totpEnabled: true, status: true, mustChangePassword: true, sessionEpoch: true, preferences: true, memberships: { orderBy: { createdAt: 'asc' }, take: 1, select: { orgId: true, role: true } } } as any,
          })) as any;

          // Session revocation: the token freezes the user's sessionEpoch at sign-in;
          // if the DB epoch has since moved (an admin/incident "sign out everywhere"
          // bumped it), this cookie is stale → return null so @auth/core clears it.
          // Grandfather tokens minted before this field existed by adopting the current
          // epoch (avoids logging everyone out on deploy). Never invalidate on a missing
          // dbUser (defensive: only a positive mismatch revokes).
          const dbEpoch: number = dbUser?.sessionEpoch ?? 0;
          if (user || typeof token.epoch !== 'number') {
            token.epoch = dbEpoch;
          } else if (dbUser && token.epoch !== dbEpoch) {
            return null;
          }

          token.role = dbUser?.role || 'member';
          token.totpEnabled = !!dbUser?.totpEnabled;
          token.status = dbUser?.status || 'active';
          token.mustChangePassword = !!dbUser?.mustChangePassword;
          // Multi-tenancy: the user's active org (single membership in self-host).
          token.orgId = dbUser?.memberships?.[0]?.orgId;
          token.orgRole = dbUser?.memberships?.[0]?.role;
          // The user's saved UI language (if any). Read client-side by <LocaleSync>
          // to keep the `locale` cookie in step with their preference.
          const prefLang = (dbUser?.preferences as any)?.language;
          token.locale = prefLang === 'en' || prefLang === 'uk' ? prefLang : undefined;

          // Presence / "last seen": refresh lastLogin on sign-in and at most once
          // every 2 minutes of activity, so the admin status reflects real recent
          // activity (Online for active users) instead of only the last sign-in.
          const now = Date.now();
          const seenAt = token.seenAt;
          if (user || !seenAt || now - seenAt > 120_000) {
            token.seenAt = now;
            await prisma.user
              .update({
                where: { id: token.id as string },
                data: { lastLogin: new Date() },
              })
              .catch(() => {});
          }
        }
        return token;
      },
      async session({ session, token }) {
        if (session.user) {
          session.user.id = token.id ?? '';
          session.user.role = token.role ?? 'member';
          session.user.status = token.status ?? 'active';
          session.user.mustChangePassword = !!token.mustChangePassword;
          session.user.locale = token.locale;
          session.user.orgId = token.orgId;
          session.user.orgRole = token.orgRole;
        }
        return session;
      },
    },
    events: {
      // Apply workspace defaults (timezone / language) to brand-new users.
      async createUser({ user }) {
        try {
          const cfg = await readConfig(['WS_TIMEZONE', 'WS_LANGUAGE']);
          const tz = cfg.WS_TIMEZONE || CONFIG_DEFAULTS.WS_TIMEZONE;
          const lang = cfg.WS_LANGUAGE || CONFIG_DEFAULTS.WS_LANGUAGE;
          await prisma.user.update({
            where: { id: user.id as string },
            data: { timezone: tz, preferences: { language: lang } },
          });
          // Multi-tenancy: enroll the new (SSO) user into the current org.
          const orgId = await getSingletonOrgId();
          if (orgId) {
            await prisma.membership.upsert({
              where: { orgId_userId: { orgId, userId: user.id as string } },
              update: {},
              create: { orgId, userId: user.id as string, role: 'MEMBER' },
            });
          }
        } catch {
          /* non-fatal: keep schema defaults */
        }
      },
    },
    pages: {
      signIn: '/login',
    },
  };
});
