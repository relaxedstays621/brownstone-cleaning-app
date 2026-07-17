import { cookies } from "next/headers";
import { createHash } from "crypto";

const SESSION_COOKIE = "bct_session";

// Bump to invalidate EVERY existing session in one shot (one-time flush). Folded
// into the token hash, so old cookies stop matching → forced re-login → the
// re-login lands the client on current code via the version gate. Bumped to "v3"
// on the team-logins deploy (v2 cookies were identity-less; the flush makes every
// phone re-log-in with its team password and come back with an identity).
const TOKEN_VERSION = "v3";

// Absolute session lifetime. The token is static (can't express age), so the
// cookie VALUE carries an issued-at and getSession() enforces the max age;
// maxAge is a matching browser-side backstop.
const ABSOLUTE_MAX_MS = 16 * 60 * 60 * 1000; // 16h

// The team name is folded into the hash, so the plaintext name segment in the
// cookie is tamper-proof: forging a different name breaks the token match.
// The legacy shared password maps to team "" (blank identity) — same hash shape.
function getSessionToken(teamName: string): string {
  const secret = process.env.SESSION_SECRET || "default-secret";
  return createHash("sha256")
    .update(`${secret}:${TOKEN_VERSION}:${teamName}`)
    .digest("hex");
}

function encodeTeam(teamName: string): string {
  return Buffer.from(teamName, "utf8").toString("base64url");
}

function decodeTeam(encoded: string): string | null {
  try {
    return Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

export interface Session {
  team: string; // canonical team name; "" for legacy shared-password logins
}

// Cookie value = "<base64url(team)>.<token>.<issuedAtMs>". Old v2 cookies have
// only two segments, so they fail the shape check — that plus the version bump
// flushes them.
export async function getSession(): Promise<Session | null> {
  const cookieStore = await cookies();
  const value = cookieStore.get(SESSION_COOKIE)?.value;
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [teamEncoded, token, issuedAtStr] = parts;
  const team = decodeTeam(teamEncoded);
  if (team === null) return null;
  if (token !== getSessionToken(team)) return null;
  const issuedAt = Number(issuedAtStr);
  if (!Number.isFinite(issuedAt)) return null;
  if (Date.now() - issuedAt >= ABSOLUTE_MAX_MS) return null;
  return { team };
}

// Thin wrapper so pre-teams call sites keep compiling unchanged.
export async function isAuthenticated(): Promise<boolean> {
  return (await getSession()) !== null;
}

export function getSessionCookieConfig(teamName: string) {
  return {
    name: SESSION_COOKIE,
    value: `${encodeTeam(teamName)}.${getSessionToken(teamName)}.${Date.now()}`,
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
