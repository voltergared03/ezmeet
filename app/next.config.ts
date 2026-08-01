import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const nextConfig: NextConfig = {
  output: 'standalone',
  // Version-skew protection. A tab opened BEFORE a deploy keeps calling Server Action
  // ids from the old build; the new build doesn't have them, so the action fails
  // ("Failed to find Server Action") and the client retries in a loop — the tab looks
  // broken until a manual hard-reload. With a deploymentId Next stamps assets/action
  // requests and, on a mismatch, does a hard navigation so the tab self-heals.
  //
  // The value must CHANGE per build (that's what makes a stale tab detectable) and be
  // IDENTICAL in the client bundle and the server config — otherwise every request
  // would look stale and reload-loop. That holds here because `output: 'standalone'`
  // serialises this config into .next/required-server-files.json at build time and the
  // runtime image ships no next.config.ts, so this expression is evaluated exactly once
  // (at build) and never re-derived at runtime. The timestamp fallback keeps that
  // guarantee even when no DEPLOYMENT_ID/GIT_SHA is passed in.
  deploymentId: process.env.DEPLOYMENT_ID || process.env.GIT_SHA || `b${Date.now()}`,
  // The IronRDP web client ships as pre-bundled ESM with a base64-inlined WASM
  // module (no separate .wasm asset → no COOP/COEP / asset-serving needed). It is
  // imported client-side only (it calls customElements.define at module top level,
  // so a server import would crash). transpilePackages routes it through Next's
  // pipeline; topLevelAwait keeps the WASM-init module graph happy under webpack.
  transpilePackages: ['@devolutions/iron-remote-desktop', '@devolutions/iron-remote-desktop-rdp'],
  webpack: (config) => {
    config.experiments = { ...config.experiments, topLevelAwait: true };
    return config;
  },
  experimental: {
    serverActions: {
      bodySizeLimit: '2mb',
    },
  },
  async headers() {
    return [
      {
        // Baseline security headers on every response. We intentionally do NOT
        // set a full script/style CSP here — the app relies on inline styles +
        // Next's inline hydration + LiveKit, which a strict policy would break.
        // `frame-ancestors` (+ X-Frame-Options for old browsers) is the
        // clickjacking defense and is safe; a full CSP is a future hardening step.
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'self'" },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
      {
        // The service worker must revalidate on every load so updates ship
        // promptly, and be allowed to control the whole origin.
        source: '/sw.js',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' },
          { key: 'Service-Worker-Allowed', value: '/' },
        ],
      },
    ];
  },
};

export default withNextIntl(nextConfig);
