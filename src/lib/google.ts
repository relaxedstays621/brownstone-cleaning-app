import { google } from "googleapis";

function getAuth() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  oauth2Client.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
  });
  return oauth2Client;
}

export function getDrive() {
  return google.drive({ version: "v3", auth: getAuth() });
}

// Cheap liveness check for /api/health: refresh an access token (hits Google's
// token endpoint, no Drive/Sheets quota). Returns false on invalid_grant or any
// failure — never throws, never leaks the token.
export async function verifyGoogleAuth(): Promise<boolean> {
  try {
    const { token } = await getAuth().getAccessToken();
    return typeof token === "string" && token.length > 0;
  } catch {
    return false;
  }
}

export function getSheets() {
  return google.sheets({ version: "v4", auth: getAuth() });
}

// Cheap reachability check for the maintenance Drive folder (used by /api/health).
// The maintenance-upload outage (≥4 days, unnoticed) happened because the configured
// folder was deleted, so every per-upload folder resolution failed with a bare 502.
// This confirms MAINTENANCE_DRIVE_ROOT_FOLDER_ID is set, resolves, and isn't trashed
// with one cheap files.get. Returns a structured result; NEVER throws.
//
// No supportsAllDrives on purpose: the app's other Drive calls don't pass it, so this
// must mirror them — the folder has to live in My Drive to be reachable at all.
export async function verifyMaintenanceFolder(): Promise<{
  ok: boolean;
  reason?: string;
}> {
  if (!MAINTENANCE_DRIVE_ROOT_FOLDER_ID) {
    return { ok: false, reason: "maintenance-folder-unset" };
  }
  try {
    const drive = getDrive();
    const res = await drive.files.get({
      fileId: MAINTENANCE_DRIVE_ROOT_FOLDER_ID,
      fields: "id,trashed",
    });
    if (res.data.trashed) {
      return { ok: false, reason: "maintenance-folder-trashed" };
    }
    return { ok: true };
  } catch {
    // 404 (deleted/inaccessible) or any transport error → not reachable.
    return { ok: false, reason: "maintenance-folder-not-found" };
  }
}

// True when a Drive error is the "configured parent folder doesn't exist" case —
// a 404 / "File not found" naming MAINTENANCE_DRIVE_ROOT_FOLDER_ID. This is a
// config outage (the whole folder is gone), not a transient per-upload failure,
// so the upload route surfaces it as a distinct labeled error instead of a 502.
export function isMaintenanceFolderMissingError(err: unknown): boolean {
  if (!MAINTENANCE_DRIVE_ROOT_FOLDER_ID) return true;
  const status = (err as { code?: number; status?: number } | null)?.code ??
    (err as { status?: number } | null)?.status;
  const message = err instanceof Error ? err.message : String(err ?? "");
  const mentionsFolder = message.includes(MAINTENANCE_DRIVE_ROOT_FOLDER_ID);
  const notFound = status === 404 || /file not found/i.test(message);
  return notFound && mentionsFolder;
}

export const SHEET_ID = process.env.GOOGLE_SHEET_ID!;
export const DRIVE_ROOT_FOLDER_ID = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID!;
// Required env, same as SHEET_ID / DRIVE_ROOT_FOLDER_ID above. No literal
// fallback on purpose: a stale hardcoded folder ID is exactly what caused the
// maintenance-upload 502 (the old literal would silently misroute photos to an
// unreachable folder). If the env var is missing this is undefined and the
// Drive call fails loudly instead of writing to the wrong place.
export const MAINTENANCE_DRIVE_ROOT_FOLDER_ID =
  process.env.GOOGLE_DRIVE_MAINTENANCE_FOLDER_ID!;

// "Cleaned By" is appended at the END (col I) on purpose: the finish-clean
// matcher and photo-count writes address columns by position (Clean ID at H,
// counts at E/F), so inserting mid-sheet would corrupt them — same reason the
// legacy migration moved Clean ID to H rather than inserting.
const CLEAN_LOG_HEADERS = [
  "Date",
  "Property",
  "Start Time",
  "Finish Time",
  "# Photos",
  "# Maintenance Photos",
  "Inventory Request",
  "Clean ID",
  "Cleaned By",
];
// The pre-team-logins 8-col shape (ends at "Clean ID"). Migration from it is a
// single header write — old rows legitimately have a blank Cleaned By.
const PREV_CLEAN_LOG_HEADERS = CLEAN_LOG_HEADERS.slice(0, 8);
const LEGACY_CLEAN_LOG_HEADERS = [
  "Date",
  "Property",
  "Start Time",
  "Finish Time",
  "# Photos",
  "Clean ID",
];
const INVENTORY_HEADERS = ["Date", "Property", "Item", "Quantity", "Notes", "Status"];
// "Submitted By" appended at the end for the same positional-safety reason —
// the Status dropdown validation lives at column F and must not move.
const MAINTENANCE_HEADERS = [
  "Date",
  "Property",
  "Start Time",
  "Clean ID",
  "Text",
  "Status",
  "Submitted By",
];

