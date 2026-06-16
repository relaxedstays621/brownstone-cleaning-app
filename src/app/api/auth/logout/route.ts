import { NextResponse } from "next/server";
import { getSessionClearConfig } from "@/lib/auth";

export async function POST() {
  const res = NextResponse.json({ success: true });
  res.cookies.set(getSessionClearConfig());
  return res;
}
