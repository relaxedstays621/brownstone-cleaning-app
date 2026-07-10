import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import {
  getDrive,
  getSheets,
  SHEET_ID,
  CLEAN_LOG_RANGE,
  CLEAN_LOG_CLEAN_ID_COL,
  CLEAN_LOG_PHOTOS_COL_LETTER,
  CLEAN_LOG_MAINTENANCE_PHOTOS_COL_LETTER,
  MAINTENANCE_DRIVE_ROOT_FOLDER_ID,
} from "@/lib/google";
import { withRetry } from "@/lib/retry";

const DRIVE_TIMEOUT_MS = 30_000;
const SHEETS_TIMEOUT_MS = 15_000;
const WEBHOOK_TIMEOUT_MS = 10_000;

// Clean Log column indexes (0-based within A:H), for reading the row we matched.
const COL_DATE = 0;
const COL_START_TIME = 2;
const COL_INVENTORY_REQUEST = 6; // col G — "Yes" once inventory/confirm marks it

function escapeForDriveQuery(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
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
      { label: "finish-clean:count" }
    );
    total += res.data.files?.length ?? 0;
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return total;
}

// Cleaning photos live in the `clean_<cleanId>` session folder (created by
// start-clean). We reconcile col E from Drive at finish — WS2 dropped the
// per-batch finalize, so this is now the single source of truth for the count.
async function countCleaningPhotos(
  drive: ReturnType<typeof getDrive>,
  cleanId: string
): Promise<number> {
  const safeId = escapeForDriveQuery(cleanId);
  const q = `name='clean_${safeId}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const res = await withRetry(
    () =>
      drive.files.list(
        { q, fields: "files(id)", pageSize: 1 },
        { timeout: DRIVE_TIMEOUT_MS }
      ),
    { label: "finish-clean:clean-folder" }
  );
  const folderId = res.data.files?.[0]?.id;
  if (!folderId) return 0;
  return countImagesInFolder(drive, folderId);
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
  return countImagesInFolder(drive, folderId);
}

interface FinishPayload {
  property: string;
  cleanId: string;
  date: string;
  startTime: string;
  finishTime: string;
  photoCount: number | null;
  maintenancePhotoCount: number | null;
  inventoryRequest: string;
}

// Best-effort finish notification. Fires the complete, finish-time payload to the
// n8n Webhook node so Slack reflects real data — the old Sheets `rowAdded` trigger
// fired at START, always blank. Gated on the env being set (local/non-prod stays
// silent). NEVER throws into the finish response — mirrors appendUploadLog.
async function postFinishWebhook(payload: FinishPayload): Promise<void> {
  const url = process.env.CLEAN_FINISH_WEBHOOK_URL;
  if (!url) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.error(
        `[finish-clean] webhook non-OK status=${res.status} cleanId=${payload.cleanId}`
      );
    }
  } catch (err) {
    console.error(
      `[finish-clean] webhook post failed cleanId=${payload.cleanId}:`,
      err instanceof Error ? err.message : err
    );
  } finally {
    clearTimeout(timer);
  }
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

    const matchedRow = targetRow > 0 ? rows[targetRow - 1] ?? [] : [];

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

    // Reconcile both photo counts from Drive ground truth so a finish always
    // reflects current state — even if an earlier per-photo write dropped. Each is
    // best-effort: a count failure must not fail the finish. Counts feed both the
    // sheet cells and the finish webhook payload.
    let photoCount: number | null = null;
    let maintenancePhotoCount: number | null = null;
    if (cleanId && targetRow > 0) {
      const drive = getDrive();
      try {
        const count = await countCleaningPhotos(drive, cleanId);
        photoCount = count;
        await withRetry(
          () =>
            sheets.spreadsheets.values.update(
              {
                spreadsheetId: SHEET_ID,
                range: `Clean Log!${CLEAN_LOG_PHOTOS_COL_LETTER}${targetRow}`,
                valueInputOption: "USER_ENTERED",
                requestBody: { values: [[count.toString()]] },
              },
              { timeout: SHEETS_TIMEOUT_MS }
            ),
          { label: "finish-clean:photo-write" }
        );
        console.log(`[finish-clean] cleaning photos cleanId=${cleanId} count=${count}`);
      } catch (err) {
        console.error(`[finish-clean] cleaning count failed cleanId=${cleanId}:`, err);
      }

      try {
        const count = await countMaintenancePhotos(drive, cleanId);
        maintenancePhotoCount = count;
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

    // Fire the complete finish-time notification (best-effort, env-gated). All
    // fields derived server-side so Slack can't show blanks like the old
    // start-time trigger did.
    await postFinishWebhook({
      property: (matchedRow[1] as string) || property || "",
      cleanId: cleanId || "",
      date: (matchedRow[COL_DATE] as string) || "",
      startTime: (matchedRow[COL_START_TIME] as string) || "",
      finishTime,
      photoCount,
      maintenancePhotoCount,
      inventoryRequest: (matchedRow[COL_INVENTORY_REQUEST] as string) || "",
    });

    return NextResponse.json({ success: true, finishTime });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[finish-clean] failed:", err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
