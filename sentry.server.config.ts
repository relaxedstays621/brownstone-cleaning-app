import * as Sentry from "@sentry/nextjs";

// Server-side error/perf capture. No-op until SENTRY_DSN is set in the env, so
// this is safe to ship before the operator provisions a Sentry project.
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  enabled: Boolean(process.env.SENTRY_DSN),
  tracesSampleRate: 0.1,
  release: process.env.SENTRY_RELEASE,
});
