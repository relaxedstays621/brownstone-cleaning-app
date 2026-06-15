import { NextResponse } from "next/server";
import { verifyGoogleAuth } from "@/lib/google";

// Never cached/prerendered — a health check must reflect live state, and this
// keeps it out of the build-time static-generation path.
export const dynamic = "force-dynamic";

// Public (no auth) so an external uptime monitor can hit it. Returns only a
// boolean — no token, email, or config detail leaks. 200 healthy / 503 down.
// The dominant failure mode is the Google OAuth refresh token expiring, which
// otherwise breaks every upload/sheet write silently.
export async function GET() {
  const googleAuth = await verifyGoogleAuth();
  return NextResponse.json(
    { ok: googleAuth, googleAuth },
    { status: googleAuth ? 200 : 503 }
  );
}
