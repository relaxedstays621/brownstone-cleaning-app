import { NextResponse } from "next/server";

// Public, uncached: the client polls this to detect a deploy and force a refresh
// of stale long-lived tabs. Returns the server build's git short SHA (baked via
// the APP_VERSION build-arg) or null when the build-arg wasn't passed (gate off).
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ version: process.env.APP_VERSION ?? null });
}
