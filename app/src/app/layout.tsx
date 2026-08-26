import type { Metadata, Viewport } from 'next';
import { SessionProvider } from 'next-auth/react';
import { NextIntlClientProvider } from 'next-intl';
import { getLocale, getMessages } from 'next-intl/server';
import { PRODUCT_NAME } from '@/lib/config';
import { PwaRegister } from '@/components/pwa-register';
import { THEME_INIT_SCRIPT } from '@/lib/theme';
import './globals.css';

export async function generateMetadata(): Promise<Metadata> {
  // Product brand (constant) drives the browser title / PWA / Apple web-app name.
  // The per-workspace name (WS_NAME) is a tenant label shown inside the app shell.
  return {
    title: { default: PRODUCT_NAME, template: `%s · ${PRODUCT_NAME}` },
    description: 'Self-hosted video conferencing with AI meeting intelligence',
    applicationName: PRODUCT_NAME,
    manifest: '/manifest.webmanifest',
    icons: {
      icon: '/favicon.svg',
      apple: '/icons/apple-touch-icon.png',
    },
    appleWebApp: {
      capable: true,
      title: PRODUCT_NAME,
      statusBarStyle: 'black-translucent',
    },
    formatDetection: { telephone: false },
  };
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
  // Per-scheme, so the browser chrome and the iOS status bar match the page instead
  // of staying dark behind a light UI. Values track --bg in globals.css.
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f4f5f8' },
    { media: '(prefers-color-scheme: dark)', color: '#0b0d11' },
  ],
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const locale = await getLocale();
  const messages = await getMessages();

  return (
    // suppressHydrationWarning: the inline script below stamps data-theme onto this
    // element before React hydrates, so server and client markup differ here by design.
    <html lang={locale} suppressHydrationWarning>
      <head>
        {/* Must run before first paint — see THEME_INIT_SCRIPT. Inlined rather than
            imported so nothing is fetched between parse and paint. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        <PwaRegister />
        <NextIntlClientProvider locale={locale} messages={messages}>
          <SessionProvider>{children}</SessionProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
