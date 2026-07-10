# Spec — Maintenance uploads, upload speed, finish notification, and property sync

Four field issues reported 2026-07-10 (clean `9b56623a-0f01-4c2c-aecf-105fae6fa51e`, property
"2038 - Suncadia Unit"). Diagnosed against prod (`brownstone-cleaning-app-app-1` logs, the app's
own Drive account `matt@brownstonevacations.com`, and the n8n "BSV Ops Automation" workflow).
Extends [upload-reliability-and-monitoring.md](./upload-reliability-and-monitoring.md).

> Status (2026-07-10): **PLANNED.** Own branch off `main`. No new deps. No sheet-schema migration.
> **WS1 is a live outage** — every maintenance photo has failed for ≥4 days (80 errors in 96h).

## Summary of the four reports → root causes

| # | Report | Root cause (verified) | Fix owner |
|---|--------|-----------------------|-----------|
| 1 | Maintenance photos fail to upload | The configured maintenance Drive folder **no longer exists**. `GOOGLE_DRIVE_MAINTENANCE_FOLDER_ID` (`1Mc2pPK-…`) **and** the old hardcoded literal (`1IK2Zfj…`) both return `File not found`; a Drive scan of the app's account finds **no** maintenance folder and **zero** `maintenance_<cleanId>` subfolders. So there is nothing to point at — a folder must be **created**. Cleaning photos are unaffected (they nest under the valid "Brownstone Cleanings" root). | Operator (create folder + env) + code (guardrail) — WS1 |
| 2 | Uploads should start immediately; cleaners complain uploads are slow | Photos are staged as `pending` and only upload when the cleaner **taps "Upload N Photos"**; nothing uploads in the background while they keep working. Concurrency is 2 and each worker processes-then-uploads serially. | Code — WS2 |
| 3 | Slack notification arrived with blank Finish Time / Photos / Maintenance / Inventory | The n8n trigger is Google Sheets **`rowAdded` on "Clean Log"**, polling every minute. `start-clean` appends the row **at clean start** with those cells blank, so the notification always fires at start, never reflecting finish. | Code (emit at finish) + operator (n8n retrigger) — WS3 |
| 4 | New properties need to appear automatically | `select-property` reads the static 15-item `src/lib/properties.ts`; there is no `/api/properties` route and no Hospitable sync wired to the UI. | Code — WS4 |

Suggested order: **WS1 (outage) → WS2 (speed, the biggest cleaner-facing win) → WS3 → WS4.**

---

## WS1 — Maintenance photo uploads (LIVE OUTAGE)

**Evidence.** Every maintenance upload fails at folder resolution:

```
[maint-upload] cleanId=9b56623a… uploadId=b191… size=176444
[maint-upload] failed uploadId=b191…: Error: File not found: 1Mc2pPK-MbW4qc6nsFD8SBayOoPdAOJQ6
    parents: ["1Mc2pPK-MbW4qc6nsFD8SBayOoPdAOJQ6"]   ← GOOGLE_DRIVE_MAINTENANCE_FOLDER_ID
```

A read-only Drive scan with the app's own credentials (account `matt@brownstonevacations.com`)
established:
- `GOOGLE_DRIVE_MAINTENANCE_FOLDER_ID` (`1Mc2pPK-MbW4qc6nsFD8SBayOoPdAOJQ6`) → **File not found**.
- The old hardcoded literal (`1IK2ZfjC2Hsx5Mh8mvqwIxEqLEWkNBT5v`, removed in `63b5447`) → **File not found**.
- **No** folder named "*maintenance*" exists anywhere the account can see; **no** `maintenance_<cleanId>`
  subfolders exist. Maintenance photos have had no valid destination since the folder was deleted.
- The cleaning root "Brownstone Cleanings" (`1E_Urovk166JtFFIQRJfZ_5sfMCwo9vSG`) is valid and owned by
  the same account — which is why cleaning uploads work and maintenance ones don't.

**Reachability note (important for where to put the new folder):** the app's Drive calls do **not**
pass `supportsAllDrives`/`includeItemsFromAllDrives`. To be reachable by the same calls that already
work for cleaning, the new maintenance folder must live in the **same Drive** as "Brownstone
Cleanings" (i.e. `matt@brownstonevacations.com`'s My Drive), not a Shared Drive the app can't traverse.

