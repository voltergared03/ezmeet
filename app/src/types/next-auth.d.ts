// Module augmentation for NextAuth.
//
// Gives `session.user` and the JWT their real shape — the fields are populated
// in the `jwt` / `session` callbacks in src/lib/auth.ts. Without this, every
// read site needs `session.user.id` etc.; with it, `session.user.id`
// is fully typed and a typo surfaces as a compile error.
import type { DefaultSession } from 'next-auth';

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      role: string;
      status: string;
      mustChangePassword: boolean;
      orgId?: string;
      orgRole?: string;
      locale?: 'en' | 'uk';
    } & DefaultSession['user'];
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    id?: string;
    role?: string;
    totpEnabled?: boolean;
    status?: string;
    mustChangePassword?: boolean;
    orgId?: string;
    orgRole?: string;
    locale?: 'en' | 'uk';
    seenAt?: number;
    epoch?: number; // frozen sessionEpoch — mismatch vs DB revokes the session
  }
}
