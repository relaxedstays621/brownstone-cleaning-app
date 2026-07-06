# Spec — Aborted-upload retry + stale-client escape hatch

Two safe fixes prompted by a 2026-07-04 field incident ("cleaner couldn't upload photos"). Extends
[upload-reliability-and-monitoring.md](./upload-reliability-and-monitoring.md) and
[version-gate-and-auto-logout.md](./version-gate-and-auto-logout.md).

> Status (2026-07-06): **PLANNED.** Own branch off the current default. No new deps. No migration.

## Incident + root cause

07-04 ~1PM PST, cleaner reported photos wouldn't upload (clean session `397ee400`). Prod logs
(`brownstone-cleaning-app-app-1`), same session, same window:

```
[upload-photos] cleanId=397ee400… uploadId=e052fe37… size=251583
[upload-photos] formData parse error: Error: aborted
Error: Failed to find Server Action "x". This request might be from an older or newer deployment. ×3
```

Findings:

- This codebase has **no Server Actions** (all `/api/*` route handlers), and there was **no deploy on 07-04**
  (container up since 06-16). So the phone was running a **very old cached bundle** — old enough to still emit
  Server-Action requests, i.e. pre-route-handler refactor and almost certainly **pre-VersionGate**.
- The version gate **is** correctly armed for current clients: the build SHA (`NEXT_PUBLIC_APP_VERSION`) is inlined
  in the client chunks and matches `/api/version`. So the gate wiring is fine — but a bundle that predates the gate
  has no gate code to self-heal.
- Separately, `req.formData()` aborting mid-parse is handled as a terminal **400**, which the client does **not**
  retry — a latent bug that hurts every cleaner on flaky cellular.

Two safe fixes below; the already-stuck 07-04 device needs a one-time operator cache-clear (code can't rescue a
pre-gate tab).

## Fix 1 — Make an aborted upload retryable (real latent bug)

**File:** `src/app/api/upload-photos/route.ts` (the `formData()` catch, ~lines 50-56).

- Today: `req.formData()` throws → catch → returns **400** "Invalid form data".
- Bug: the client (`src/lib/uploadFetch.ts`) only retries `RETRYABLE_STATUS = {408,429,500,502,503,504}`. **400 is
  terminal**, so an aborted/incomplete body (dropped cellular) is never retried — the photo just fails.
- **Fix:** distinguish an **aborted/incomplete** body from a genuinely malformed one. If the error is an abort /
  connection reset (`err.message === 'aborted'`, or `code` ECONNRESET / ECONNABORTED / Node "aborted"), return a
  **retryable 408** so `uploadWithRetry` re-sends it. Keep **400** only for truly malformed data. Retrying is safe:
  the route dedups by `uploadId` (`findExistingByUploadId`), so a re-send can't duplicate in Drive.
- Add the chosen status to the existing log line.
- **Mirror** the same fix in `src/app/api/maintenance/upload-photo/route.ts` if it shares the identical
  formData-catch pattern (check first).

## Fix 2 — Stale-client escape hatch (visible "update" banner)

**Files:** `src/app/VersionGate.tsx` (+ the `busy` computation in `src/app/clean/page.tsx`).

- **Root gap:** on a confirmed version mismatch the gate reloads only when **not busy**, and `busy` includes
  `photosBusy`. A client stuck failing uploads is **perpetually busy** → the gate can never fire → the cleaner is
  silently trapped on dead code. (Cache headers are already `no-store` and the gate is armed, so **headers are not
  the lever — this is**.)
- **Fix:** when a mismatch is confirmed but auto-reload is deferred because of `busy`, surface a visible, tappable
  **"A new version is available — tap to update"** banner. Tapping = `location.reload()`. This gives a **manual
  escape** instead of a silent trap.
  - Do **not** auto-reload over genuinely in-flight/unsaved work — preserve the current safety (the finish modal
    already survives reload; keep that). The banner is the safe manual path.
  - Keep the existing throttle (`vg_reload`, one reload / 20s) so a stubborn cache can't reload-loop.
- Clients that predate the gate (like 07-04's) have no gate code and **cannot self-heal in code**. This fix
  prevents future stuck-busy cases; it can't retro-fix an already-ancient tab — see operator action.

## Operator action (not code)

The 07-04 cleaner's phone is on a pre-gate bundle. One-time: have them fully close the tab / **"Clear site data"**
for `clean.brownstonevacations.com` (or reinstall the PWA shortcut) so they load the current version once; the
armed gate keeps them current afterward. Confirm other cleaners uploaded fine that day (isolate to this device).

## Constraints

- Don't change the Drive upload mechanism, dedup, or the finish-photo-count logic (separate in-flight work).
- Preserve the version-gate's "never reload over unsaved/in-flight work" guarantee.
- No new deps; match existing style.

## Verification

- **Fix 1:** simulate an aborted formData / body-stream abort → route returns **408**, not 400; confirm
  `uploadWithRetry` then retries (408 ∈ RETRYABLE_STATUS). A malformed-but-complete body still → 400. Dedup still
  prevents a duplicate Drive file on retry.
- **Fix 2:** force a mismatch (mock `/api/version`) with `photosBusy=true` → the update banner appears and a tap
  reloads; with `busy=false` the existing auto-reload path is unchanged; reload never fires over unsaved work.
- **Sentry:** no new error signature introduced.

## Files touched

- `src/app/api/upload-photos/route.ts` — aborted → 408.
- `src/app/api/maintenance/upload-photo/route.ts` — mirror, if same pattern.
- `src/app/VersionGate.tsx` (+ `src/app/clean/page.tsx`) — update banner + busy-deferred escape hatch.
