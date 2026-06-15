import * as Sentry from "@sentry/nextjs";

// Edge runtime (middleware etc.). No-op until SENTRY_DSN is set.
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  enabled: Boolean(process.env.SENTRY_DSN),
  tracesSampleRate: 0.1,
  release: process.env.SENTRY_RELEASE,
});
