import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { isSetupComplete } from '@/lib/setup';
import { getAuthConfig, PRODUCT_NAME } from '@/lib/config';
import { LoginClient } from './login-client';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ callbackUrl?: string }>;
}) {
  // Before the workspace is configured there is no SSO to log in with.
  if (!(await isSetupComplete())) {
    redirect('/setup');
  }

  // Already signed in and lands on /login anyway — e.g. a bookmark that points
  // straight at /login, or opening the app in a second tab. Bounce into the app
  // instead of showing the login form again (which read as "not logged in").
  // Verify the account still exists + is active first: this mirrors the (app)
  // gate, so a stale session (deleted/disabled user) is NOT redirected — it falls
  // through to the login form, which also prevents a /login ⇄ / redirect loop.
  const session = await auth();
  if (session?.user?.id) {
    const dbUser = await prisma.user
      .findUnique({ where: { id: session.user.id }, select: { status: true } })
      .catch(() => null);
    if (dbUser && dbUser.status !== 'disabled') {
      const raw = (await searchParams)?.callbackUrl;
      const dest =
        typeof raw === 'string' && raw.startsWith('/') && !raw.startsWith('//') && !raw.startsWith('/login')
          ? raw
          : '/';
      redirect(dest);
    }
  }

  const authCfg = await getAuthConfig();
  return (
    <LoginClient
      wsName={PRODUCT_NAME}
      googleEnabled={authCfg.googleEnabled}
      passwordEnabled={authCfg.passwordEnabled}
      selfReg={authCfg.selfReg}
    />
  );
}
