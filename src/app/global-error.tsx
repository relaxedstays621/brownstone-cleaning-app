"use client";

// App Router global error boundary. Without this, render errors thrown above
// the route segments (i.e. in the root layout/template) are not reported to
// Sentry — @sentry/nextjs warns about exactly this at build time. It replaces
// the root layout when it renders, so it must ship its own <html>/<body> and
// can't rely on Tailwind/global CSS being present.

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body>
        <div
          style={{
            minHeight: "100vh",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
            fontFamily: "system-ui, -apple-system, sans-serif",
          }}
        >
          <div style={{ textAlign: "center", maxWidth: 360 }}>
            <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>
              Something went wrong
            </h1>
            <p style={{ color: "#555", marginBottom: 16 }}>
              The app hit an unexpected error. Your submitted work is safe — please
              try again.
            </p>
            <button
              onClick={() => reset()}
              style={{
                background: "#2563eb",
                color: "#fff",
                border: "none",
                borderRadius: 12,
                padding: "12px 20px",
                fontSize: 16,
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              Try again
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
