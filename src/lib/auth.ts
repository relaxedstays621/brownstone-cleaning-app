import { cookies } from "next/headers";
import { createHash } from "crypto";

const SESSION_COOKIE = "bct_session";

function getSessionToken(): string {
  const secret = process.env.SESSION_SECRET || "default-secret";
  return createHash("sha256").update(secret).digest("hex");
}

export async function isAuthenticated(): Promise<boolean> {
  const cookieStore = await cookies();
  const session = cookieStore.get(SESSION_COOKIE);
  return session?.value === getSessionToken();
}

export function getSessionCookieConfig() {
  return {
    name: SESSION_COOKIE,
    value: getSessionToken(),
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: 60 * 60 * 24 * 7, // 7 days
  };
}
