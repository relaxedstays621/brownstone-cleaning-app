import { cookies } from "next/headers";
import { createHash } from "crypto";

const SESSION_COOKIE = "bct_session";

// Bump to invalidate EVERY existing session in one shot (one-time flush). Folded
// into the token hash, so old cookies stop matching → forced re-login → the
// re-login lands the client on current code via the version gate. Bumped to "v2"
// on the force-latest-version deploy (was the bare sha256(SESSION_SECRET)).
const TOKEN_VERSION = "v2";

// Absolute session lifetime. The token is static (can't express age), so the
// cookie VALUE carries an issued-at and isAuthenticated() enforces the max age;
// maxAge is a matching browser-side backstop.
const ABSOLUTE_MAX_MS = 16 * 60 * 60 * 1000; // 16h

function getSessionToken(): string {
  const secret = process.env.SESSION_SECRET || "default-secret";
  return createHash("sha256").update(`${secret}:${TOKEN_VERSION}`).digest("hex");
}

// Cookie value = "<token>.<issuedAtMs>". Old bare-token cookies fail the split
// (no issued-at → NaN), which also flushes them.
export async function isAuthenticated(): Promise<boolean> {
  const cookieStore = await cookies();
  const value = cookieStore.get(SESSION_COOKIE)?.value;
  if (!value) return false;
  const [token, issuedAtStr] = value.split(".");
  if (token !== getSessionToken()) return false;
  const issuedAt = Number(issuedAtStr);
  if (!Number.isFinite(issuedAt)) return false;
  return Date.now() - issuedAt < ABSOLUTE_MAX_MS;
}

export function getSessionCookieConfig() {
  return {
    name: SESSION_COOKIE,
    value: `${getSessionToken()}.${Date.now()}`,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: Math.floor(ABSOLUTE_MAX_MS / 1000), // 16h backstop (was 7 days)
  };
}

export function getSessionClearConfig() {
  return {
    name: SESSION_COOKIE,
    value: "",
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: 0,
  };
}