export const CLEAN_LOG_RANGE = "Clean Log!A:I";
export const CLEAN_LOG_CLEAN_ID_COL = 7; // 0-indexed in A:I
export const CLEAN_LOG_CLEANED_BY_COL = 8; // 0-indexed in A:I
export const CLEAN_LOG_PHOTOS_COL_LETTER = "E";
export const CLEAN_LOG_MAINTENANCE_PHOTOS_COL_LETTER = "F";
export const CLEAN_LOG_INVENTORY_REQUEST_COL_LETTER = "G";
export const CLEAN_LOG_CLEAN_ID_COL_LETTER = "H";
export const CLEAN_LOG_CLEANED_BY_COL_LETTER = "I";

async function migrateLegacyCleanLog(
  sheets: ReturnType<typeof getSheets>,
  existingHeader: string[]
): Promise<boolean> {
  // Legacy header had Clean ID at column F (index 5). Bail out if shape doesn't match.
  if (existingHeader.length < 6 || existingHeader[5] !== "Clean ID") return false;

  const legacy = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "Clean Log!A2:F",
  });
  const rows = legacy.data.values || [];

  // Build the new A:I rectangle: keep cols A-E, blank F (Maintenance Photos) + G
  // (Inventory Request), move legacy F (Clean ID) to H, blank I (Cleaned By).
  const migrated = rows.map((row) => {
    const date = row[0] ?? "";
    const property = row[1] ?? "";
    const startTime = row[2] ?? "";
    const finishTime = row[3] ?? "";
    const photos = row[4] ?? "";
    const cleanId = row[5] ?? "";
    return [date, property, startTime, finishTime, photos, "", "", cleanId, ""];
  });

  const writes: Array<{ range: string; values: string[][] }> = [
    { range: "Clean Log!A1:I1", values: [CLEAN_LOG_HEADERS] },
  ];
  if (migrated.length > 0) {
    writes.push({ range: `Clean Log!A2:I${migrated.length + 1}`, values: migrated });
  }
  // Wipe the now-stale column F values (legacy Clean ID) below the migrated rectangle, in case
  // the legacy sheet had trailing rows we didn't read. Safe because we just wrote H with the IDs.
  // (Skip — values.get with A2:F returned everything; rows already covers all data rows.)

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { valueInputOption: "USER_ENTERED", data: writes },
  });

  console.log(
    `[google.ts] Migrated Clean Log: ${migrated.length} row(s) — Clean ID moved F → H`
  );
  return true;
}

async function ensureCleanLogHeaders(sheets: ReturnType<typeof getSheets>) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "Clean Log!A1:I1",
  });
  const actualHeader = (res.data.values?.[0] ?? []) as string[];

  const matchesNew = CLEAN_LOG_HEADERS.every((h, i) => actualHeader[i] === h);
  if (matchesNew) return;

  // Pre-team-logins 8-col shape: migration is a single header write — no row
  // rewrites, existing rows legitimately have a blank Cleaned By.
  const matchesPrev = PREV_CLEAN_LOG_HEADERS.every((h, i) => actualHeader[i] === h);
  if (matchesPrev) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: "Clean Log!I1",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [["Cleaned By"]] },
    });
    console.log('[google.ts] Clean Log: added "Cleaned By" header at I1');
    return;
  }

  const matchesLegacy = LEGACY_CLEAN_LOG_HEADERS.every((h, i) => actualHeader[i] === h);
  if (matchesLegacy) {
    const migrated = await migrateLegacyCleanLog(sheets, actualHeader);
    if (migrated) return;
  }

  // Fresh sheet or unknown shape — write the headers and let downstream code populate.
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: "Clean Log!A1:I1",
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [CLEAN_LOG_HEADERS] },
  });
}

async function ensureInventoryRequestsTab(sheets: ReturnType<typeof getSheets>) {
  const inventory = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "Inventory Requests!A1:F1",
  });
  if (inventory.data.values && inventory.data.values.length > 0) return;

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: "Inventory Requests!A1:F1",
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [INVENTORY_HEADERS] },
  });

  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const inventorySheet = spreadsheet.data.sheets?.find(
    (s) => s.properties?.title === "Inventory Requests"
  );
  const sheetId = inventorySheet?.properties?.sheetId;
  if (sheetId === undefined) return;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: {
      requests: [
        {
          setDataValidation: {
            range: {
              sheetId,
              startRowIndex: 1,
              endRowIndex: 1000,
              startColumnIndex: 5,
              endColumnIndex: 6,
            },
            rule: {
              condition: {
                type: "ONE_OF_LIST",
                values: [
                  { userEnteredValue: "Pending" },
                  { userEnteredValue: "Ordered" },
                ],
              },
              showCustomUi: true,
              strict: true,
            },
          },
        },
      ],
    },
  });
}

