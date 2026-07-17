import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { findTeamByName } from "@/lib/teams";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ authenticated: false });
  }
  // defaultProperty comes from live config (not the cookie) so an .env edit
  // takes effect without re-login. Config errors just drop the extras —
  // auth/check must never 500 on a bad env edit.
  let defaultProperty: string | undefined;
  try {
    defaultProperty = findTeamByName(session.team)?.defaultProperty;
  } catch {
    defaultProperty = undefined;
  }
  return NextResponse.json({
    authenticated: true,
    team: session.team,
    defaultProperty: defaultProperty ?? null,
  });
}
