# Dev hand-off — upload reliability, logging, monitoring, Hospitable

Actionable packets for the four workstreams. Full rationale + the live Hospitable findings are in
`docs/upload-reliability-and-monitoring.md`. Decisions are **locked** (see that doc).

**Before you start:**
- The client-retry layer (`src/lib/uploadFetch.ts` + `src/app/api/upload-photos/finalize`) is **already
  committed** — build on it, don't rebuild it.
- `InventoryTab.tsx` / `MaintenanceTab.tsx` / `clean/page.tsx` have other in-flight changes —
  coordinate, don't clobber.
- Suggested order: **WS1 → WS2 → WS3 → WS4.**

## WS1 — Upload reliability hardening
The prime fail cause: `processPhoto` falls back to the **full original file** (5–12 MB) when canvas
decode fails → times out on field cellular.
- **`src/lib/photoProcess.ts`**: try **`createImageBitmap`** first (lower memory, decodes more formats,
  faster on mobile) for the downscale; fall back to `<img>`+canvas; then to a **hard size guard** — if
  a photo can't be brought under ~1–2 MB, surface a clear *"couldn't process this photo — retake it"*
  instead of silently uploading the original. Cap `MAX_DIM`.
- **`src/app/api/upload-photos/route.ts`**: reject oversized bodies with a clear **413** (not a vague
  502). Confirm neither the Next route handler nor Caddy caps body size below the max.
- **Done:** a too-large/undecodable photo gives a clear client error; no multi-MB originals hit the wire.

## WS2 — Failure logging → Google Sheet "Upload Log" (LOCKED)
Today telemetry only `console.log`s → ephemeral docker logs. Make it durable + rich.
- Create an **"Upload Log" tab** in the existing Sheet. In **`src/app/api/client-event/route.ts`**,
  replace the `console.log` with an **append** to that tab (via `getSheets()` in `src/lib/google.ts`).
  Columns: `timestamp · event · cleanId · property · uploadId · status · error · photo_size ·
  processed_size · attempts · duration_ms · fell_back · userAgent · connection`. **Best-effort**
  (telemetry must never throw into the response).
- **Enrich client telemetry** (`src/lib/clientEvent.ts` + the `uploadOne` calls in `PhotosTab.tsx`):
  add `navigator.userAgent`, `navigator.connection.effectiveType`/`downlink`, original + processed
  size, attempt count, duration, and whether `processPhoto` fell back.
- Also log the **server-side** upload `catch` (route.ts) to the same tab with the Drive error.
- **Done:** every failure lands a diagnosable row; sortable by device / connection / size / error.

## WS3 — Monitoring
- **`src/app/api/health/route.ts`** (new): a cheap Google-auth check (lightweight Drive/Sheets metadata
  call) → `200 {ok:true}` / `503`. No secrets leaked, no auth required (so an external monitor can hit
  it).
- **Sentry** (`@sentry/nextjs`): client + server init, `SENTRY_DSN` in `.env`, source maps + a release
  tag per deploy. Captures upload exceptions, the Claude/inventory path, and render crashes.
- **Operator task (not code):** point an uptime monitor (UptimeRobot / Better Stack free) at
  `https://clean.brownstonevacations.com/api/health`.
- **Done:** downtime / broken-Google-auth → uptime alert; stack-traced errors → Sentry.

## WS4 — Hospitable live properties (`HOSPITABLE_API_TOKEN` in `.env`)
Replace the hardcoded `src/lib/properties.ts` list with a live pull (data shape validated via MCP:
`{id, name, public_name, address.city}`; 34 total in the account).
- **Hospitable REST API** (`Authorization: Bearer ${HOSPITABLE_API_TOKEN}`; confirm the exact public-API
  base/version in Hospitable's docs).
- **Filter `address.city ∈ {"Cle Elum", "Ronald"}`** → the 17-property Suncadia cleaning set. Excludes
  the 16 Florida (Kissimmee/Davenport) homes + Whidbey (Oak Harbor) — **EXCLUDED per operator decision.**
- **Display label = `name`**, strip the leading `'a - '/'b - '/'c - '` prefix + collapse whitespace
  (`'a - 100 Black Nugget Ln'` → `'100 Black Nugget Ln'`). NOT `public_name` (the long marketing title).
- Keep the Hospitable **`id`** per property (store on the clean → future reservation/task linkage).
- Serve via a cached server route (`/api/properties`, TTL ~daily) and **fall back to the current
  hardcoded `PROPERTIES` if Hospitable is unreachable** so the picker never breaks.
- **Done:** picker shows the live Cle Elum/Ronald set (auto-includes `100 Black Nugget Ln` +
  `1170 Airport Road`, missing today); Hospitable downtime falls back gracefully.