async function ensureMaintenanceRequestsTab(sheets: ReturnType<typeof getSheets>) {
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const existing = spreadsheet.data.sheets?.find(
    (s) => s.properties?.title === "Maintenance Requests"
  );

  let sheetId: number | undefined = existing?.properties?.sheetId ?? undefined;
  if (!existing) {
    const created = await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        requests: [
          { addSheet: { properties: { title: "Maintenance Requests" } } },
        ],
      },
    });
    sheetId = created.data.replies?.[0]?.addSheet?.properties?.sheetId ?? undefined;
  }

  // Always make sure the header row matches — cheap and idempotent. (This is
  // also the "Submitted By" col-G migration: the pre-team-logins A:F header
  // mismatches and gets rewritten in place; old rows stay valid with blank G.)
  const header = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "Maintenance Requests!A1:G1",
  });
  const actual = (header.data.values?.[0] ?? []) as string[];
  const headerMismatch = MAINTENANCE_HEADERS.some((h, i) => actual[i] !== h);
  if (headerMismatch) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: "Maintenance Requests!A1:G1",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [MAINTENANCE_HEADERS] },
    });
  }

  if (sheetId !== undefined && !existing) {
    // Only add the dropdown on first creation — replaying setDataValidation on each
    // boot would silently clobber any rule edits an operator made in the Sheets UI.
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        requests: [
          {
            setDataValidation: {
              range: {
                sheetId,
                startRowIndex: 1,
                endRowIndex: 1000,
                startColumnIndex: 5,
                endColumnIndex: 6,
              },
              rule: {
                condition: {
                  type: "ONE_OF_LIST",
                  values: [
                    { userEnteredValue: "Pending" },
                    { userEnteredValue: "Resolved" },
                  ],
                },
                showCustomUi: true,
                strict: true,
              },
            },
          },
        ],
      },
    });
  }
}

export const UPLOAD_LOG_TAB = "Upload Log";
const UPLOAD_LOG_HEADERS = [
  "Timestamp",
  "Event",
  "Clean ID",
  "Property",
  "Upload ID",
  "Status",
  "Error",
  "Photo Size",
  "Processed Size",
  "Attempts",
  "Duration (ms)",
  "Fell Back",
  "User Agent",
  "Connection",
];

export interface UploadLogEntry {
  timestamp: string;
  event: string;
  cleanId?: string;
  property?: string;
  uploadId?: string;
  status?: string | number;
  error?: string;
  photoSize?: number;
  processedSize?: number;
  attempts?: number;
  durationMs?: number;
  fellBack?: boolean;
  userAgent?: string;
  connection?: string;
}

// Cached per server instance so we don't pay the create/header check on every
// append. Reset to false only when the ensure fails, so we retry next time.
let uploadLogTabReady = false;

async function ensureUploadLogTab(sheets: ReturnType<typeof getSheets>) {
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const exists = spreadsheet.data.sheets?.some(
    (s) => s.properties?.title === UPLOAD_LOG_TAB
  );
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        requests: [{ addSheet: { properties: { title: UPLOAD_LOG_TAB } } }],
      },
    });
  }

  const header = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${UPLOAD_LOG_TAB}!A1:N1`,
  });
  const actual = (header.data.values?.[0] ?? []) as string[];
  if (UPLOAD_LOG_HEADERS.some((h, i) => actual[i] !== h)) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${UPLOAD_LOG_TAB}!A1:N1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [UPLOAD_LOG_HEADERS] },
    });
  }
}

// Best-effort: appends one diagnostic row to the Upload Log tab. NEVER throws —
// telemetry must not become a failure path for uploads or beacons.
export async function appendUploadLog(entry: UploadLogEntry): Promise<void> {
  try {
    const sheets = getSheets();
    if (!uploadLogTabReady) {
      await ensureUploadLogTab(sheets);
      uploadLogTabReady = true;
    }
    const row = [
      entry.timestamp,
      entry.event,
      entry.cleanId ?? "",
      entry.property ?? "",
      entry.uploadId ?? "",
      entry.status ?? "",
      entry.error ?? "",
      entry.photoSize ?? "",
      entry.processedSize ?? "",
      entry.attempts ?? "",
      entry.durationMs ?? "",
      entry.fellBack === undefined ? "" : entry.fellBack ? "yes" : "no",
      entry.userAgent ?? "",
      entry.connection ?? "",
    ];
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${UPLOAD_LOG_TAB}!A:N`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [row] },
    });
  } catch (err) {
    uploadLogTabReady = false;
    console.error(
      "[appendUploadLog] failed:",
      err instanceof Error ? err.message : err
    );
  }
}

export async function ensureSheetHeaders() {
  const sheets = getSheets();
  await ensureCleanLogHeaders(sheets);
  await ensureInventoryRequestsTab(sheets);
  await ensureMaintenanceRequestsTab(sheets);
  await ensureUploadLogTab(sheets);
  uploadLogTabReady = true;
}