### Fix 1a — Operator (unblocks the outage immediately, no deploy) — FOLDER READY
- The folder has been created: **"Maintenance Photos"** =
  **`1TxKDg7iF6svNljn3cUcd7cWp3J50-34-`**, a subfolder of "Brownstone Cleanings"
  (`1E_Urovk166JtFFIQRJfZ_5sfMCwo9vSG`). Verified 2026-07-10 with the app's own creds: owned by
  `matt@brownstonevacations.com`, not trashed, My Drive (not a Shared Drive), `canAddChildren=true`
  → the app can create its `maintenance_<cleanId>` subfolders inside it.
- **Action:** set `GOOGLE_DRIVE_MAINTENANCE_FOLDER_ID=1TxKDg7iF6svNljn3cUcd7cWp3J50-34-` in `.env`;
  restart the container. No code/deploy needed for the unblock.
- **Verify:** upload one maintenance photo end-to-end → it lands in the folder; no `File not found`
  in logs; the finish-clean maintenance count reflects it.

### Fix 1b — Code guardrail (so a missing folder fails visibly, not silently per-upload)
- **`src/app/api/health/route.ts`** + **`src/lib/google.ts`**: extend the health check to confirm the
  maintenance root resolves (cheap `drive.files.get(MAINTENANCE_DRIVE_ROOT_FOLDER_ID, fields:'id,trashed')`).
  Missing/trashed → `503` with a clear reason, so the uptime monitor catches it instead of only the
  cleaner. (This exact outage ran ≥4 days unnoticed.)
- **`src/app/api/maintenance/upload-photo/route.ts`**: when the Drive error is a parent
  `File not found`/404 on the configured folder, return a **distinct labeled error** (not a generic
  502) and `appendUploadLog` a `server-maint-config-error` row so it's greppable in the Upload Log tab.
- Do **not** auto-create a maintenance root if the configured one is missing (silently writing to a
  new, unmonitored folder is worse than failing loudly).
- **Done:** a missing/misconfigured maintenance folder trips `/api/health` and logs a labeled config
  error; a correct ID uploads normally.

---

## WS2 — Upload immediately on capture + make uploads feel faster

> *User: "as soon as a photo is uploaded to the app it should start submitting to Google Drive.
> There is not a problem with more photos and the cleaners have complained about upload speed."*
> This supersedes the earlier "consolidate all submissions under Finish" idea — the answer to that
> question is **no; auto-upload on capture is better**.

**Current behavior.** In both `PhotosTab.tsx` and `MaintenanceTab.tsx`, selecting photos stages them
as `pending`; nothing uploads until the cleaner taps **"Upload N Photos"**. Uploads run at
`UPLOAD_CONCURRENCY = 2`, and each worker `processPhoto()`s (decode → resize → watermark → JPEG) and
then uploads **serially** per photo. So cleaners wait at the end, and the pipe is under-fed.

### Fix 2a — Auto-start upload the moment photos are added (primary ask)
- In `handleFileChange` (both tabs), after appending the new `pending` items, **immediately kick off
  their upload** in the background (reuse the existing `uploadStatuses(["pending"])` path) instead of
  waiting for a button tap. New selections while an upload is in flight simply join the queue.
- Keep a visible **"Retry N failed"** button for the failure path; the primary "Upload" button
  becomes redundant for the happy path (uploads are automatic). Preserve the per-photo status badges
  so the cleaner still sees progress (`…` uploading, `✓` done, `!` failed).
- Because uploads now run in the background while the cleaner keeps shooting/working, the end-of-clean
  wait mostly disappears — this is the biggest perceived-speed win and directly answers the report.
- Unchanged: dedup by `uploadId`, retry/backoff, the finish-time `busy` guard (in-flight auto-uploads
  keep the tab `busy`, so Finish still blocks until they land).

### Fix 2b — Actual throughput levers (pick the low-risk subset)
- **Raise concurrency modestly**, ideally adaptively: default `UPLOAD_CONCURRENCY` 2 → 3, and when
  `navigator.connection.effectiveType` is `4g`/`wifi` allow 4; keep 2 on `3g`/`2g`. More parallel
  requests fill a healthy pipe without swamping a weak one. (Telemetry already captures
  `effectiveType`, so we can validate the effect from the Upload Log.)
