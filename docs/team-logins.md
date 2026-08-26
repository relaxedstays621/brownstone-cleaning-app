# Team logins — per-team passwords + "Cleaned By" tracking

Planning spec, 2026-07-17. Goal: separate logins for separate cleaning teams, distinguished
ONLY by which password was entered (login form stays password-only, no username field), with
the team's name recorded in the spreadsheet on everything they log.

Teams at launch:
- **Nova** — the cleaning team.
- **Heather** — maintenance person for the property "b - Whidbey Island Retreat".

## 1. Config — teams live in one env var

Replace the single `CLEANING_APP_PASSWORD` with a team map (JSON in `.env`, parsed once):

```
CLEANING_TEAMS='[
  {"name":"Nova","password":"<operator sets>"},
  {"name":"Heather","password":"<operator sets>","defaultProperty":"b - Whidbey Island Retreat"}
]'
```

- The **canonical `name` is what gets written to the sheet** — never the typed password.
- Passwords must be unique across teams (startup guard: log + refuse to start on duplicates,
  since the password IS the identity).
- ⚠️ Operator decision (recommended default): do NOT literally use "Nova"/"heather" as the
  passwords — names-as-passwords are guessable and this app faces the public internet. Keep the
  account names Nova/Heather; set passwords like `nova-cleans-2026`. Operator's call; the spec
  works either way since both live in `.env`.
- Keep `CLEANING_APP_PASSWORD` supported during rollout as a fallback mapping to name
  `""` (blank Cleaned By — same behavior as today). Remove it from `.env` once both teams have
  logged in with their own password (a follow-up `.env` edit, no deploy).

## 2. Auth — identity in the session cookie (src/lib/auth.ts, src/app/api/auth/route.ts)

Current cookie: `sha256(secret:v2).issuedAt` — identity-less. New cookie carries the team name,
tamper-proofed by folding the name into the hash:

- token = `sha256(`${SESSION_SECRET}:${TOKEN_VERSION}:${teamName}`)`
- cookie value = `${base64url(teamName)}.${token}.${issuedAtMs}`
- `isAuthenticated()` → new `getSession(): Promise<{ team: string } | null>`: decode the name,
  recompute the hash from it, compare, then enforce the 16h age as today. Keep
  `isAuthenticated()` as a thin wrapper so untouched call sites keep compiling.
- **Bump `TOKEN_VERSION` v2 → v3** — the codebase's established one-shot session flush. Every
  phone re-logs-in once with its team password and every session gains an identity. (No mixed
  state: old identity-less cookies die at deploy.)
- `POST /api/auth`: look the password up in the team map (plus the legacy fallback var during
  rollout); 401 on no match, unchanged version-gate behavior. Set the cookie with the matched
  team's canonical name.

## 3. Sheet — "Cleaned By" column (src/lib/google.ts + write routes)

**Clean Log: A:H → A:I, new header "Cleaned By" at column I** (append at the END on purpose —
`CLEAN_LOG_CLEAN_ID_COL = 7` and every existing column letter/index stay valid; the same reason
the legacy migration moved Clean ID to H rather than inserting).

- `CLEAN_LOG_HEADERS` += "Cleaned By"; `CLEAN_LOG_RANGE` → `"Clean Log!A:I"`; new
  `CLEAN_LOG_CLEANED_BY_COL_LETTER = "I"`.
- `ensureCleanLogHeaders`: current 8-col header (ending "Clean ID") is the new "legacy" shape —
  migration = write `I1 = "Cleaned By"` (no row rewrites needed; old rows legitimately blank).
  Follow the existing `migrateLegacyCleanLog` precedent; keep that older F→H migration intact.
