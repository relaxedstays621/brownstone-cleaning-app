import { NextRequest, NextResponse } from "next/server";
import { getSessionCookieConfig } from "@/lib/auth";
import { findTeamByPassword } from "@/lib/teams";

export async function POST(req: NextRequest) {
  // Version gate (the real lock — client checks can be raced). When the build
  // carries a version, a stale client (missing/old x-app-version) is blocked
  // with 409 so it must refresh to current code before it can log in. No-op when
  // APP_VERSION isn't set (build-arg not passed).
  const serverVersion = process.env.APP_VERSION;
  if (serverVersion) {
    const clientVersion = req.headers.get("x-app-version");
    if (clientVersion !== serverVersion) {
      return NextResponse.json(
        { error: "stale", message: "A new version is available — please refresh." },
        { status: 409 }
      );
    }
  }

  const { password } = await req.json();

  // WHICH password was typed is the identity: CLEANING_TEAMS maps password →
  // canonical team name (legacy shared password → name "" during rollout).
  let team;
  try {
    team = findTeamByPassword(typeof password === "string" ? password : "");
  } catch (err) {
    // Malformed CLEANING_TEAMS (bad JSON, duplicate passwords). Loud 500 —
    // silently falling back could attribute one team's work to another.
    console.error("[auth] team config error:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Login misconfigured" }, { status: 500 });
  }
  if (!team) {
    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  }

  const cookie = getSessionCookieConfig(team.name);
  const res = NextResponse.json({ success: true, team: team.name });
  res.cookies.set(cookie);
  return res;
}
