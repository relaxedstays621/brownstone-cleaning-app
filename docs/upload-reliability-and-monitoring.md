# Plan — Upload reliability, failure logging, monitoring, + Hospitable properties

Four workstreams for the cleaning app (live, mobile, field-cellular). WS1+WS2 are the immediate
build (reliability + a durable failure log); WS3 is scoped; WS4 is the next build.

## ⚠️ First: land the in-flight work (uncommitted in the tree, 2026-06-15)
The working tree already has a strong client-retry layer **not yet committed** — commit + verify it
before building on top (and don't clobber it):
- `src/lib/uploadFetch.ts` (untracked) — `uploadWithRetry`: 4 attempts, 45s per-attempt timeout,
  exponential backoff + jitter, retryable-status classification (408/429/5xx + network/abort),
  dedup-safe (uploadId).
- `src/app/api/upload-photos/finalize/route.ts` — separate Sheet-count update (with a UI retry).
- Modified `PhotosTab.tsx` / `InventoryTab.tsx` / `MaintenanceTab.tsx` / `clean/page.tsx`.
This is the foundation for WS1; ship it first.

## What already exists (credit — don't rebuild)
Per-photo uploads (not batched) · client-side resize to 1600px / q0.82 + timestamp overlay
(`photoProcess.ts`) · concurrency 2 (field-cellular headroom) · server `withRetry` on Drive ops (3×,
30s timeout) · **dedup by `uploadId`** (Drive `appProperties`) so retries never duplicate · per-photo
failed-retry button · finalize separated from upload. The architecture is sound; the gaps are below.

## WS1 — Reliability: close the remaining failure modes
1. **The full-size fallback is the prime suspect.** `processPhoto` returns the **original file** when
   canvas decode fails (memory, corrupt, Android-HEIC). A phone's original is 5–12 MB → on weak
   cellular that blows the 45s timeout → "fail." Fixes:
   - Prefer **`createImageBitmap`** (lower-memory, decodes more formats, faster on mobile) for the
     downscale; fall back to `<img>`+canvas, then to original.
   - **Hard size/dimension guard:** if a photo can't be brought under a target (~1–2 MB), surface a
     clear *"couldn't process this photo, try retaking"* rather than silently uploading a huge file.
   - Note: iOS Safari decodes HEIC in canvas (so iPhones usually convert fine); the risk is the
     *fallback path*, not HEIC per se. A size guard covers both.
2. **iOS memory crashes** on large canvas ops (older iPhones) → silent tab death. `createImageBitmap`
   with resize options + capping `MAX_DIM` reduces this.
3. **Server-side size guard:** `upload-photos/route.ts` should reject oversized bodies with a clear
   **413** (not a vague 502), and confirm neither the Next route handler nor Caddy caps body size
   below our max. (Resized photos ~300 KB are fine; the guard is for the fallback path.)
4. **Timeout alignment:** server Drive timeout (30s) < client per-attempt (45s) — a slow Drive create
   fails server-side first → 502 → client retry. Fine, but document it; consider Drive **resumable
   upload** for very weak links (Phase 2 — bigger lift).
5. **Whole-app failure mode:** the Google **OAuth refresh token** — if revoked/expired, *every* upload
   fails non-retryably. WS3's health check + uptime alert must catch this.

## WS2 — Failure logging system (the explicit ask)
Today telemetry (`reportClientEvent` → `/api/client-event`) only `console.log`s → lands in the
container's ephemeral docker logs: not queryable, lost on restart/rotation. Make it **durable + rich**:
- **Persist to a Google Sheet tab "Upload Log"** (zero new infra, already in the stack, operator can
  eyeball). The `/api/client-event` route appends a row per event — *especially failures*. Columns:
  `timestamp · event · cleanId · property · uploadId · status · error · photo_size · processed_size ·
  attempts · duration_ms · fell_back(bool) · userAgent · connection`.
- **Enrich the client telemetry** so failures are diagnosable: add `navigator.userAgent`,
  `navigator.connection.effectiveType`/`downlink`, original + processed size, attempt count, duration,
  and whether `processPhoto` fell back to the original. Field failures correlate with device +
  connection — capture both.
- **Log server-side upload failures too** (the `catch` in `upload-photos/route.ts`) with the Drive
  error detail, to the same Sheet.
- This answers "track what's failing": one sheet the operator (or a dev) can sort/filter to see *which
  devices, properties, sizes, and errors* dominate.

## WS3 — App monitoring (scope)
Three layers — domain log (WS2) + uptime + error tracking:
1. **`/api/health` endpoint** (new) — verifies Google auth (a cheap Drive/Sheets call) + returns
   200/503. Cheap, no secrets leaked.
2. **Uptime monitor** — UptimeRobot or Better Stack (free tier) pings `/api/health` every 1–5 min →
   email/SMS/Slack alert on down. Catches the app down *and* a broken Google refresh token (WS1 #5).
3. **Error tracking — Sentry** (`@sentry/nextjs`): client + server exceptions with stack traces,
   device/UA, breadcrumbs, release tagging. Free tier fits this volume. Captures upload exceptions,
   the inventory/Claude path, and render crashes — the "errors and breaks" the WS2 sheet won't show.
   Set up source maps + a release on each deploy.
- **Alerting:** Sentry on new/spiking errors; uptime on downtime; optional daily email digest of the
  Upload Log sheet. *(Zero-SaaS alternative: skip Sentry, lean on the sheet + a cron error digest +
  uptime monitor — but Sentry is the right tool for stack-traced breaks.)*

## WS4 — Hospitable live properties (next build) — GROUNDED via MCP pull (2026-06-15)
Replace the hardcoded `src/lib/properties.ts` list with a **live pull from Hospitable**. The app uses
the Hospitable **REST API** (`HOSPITABLE_API_TOKEN` in env), **not the MCP** (the MCP is the agent
interface; used here only to validate the data).

**Live account shape (verified):** **34 properties total**, but the cleaning team services only the
**Cle Elum + Ronald, WA (Suncadia) set = 17**. The account also holds **16 Florida Disney homes**
(Kissimmee/Davenport) + **1 Whidbey Island** (Oak Harbor) oceanfront — NOT cleaned by this team.
➜ **A naive "list all properties" dumps all 34 (incl. Florida) into the picker. Filtering is required.**

- **Filter = geography:** `address.city ∈ {"Cle Elum", "Ronald"}` (WA). `tags` are mostly empty +
  opaque numeric IDs (unusable as a filter); `listed` is `true` for all — so city is the reliable key.
  - **Whidbey Island Retreat** (Oak Harbor, WA) is **EXCLUDED** (operator decision 2026-06-15) — filter
    stays Cle Elum/Ronald only; revisit if this team starts cleaning it.
- **Display label = Hospitable `name`** (e.g. `'a - 100 Black Nugget Ln'`, `'4006  - Suncadia Unit'`),
  **NOT `public_name`** (the long marketing title like "4006 Suncadia Lodge Pool and Hot-Tub Access…").
  Normalize: strip the leading `'a - '/'b - '/'c - '` portfolio prefix + collapse whitespace →
  `'100 Black Nugget Ln'`, `'4006 - Suncadia Unit'`. Matches the current `'#### - Suncadia Unit'` style.
- **Value proof:** the live Cle Elum set has **2 units the hardcoded list is missing** —
  `100 Black Nugget Ln` and `1170 Airport Road`. Going live auto-adds them (and future units), no code
  change — the whole point.
- **Keep the Hospitable `id` (UUID)** per property on the clean — unlocks later linkage (tie a clean to
  the reservation, auto-create a Hospitable task, pull next check-in).
- **Build:** server route `/api/properties` → Hospitable `GET /properties` (`per_page=100`, handle
  pagination defensively) → filter to Cle Elum/Ronald → map+normalize `name` → keep `{id, label}` →
  **cache** (TTL ~daily / Next `revalidate`) → **fall back to the current hardcoded list if Hospitable
  is unreachable** so the picker never breaks.

## Sequencing
1. Commit the in-flight reliability layer (uploadFetch + finalize + tabs).
2. WS1 hardening (createImageBitmap + size guards) — kills the biggest fail source.
3. WS2 durable Upload Log + enriched telemetry — so you can *see* what's left failing.
4. WS3 health endpoint + uptime monitor (quick) → Sentry.
5. WS4 Hospitable properties (next build; validate names via MCP first).

## Decisions (locked 2026-06-15)
- **Failure-log home → Google Sheet "Upload Log" tab** (no new infra; operator-readable).
- **Error tracking → Sentry** (`@sentry/nextjs`) for stack-traced errors/breaks app-wide.
- **WS4 display name → Hospitable `name`**, strip `a-/b-/c-` prefix + normalize whitespace (resolved
  from the live pull).
- **WS4 filter → `city ∈ {Cle Elum, Ronald}` only; Whidbey + Florida EXCLUDED.**
