import { NextRequest, NextResponse } from "next/server";
import { getSessionCookieConfig } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const { password } = await req.json();

  if (password !== process.env.CLEANING_APP_PASSWORD) {
    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  }

  const cookie = getSessionCookieConfig();
  const res = NextResponse.json({ success: true });
  res.cookies.set(cookie);
  return res;
}