- `start-clean/route.ts`: append range → `A:I`, row gains the session team name as the 9th cell.
- `finish-clean/route.ts`: read range widens automatically via `CLEAN_LOG_RANGE`; add
  `cleanedBy` to the `FinishPayload` webhook body (from the matched row col I, falling back to
  the current session's team) so the n8n → Slack finish notification can say WHO cleaned.
  (n8n side: the Slack-format node picks up the new field whenever WS3's webhook wiring
  happens — payload-first is additive and safe while `CLEAN_FINISH_WEBHOOK_URL` stays unset.)

**Maintenance Requests: A:F → A:G, new header "Submitted By"** — Heather is the maintenance
person; her text submissions must carry her name too.
- `MAINTENANCE_HEADERS` += "Submitted By"; `ensureMaintenanceRequestsTab` header check covers
  A1:G1 (its header-mismatch write is already idempotent; the Status dropdown at F is
  positionally untouched).
- `maintenance/submit-text/route.ts`: append the team name (dev: confirm this route's current
  append range/row shape and widen by one).

**Out of scope:** Upload Log telemetry and Inventory Requests keep their shapes (add
"Submitted By" to Inventory Requests later if the operator wants it — same recipe).

## 4. UI (small)

- Post-login, show the team name in the app header/chrome (small chip, e.g. "Nova") so a
  cleaner can see who they're logged in as; logout already exists.
- **Heather's `defaultProperty`:** in the property picker (`select-property/page.tsx` +
  `/api/properties`), pre-select/pin "b - Whidbey Island Retreat" when the session team has a
  `defaultProperty` — but do NOT restrict the list (recommended: she may cover other
  properties; restriction is a one-line follow-up if the operator wants a hard lock).
  ⚠️ Dev must verify the exact property display name against the live Hospitable-backed picker
  ("b - Whidbey Island Retreat" as given by the operator) — exact-match pinning only, silently
  skip the pin if no match (never block login/selection on a name mismatch).

## 5. Rollout / deploy

Repo reality: prod runs local-only branch `fix/ops-maint-uploads-notif-props` @ 86e2b1a served
from this working tree; host build with `staticPageGenerationTimeout: 300`. Stack this change
on that branch (or start consolidating to main — operator's call, out of scope here).

Order:
1. Operator adds `CLEANING_TEAMS` to `.env` (keep `CLEANING_APP_PASSWORD` for the fallback
   window). App code deploys with the change; TOKEN_VERSION bump logs everyone out once.
2. Verify (per §6), then operator texts each team its password and removes the legacy var.

## 6. Verify (Development Agent)

- Login with Nova's password → chip shows "Nova"; start+finish a clean on a test property →
  Clean Log row has "Nova" in col I; finish webhook payload (log it locally) carries
  `cleanedBy:"Nova"`; double-finish still doesn't re-notify (col-D gate untouched).
- Login with Heather's password → picker pre-selects "b - Whidbey Island Retreat" (and the
  full list is still reachable); a maintenance text submission lands with "Heather" in
  Maintenance Requests col G.
- Legacy password (while configured) still logs in; its rows have blank Cleaned By.
- Wrong password → 401. Existing pre-deploy cookies → treated as logged out (v3 flush).
- Existing sheet rows unharmed: headers migrated in place, Clean ID still matched at H,
  photo-count writes still land at E/F.

## Open decisions (operator)

1. Actual password strings (recommend not the bare names — see §1).
2. Heather: default-select only (recommended, specced) vs hard-restrict to that property.
3. When to drop the legacy shared password (recommend: after both teams' first real login).

## Addendum 2026-08-26 — multi-property teams + setter script

- `CLEANING_TEAMS` entries now also accept `"properties": ["<canonical label>", ...]` —
  extra picker labels force-included in `/api/properties` (same rules as
  `defaultProperty`) but not pre-selected. Built for the Whidbey-area team working both
  "Beachview Retreat" (Hospitable "b - Beachview Retreat", Clinton) and
  "Whidbey Island Retreat" (Hospitable "b - Whidbey Island Retreat", Oak Harbor) —
  both outside the Cle Elum/Ronald cleaning-cities filter.
- New logins are added with `bash scripts/add-cleaning-team.sh` (operator-run; prompts
  for name/properties/password, edits CLEANING_TEAMS in .env with a backup). Restart
  with `docker compose up -d --force-recreate app` to pick up the .env change — no
  rebuild needed for config-only edits.
