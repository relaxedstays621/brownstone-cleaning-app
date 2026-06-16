import { NextRequest, NextResponse } from "next/server";
import { getSessionCookieConfig } from "@/lib/auth";

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

  if (password !== process.env.CLEANING_APP_PASSWORD) {
    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  }

  const cookie = getSessionCookieConfig();
  const res = NextResponse.json({ success: true });
  res.cookies.set(cookie);
  return res;
}
