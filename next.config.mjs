import { withSentryConfig } from "@sentry/nextjs";

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  // This box is a shared 2-core Hetzner server; under any load the parallel
  // static-generation workers get CPU-starved and blow the default 60s
  // per-page timeout on otherwise-trivial API routes (SIGTERM, build fails).
  // Not a code issue — just give the constrained builder room so deploys are
  // reliable here.
  staticPageGenerationTimeout: 300,
  experimental: {
    // Required on Next 14.2 for src/instrumentation.ts (Sentry server/edge init).
    instrumentationHook: true,
  },
  headers: async () => [
    {
      source: "/:path*",
      headers: [
        {
          key: "Cache-Control",
          value: "no-cache, no-store, must-revalidate",
        },
      ],
    },
  ],
};

export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  // Keep the build quiet and never fail it when Sentry env is absent.
  silent: true,
  telemetry: false,
  // Only upload source maps on real deploys (when an auth token is provided).
  sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN },
});
