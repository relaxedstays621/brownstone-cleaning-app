# Spec — Force-latest-version + auto-logout (cleaner stale-app fix)

Status: **PLANNED 2026-06-16.** Targets the recurring "I uploaded but the photos are missing" failure.

## Problem
Cleaners' missing 6/13–6/14 photos never reached the server (blank `# Photos` in the Clean Log, empty
`clean_<id>` session folders pruned by the nightly cleanup). The live upload path is healthy as of the
6/15 deploy (WS1 retries + WS2 Upload Log). The remaining cause is a **stale client**: the app runs as a
long-lived home-screen tab holding weeks-old JS (pre-WS1, no retries), and because the `bct_session`
cookie is a **static `sha256(SESSION_SECRET)` token valid 7 days** (`src/lib/auth.ts`), cleaners rarely
hit login and never pick up new code. There is **no service worker** and `next.config.mjs` already sends
`Cache-Control: no-store` on every path — so the staleness is the in-memory tab, which only a runtime
version check + forced re-login can fix.

## Goal
Make it impossible for a cleaner to keep running stale code. Three cooperating mechanisms:
1. **Runtime version poll** — catches an already-logged-in stale tab proactively.
2. **Auto-logout** — forces cleaners back to login regularly (today nothing does).
3. **Login version gate** — blocks login on a stale version → forces the refresh.

## Decisions (locked 2026-06-16)
- Auto-logout: **30 min idle + 16h absolute**.
- Mid-session stale handling: **auto-refresh only when safe** (no unsaved/in-flight photos).
- Version id: **git short SHA**.

---

## Part A (P0) — Version gate
1. **Build-version plumbing** — `Dockerfile`: `ARG APP_VERSION`; `ENV NEXT_PUBLIC_APP_VERSION=$APP_VERSION`
   (inlined into the client bundle at build time) **and** `ENV APP_VERSION=$APP_VERSION` (server runtime).
   Deploy passes `--build-arg APP_VERSION=$(git rev-parse --short HEAD)`. **Document in the deploy runbook —
   if the arg isn't passed each build, the gate is a no-op.**
2. **`src/app/api/version/route.ts`** (new) — public, `force-dynamic`, uncached → `{ version:
   process.env.APP_VERSION ?? null }` (mirror `/api/health`).
3. **`VersionGate` client component** mounted in `src/app/layout.tsx` — knows
   `process.env.NEXT_PUBLIC_APP_VERSION`; polls `/api/version` (`cache:'no-store'`) on mount,
   `visibilitychange`→visible, window `focus`, and a ~60s interval. On a **confirmed mismatch**:
   - **Login page / no work in progress:** hard-block + `location.reload()` (best-effort `caches` clear +
     SW-unregister, for future-proofing).
   - **Mid-clean:** show an "Update available" banner; **auto-reload only when `!anyDirty && !anyBusy`** —
     reuse the Submit All dirty/busy state (lift it to a small context or a window flag the clean page
     sets). Never reload over an in-flight upload.
   - ⚠️ **Guardrail:** a failed/timed-out `/api/version` fetch (weak field signal) must **never** block or
     reload — only a confirmed mismatch acts. Protects the cellular-weak field users.
4. **Server-enforced login gate** — `src/app/page.tsx` sends its `NEXT_PUBLIC_APP_VERSION` (header
   `x-app-version`) on `/api/auth/check` + `/api/auth`; the `/api/auth` route returns **409 "please
   refresh"** when it ≠ `APP_VERSION` (missing/old also → 409). The page shows "Update required" + reloads.
   This is the real lock (client checks can be raced).

## Part B (P1) — Auto-logout
5. **Absolute 16h (server-enforced):** the static token can't express age, so extend the cookie value to
   carry an issued-at (e.g. `${token}.${issuedAtMs}`) and have `isAuthenticated()` require the token to
   match **and** `now - issuedAt < 16h`; set cookie `maxAge` to 16h as a backstop (down from 7 days).
   Touch `getSessionCookieConfig` + `isAuthenticated` in `src/lib/auth.ts`.
6. **Idle 30 min (client):** a `SessionTimeout` component (in layout, active only when authed) — activity
   listeners reset a timer; on 30 min idle → `POST /api/auth/logout` → redirect `/`. **Guard:** defer
   logout while `anyBusy` (upload in flight).
7. **`src/app/api/auth/logout/route.ts`** (new) — clears `bct_session`.

## One-time flush of currently-stale clients
The feature prevents *future* staleness, but clients already on old JS with a live 7-day cookie won't be
aged out by the new server logic (their existing cookie has no issued-at). To flush everyone **once** on
this deploy: rotate the session token (fold a version constant into `getSessionToken()`), invalidating all
existing cookies → forces re-login → lands them on current code via the new gate. (Otherwise the current
cleaner needs one manual hard-refresh.)

## P2 — Finish-count cleaner feedback (the tripwire)
The cleaner-facing signal that would have caught this immediately. At finish-clean, **show the count of
photos successfully uploaded for this clean** ("12 photos uploaded for this clean"). If the count is **0**,
warn prominently before/at finish ("No photos uploaded for this clean — go back and add photos?") so the
cleaner notices same-day while the photos are still on the device. Source the count from the Photos-tab
success tally (the per-photo `success` statuses already tracked) and surface it in the finish modal /
confirmation, alongside the existing Submit All flow. Mirrors the Clean Log `# Photos` tripwire, but
in the cleaner's face at the moment it matters.

## Verification
- Bump `APP_VERSION` + deploy: an open old tab shows the update within ~60s (or on focus) and reloads
  **only when safe**; a stale login returns 409 + forced refresh. A *failed* version fetch → no lockout.
- Idle 30 min → logged out; 16h after login → forced re-login; **neither fires during an active upload.**
- After this deploy, all existing sessions are logged out once (token rotation).
- Finish a clean with photos → finish screen shows the correct count; finish with zero → the 0-photos
  warning appears.

## Deploy notes
- `NEXT_PUBLIC_*` bakes at **build** time → this rides a rebuild (the same one a Sentry DSN go-live would
  use — consider batching) via the OOM-safe build dance (temp swapfile + cached build + compose up).
- Pass `--build-arg APP_VERSION=$(git rev-parse --short HEAD)` on the build.

## Out of scope
- Service worker / full PWA install.
- The cleanup-cron "keep empty session folders 7 days" change (dev's separate suggestion — good, track
  separately): would leave a visible breadcrumb for a no-photo clean instead of pruning the empty folder.
