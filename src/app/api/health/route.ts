import { NextResponse } from "next/server";
import { verifyGoogleAuth, verifyMaintenanceFolder } from "@/lib/google";

// Never cached/prerendered — a health check must reflect live state, and this
// keeps it out of the build-time static-generation path.
export const dynamic = "force-dynamic";

// Public (no auth) so an external uptime monitor can hit it. Returns only
// booleans + a coarse reason string — no token, email, or full config leaks.
// 200 healthy / 503 down. Two failure modes it catches, both of which otherwise
// break uploads/sheet writes silently:
//   - Google OAuth refresh token expiring (breaks everything).
//   - The maintenance Drive folder being deleted/misconfigured — this exact
//     outage ran ≥4 days unnoticed because only the cleaner saw the failure.
export async function GET() {
  const [googleAuth, maintFolder] = await Promise.all([
    verifyGoogleAuth(),
    verifyMaintenanceFolder(),
  ]);
  const ok = googleAuth && maintFolder.ok;
  return NextResponse.json(
    {
      ok,
      googleAuth,
      maintenanceFolder: maintFolder.ok,
      ...(maintFolder.ok ? {} : { reason: maintFolder.reason }),
    },
    { status: ok ? 200 : 503 }
  );
}
