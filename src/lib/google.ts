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

export const SHEET_ID = process.env.GOOGLE_SHEET_ID!;
export const DRIVE_ROOT_FOLDER_ID = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID!;
// Required env, same as SHEET_ID / DRIVE_ROOT_FOLDER_ID above. No literal
// fallback on purpose: a stale hardcoded folder ID is exactly what caused the
// maintenance-upload 502 (the old literal would silently misroute photos to an
// unreachable folder). If the env var is missing this is undefined and the
// Drive call fails loudly instead of writing to the wrong place.
export const MAINTENANCE_DRIVE_ROOT_FOLDER_ID =
  process.env.GOOGLE_DRIVE_MAINTENANCE_FOLDER_ID!;

const CLEAN_LOG_HEADERS = [
  "Date",
  "Property",
  "Start Time",
  "Finish Time",
  "# Photos",
  "# Maintenance Photos",
  "Inventory Request",
  "Clean ID",
];
const LEGACY_CLEAN_LOG_HEADERS = [
  "Date",
  "Property",
  "Start Time",
  "Finish Time",
  "# Photos",
  "Clean ID",
];
const INVENTORY_HEADERS = ["Date", "Property", "Item", "Quantity", "Notes", "Status"];
const MAINTENANCE_HEADERS = [
  "Date",
  "Property",
  "Start Time",
  "Clean ID",
  "Text",
  "Status",
];

export const CLEAN_LOG_RANGE = "Clean Log!A:H";
export const CLEAN_LOG_CLEAN_ID_COL = 7; // 0-indexed in A:H
export const CLEAN_LOG_PHOTOS_COL_LETTER = "E";
export const CLEAN_LOG_MAINTENANCE_PHOTOS_COL_LETTER = "F";
export const CLEAN_LOG_INVENTORY_REQUEST_COL_LETTER = "G";
export const CLEAN_LOG_CLEAN_ID_COL_LETTER = "H";

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

  // Build the new A:H rectangle: keep cols A-E, blank F (Maintenance Photos) + G (Inventory Request), move legacy F (Clean ID) to H.
  const migrated = rows.map((row) => {
    const date = row[0] ?? "";
    const property = row[1] ?? "";
    const startTime = row[2] ?? "";
    const finishTime = row[3] ?? "";
    const photos = row[4] ?? "";
    const cleanId = row[5] ?? "";
    return [date, property, startTime, finishTime, photos, "", "", cleanId];
  });

  const writes: Array<{ range: string; values: string[][] }> = [
    { range: "Clean Log!A1:H1", values: [CLEAN_LOG_HEADERS] },
  ];
  if (migrated.length > 0) {
    writes.push({ range: `Clean Log!A2:H${migrated.length + 1}`, values: migrated });
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
    range: "Clean Log!A1:H1",
  });
  const actualHeader = (res.data.values?.[0] ?? []) as string[];

  const matchesNew = CLEAN_LOG_HEADERS.every((h, i) => actualHeader[i] === h);
  if (matchesNew) return;

  const matchesLegacy = LEGACY_CLEAN_LOG_HEADERS.every((h, i) => actualHeader[i] === h);
  if (matchesLegacy) {
    const migrated = await migrateLegacyCleanLog(sheets, actualHeader);
    if (migrated) return;
  }

  // Fresh sheet or unknown shape — write the headers and let downstream code populate.
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: "Clean Log!A1:H1",
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

  // Always make sure the header row matches — cheap and idempotent.
  const header = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "Maintenance Requests!A1:F1",
  });
  const actual = (header.data.values?.[0] ?? []) as string[];
  const headerMismatch = MAINTENANCE_HEADERS.some((h, i) => actual[i] !== h);
  if (headerMismatch) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: "Maintenance Requests!A1:F1",
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
