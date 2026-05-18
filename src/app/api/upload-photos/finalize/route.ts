import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getDrive, getSheets, SHEET_ID, DRIVE_ROOT_FOLDER_ID } from "@/lib/google";
import { withRetry } from "@/lib/retry";

const DRIVE_TIMEOUT_MS = 30_000;
const SHEETS_TIMEOUT_MS = 15_000;

function escapeForDriveQuery(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function findFolder(
  drive: ReturnType<typeof getDrive>,
  name: string,
  parentId: string
): Promise<string | null> {
  const safeName = escapeForDriveQuery(name);
  const query = `name='${safeName}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const res = await withRetry(
    () =>
      drive.files.list(
        { q: query, fields: "files(id)", pageSize: 1 },
        { timeout: DRIVE_TIMEOUT_MS }
      ),
    { label: `finalize-folder:${name}` }
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
      { label: "finalize-count" }
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

  let body: { property?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const property = body.property;
  if (!property) {
    return NextResponse.json({ error: "Missing property" }, { status: 400 });
  }

  try {
    const drive = getDrive();
    const dateStr = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });

    const propertyFolderId = await findFolder(drive, property, DRIVE_ROOT_FOLDER_ID);
    if (!propertyFolderId) {
      return NextResponse.json({ success: true, count: 0, note: "no property folder" });
    }
    const dateFolderId = await findFolder(drive, dateStr, propertyFolderId);
    if (!dateFolderId) {
      return NextResponse.json({ success: true, count: 0, note: "no date folder" });
    }

    const count = await countImagesInFolder(drive, dateFolderId);

    const sheets = getSheets();
    const logData = await withRetry(
      () =>
        sheets.spreadsheets.values.get(
          { spreadsheetId: SHEET_ID, range: "Clean Log!A:E" },
          { timeout: SHEETS_TIMEOUT_MS }
        ),
      { label: "finalize-sheet-read" }
    );
    const rows = logData.data.values || [];
    let targetRow = -1;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i][1] === property && (!rows[i][3] || rows[i][3] === "")) {
        targetRow = i + 1;
        break;
      }
    }
    if (targetRow < 0) {
      return NextResponse.json({ success: true, count, note: "no in-progress clean row" });
    }

    await withRetry(
      () =>
        sheets.spreadsheets.values.update(
          {
            spreadsheetId: SHEET_ID,
            range: `Clean Log!E${targetRow}`,
            valueInputOption: "USER_ENTERED",
            requestBody: { values: [[count.toString()]] },
          },
          { timeout: SHEETS_TIMEOUT_MS }
        ),
      { label: "finalize-sheet-write" }
    );

    console.log(`[upload-photos/finalize] property=${property} count=${count} row=${targetRow}`);
    return NextResponse.json({ success: true, count });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[upload-photos/finalize] failed property=${property}:`, err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
