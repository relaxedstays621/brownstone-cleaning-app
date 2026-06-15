import * as Sentry from "@sentry/nextjs";

// Browser-side capture. The DSN must be a NEXT_PUBLIC_ var so it's inlined into
// the client bundle at build time; no-op until the operator sets it.
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  enabled: Boolean(process.env.NEXT_PUBLIC_SENTRY_DSN),
  tracesSampleRate: 0.1,
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 0,
  release: process.env.NEXT_PUBLIC_SENTRY_RELEASE,
});
