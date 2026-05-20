import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import {
  getDrive,
  getSheets,
  SHEET_ID,
  CLEAN_LOG_RANGE,
  CLEAN_LOG_CLEAN_ID_COL,
  CLEAN_LOG_MAINTENANCE_PHOTOS_COL_LETTER,
  MAINTENANCE_DRIVE_ROOT_FOLDER_ID,
} from "@/lib/google";
import { withRetry } from "@/lib/retry";

const DRIVE_TIMEOUT_MS = 30_000;
const SHEETS_TIMEOUT_MS = 15_000;

function escapeForDriveQuery(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function findMaintenanceFolder(
  drive: ReturnType<typeof getDrive>,
  cleanId: string
): Promise<string | null> {
  const safeName = escapeForDriveQuery(`maintenance_${cleanId}`);
  const safeParent = escapeForDriveQuery(MAINTENANCE_DRIVE_ROOT_FOLDER_ID);
  const q = `name='${safeName}' and '${safeParent}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const res = await withRetry(
    () =>
      drive.files.list(
        { q, fields: "files(id)", pageSize: 1 },
        { timeout: DRIVE_TIMEOUT_MS }
      ),
    { label: "maint-finalize-folder-lookup" }
  );
  return res.data.files?.[0]?.id ?? null;
}

async function countImagesInFolder(
  drive: ReturnType<typeof getDrive>,
  folderId: string
): Promise<number> {
  let total = 0;
  let pageToken: string | undefined = undefined;
  do {
    const res = await withRetry(
      () =>
        drive.files.list(
          {
            q: `'${folderId}' in parents and trashed=false and mimeType contains 'image/'`,
            fields: "files(id),nextPageToken",
            pageSize: 1000,
            pageToken,
          },
          { timeout: DRIVE_TIMEOUT_MS }
        ),
      { label: "maint-finalize-count" }
    );
    total += res.data.files?.length ?? 0;
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return total;
}

export async function POST(req: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { cleanId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const cleanId = body.cleanId;
  if (!cleanId) {
    return NextResponse.json({ error: "Missing cleanId" }, { status: 400 });
  }

  try {
    const drive = getDrive();
    const folderId = await findMaintenanceFolder(drive, cleanId);
    const count = folderId ? await countImagesInFolder(drive, folderId) : 0;

    const sheets = getSheets();
    const logData = await withRetry(
      () =>
        sheets.spreadsheets.values.get(
          { spreadsheetId: SHEET_ID, range: CLEAN_LOG_RANGE },
          { timeout: SHEETS_TIMEOUT_MS }
        ),
      { label: "maint-finalize-sheet-read" }
    );
    const rows = logData.data.values || [];
    let targetRow = -1;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i][CLEAN_LOG_CLEAN_ID_COL] === cleanId) {
        targetRow = i + 1;
        break;
      }
    }
    if (targetRow < 0) {
      return NextResponse.json({ success: true, count, note: "no row for cleanId" });
    }

    await withRetry(
      () =>
        sheets.spreadsheets.values.update(
          {
            spreadsheetId: SHEET_ID,
            range: `Clean Log!${CLEAN_LOG_MAINTENANCE_PHOTOS_COL_LETTER}${targetRow}`,
            valueInputOption: "USER_ENTERED",
            requestBody: { values: [[count.toString()]] },
          },
          { timeout: SHEETS_TIMEOUT_MS }
        ),
      { label: "maint-finalize-sheet-write" }
    );

    console.log(`[maint-finalize] cleanId=${cleanId} count=${count} row=${targetRow}`);
    return NextResponse.json({ success: true, count });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[maint-finalize] failed cleanId=${cleanId}:`, err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
