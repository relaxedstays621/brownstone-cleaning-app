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

async function countMaintenancePhotos(
  drive: ReturnType<typeof getDrive>,
  cleanId: string
): Promise<number> {
  const safeName = escapeForDriveQuery(`maintenance_${cleanId}`);
  const safeParent = escapeForDriveQuery(MAINTENANCE_DRIVE_ROOT_FOLDER_ID);
  const folderQ = `name='${safeName}' and '${safeParent}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const folderRes = await withRetry(
    () =>
      drive.files.list(
        { q: folderQ, fields: "files(id)", pageSize: 1 },
        { timeout: DRIVE_TIMEOUT_MS }
      ),
    { label: "finish-clean:maint-folder" }
  );
  const folderId = folderRes.data.files?.[0]?.id;
  if (!folderId) return 0;

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
      { label: "finish-clean:maint-count" }
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

  const { property, cleanId } = await req.json();
  const now = new Date();
  const finishTime = now.toLocaleTimeString("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  try {
    const sheets = getSheets();
    const logData = await withRetry(
      () =>
        sheets.spreadsheets.values.get(
          { spreadsheetId: SHEET_ID, range: CLEAN_LOG_RANGE },
          { timeout: SHEETS_TIMEOUT_MS }
        ),
      { label: "finish-clean:sheet-read" }
    );
    const rows = logData.data.values || [];
    let targetRow = -1;
    if (cleanId) {
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i][CLEAN_LOG_CLEAN_ID_COL] === cleanId) {
          targetRow = i + 1;
          break;
        }
      }
    }
    if (targetRow < 0 && property) {
      // Fallback for legacy rows that have no Clean ID
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i][1] === property && (!rows[i][3] || rows[i][3] === "")) {
          targetRow = i + 1;
          break;
        }
      }
    }

    if (targetRow > 0) {
      await withRetry(
        () =>
          sheets.spreadsheets.values.update(
            {
              spreadsheetId: SHEET_ID,
              range: `Clean Log!D${targetRow}`,
              valueInputOption: "USER_ENTERED",
              requestBody: { values: [[finishTime]] },
            },
            { timeout: SHEETS_TIMEOUT_MS }
          ),
        { label: "finish-clean:sheet-write" }
      );
    }

    // Best-effort: refresh the Maintenance Photos count so a finish always reflects
    // current Drive state, even if an earlier maint-finalize call dropped.
    if (cleanId && targetRow > 0) {
      try {
        const drive = getDrive();
        const count = await countMaintenancePhotos(drive, cleanId);
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
          { label: "finish-clean:maint-write" }
        );
        console.log(`[finish-clean] maintenance photos cleanId=${cleanId} count=${count}`);
      } catch (err) {
        console.error(`[finish-clean] maintenance count failed cleanId=${cleanId}:`, err);
      }
    }

    return NextResponse.json({ success: true, finishTime });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[finish-clean] failed:", err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