- **Pipeline process vs. upload** so decoding the next photo overlaps uploading the current one
  (processing is CPU-bound, upload is network-bound; today they're serial in one worker). Even a small
  look-ahead noticeably raises throughput on multi-photo batches.
- **Drop the per-batch `finalize` from the hot path.** Today every upload batch calls
  `/api/maintenance/upload-photo/finalize` (and the cleaning `finalize`) — an extra Drive round-trip
  that gates the "done" state. Since WS3 reconciles both counts from Drive at **finish**, the per-batch
  finalize is redundant; debounce it heavily or remove it so a photo shows `✓` as soon as its own
  upload returns, not after a whole-folder recount.
- **(Tunable, not a default change)** `MAX_DIM` 1600 / quality 0.82 currently yields ~150–500 KB
  photos (confirmed in logs). Lowering `MAX_DIM` to ~1280 cuts bytes ~35% for weak-link speed, at some
  detail cost — leave at 1600 unless field testing shows uploads are still too slow.
- Do **not** change the resilient-retry/timeout logic or dedup.

**Done:** photos begin uploading the instant they're added; on a normal connection a batch completes
in the background well before Finish; failed photos still surface a Retry.

---

## WS3 — Finish-clean notification with complete data (the reported empty Slack)

**Root cause (confirmed in n8n).** Workflow *"BSV Ops Automation — Cleaning, Maintenance, Tasks"* →
node **"Google Sheets Trigger"**, `event: rowAdded`, sheet **"Clean Log"**, poll `everyMinute`.
`start-clean` appends the row at clean **start** (`[date, property, startTime, "", "", "", "", cleanId]`),
so within a minute n8n sends "Cleaning submission received" with Finish Time + all counts blank.
`finish-clean` only **updates cells in place** (no new row) → a `rowAdded` trigger never re-fires at
finish. So the notification can only fire at start, empty. This is a **trigger-timing** bug, not data loss.

**Fix — emit the notification at finish, from the app.**
- **`src/app/api/finish-clean/route.ts`**: `finish-clean` already recomputes the maintenance count;
  **also recompute the cleaning-photo count** (col E) there from Drive ground truth so both counts are
  correct at finish even if an earlier per-photo write dropped. Then `POST` a complete payload to a new
  **`CLEAN_FINISH_WEBHOOK_URL`** (n8n Webhook node): `{ property, cleanId, date, startTime, finishTime,
  photoCount, maintenancePhotoCount, inventoryRequest }`, all derived server-side.
  - **Best-effort**: try/catch, never fail the finish response on a webhook error (mirror
    `appendUploadLog`). Gate on the env being set so local/non-prod doesn't post.
- **Operator (n8n)**: swap the cleaning workflow's trigger from Sheets `rowAdded` → a **Webhook** node
  at `CLEAN_FINISH_WEBHOOK_URL`; map the JSON into the existing Slack message; set `Status: "Clean
  completed."`. (**Fallback if a webhook is undesirable:** change the Sheets trigger to `rowUpdate`
  watching **Finish Time / col D** — no app change, but flakier since in-place count edits can
  double-fire. The webhook is preferred.)
- **Inventory field**: Slack "Inventory Request" maps to Clean Log col G, which nothing writes today.
  Decide the source (a boolean "inventory submitted this clean?" or a short summary) and populate it in
  the webhook payload; otherwise keep it explicitly blank rather than implying data.

**Done:** exactly one Slack notification per clean, fired **at finish**, with property, finish time,
and both photo counts populated. Starting a clean produces no notification.

---

## WS4 — New properties auto-available (weekly Hospitable sync)

Today `select-property/page.tsx` renders the static 15-item `src/lib/properties.ts`; a new unit needs
a code edit + deploy. The dev-handoff WS4 groundwork (`31285c2`) mapped the Hospitable shape but never
shipped a live route or wired the UI.

**Fix — cached server route backed by a ~weekly Hospitable pull, static fallback.**
- **`src/app/api/properties/route.ts`** (new): fetch the Hospitable properties list
  (`Authorization: Bearer ${HOSPITABLE_API_TOKEN}`), **filter `address.city ∈ {"Cle Elum","Ronald"}`**
  (the Suncadia cleaning set; excludes the Florida + Whidbey homes per the prior operator decision),
  map the label from `name` with the `'a - '/'b - '/'c - '` prefix stripped + whitespace collapsed, and
  keep the Hospitable `id` per property. **Cache in-process with a ~weekly TTL** (user asked for "once a
  week"); serve stale-then-refresh. **On any Hospitable error, fall back to the hardcoded `PROPERTIES`**
  so the picker never breaks.
- **`src/app/select-property/page.tsx`**: fetch `/api/properties` on load; render its list; fall back
  to the static import if the fetch fails. The label string is used as the Drive folder name + sheet
  Property column — preserve that exact value; if we start storing the Hospitable `id`, thread it
  through `start-clean` separately without changing the folder/label.
- **Refresh cadence**: prefer the **route TTL** (lazy; first cleaner of the week triggers the refresh) —
  no new infra. If a guaranteed schedule is wanted, an n8n weekly cron hitting `/api/properties?refresh=1`
  is the low-infra option.
- **Reconcile the static fallback**: refresh `src/lib/properties.ts` to today's Suncadia set so the
  fallback isn't stale either.

**Done:** the picker reflects the live Cle Elum/Ronald Hospitable set, refreshes ~weekly without a
deploy, and degrades to the static list if Hospitable is down.

---

## Constraints
- No new npm deps. No Clean Log schema migration (columns A:H unchanged).
- Don't touch the Drive upload mechanism's dedup/retry/timeout, or the version-gate/auto-logout logic.
- Telemetry/webhook calls are best-effort — they must never throw into a user-facing response.
- Secrets (`HOSPITABLE_API_TOKEN`, webhook URLs) stay in `.env`, never in client bundles.

## Verification
- **WS1:** with a valid (newly created) `GOOGLE_DRIVE_MAINTENANCE_FOLDER_ID`, a maintenance photo lands
  in the folder and `/api/health` returns 200; with a missing ID, `/api/health` returns 503 and the
  upload route logs a labeled config error (not a bare 502).
- **WS2:** selecting photos starts uploading them immediately (status badges go `…`→`✓`) with no button
  tap; a multi-photo batch completes in the background before Finish; a forced failure still shows Retry;
  dedup prevents duplicates on retry. Spot-check throughput improvement via the Upload Log `duration_ms`.
- **WS3:** finishing a clean → exactly one Slack message, fired at finish, all fields populated; starting
  a clean produces **no** notification; col E and col F match Drive after finish.
- **WS4:** `/api/properties` returns the Cle Elum/Ronald set with cleaned labels; kill the Hospitable
  token → route falls back to the static list; picker still works.

## Files touched
- `src/lib/google.ts` — (WS1) maintenance-folder reachability helper.
- `src/app/api/health/route.ts` — (WS1) maintenance-folder check.
- `src/app/api/maintenance/upload-photo/route.ts` — (WS1) labeled config-error on parent-not-found.
- `src/app/clean/PhotosTab.tsx` + `src/app/clean/MaintenanceTab.tsx` — (WS2) auto-upload on capture;
  adaptive concurrency; debounce/drop per-batch finalize.
- `src/lib/photoProcess.ts` (+ `uploadFetch.ts` if pipelining) — (WS2) process/upload pipeline;
  concurrency knob.
- `src/app/api/finish-clean/route.ts` — (WS3) reconcile cleaning-photo count; emit finish webhook.
- `src/app/api/properties/route.ts` — (WS4) new live+cached Hospitable route.
- `src/app/select-property/page.tsx` — (WS4) consume `/api/properties` with static fallback.
- `src/lib/properties.ts` — (WS4) refresh the fallback list.
- `.env` — (WS1) fix `GOOGLE_DRIVE_MAINTENANCE_FOLDER_ID`; (WS3) add `CLEAN_FINISH_WEBHOOK_URL`.
- **n8n (operator):** retrigger "BSV Ops Automation" cleaning path on the finish webhook.
</content>
