import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { isAuthenticated } from "@/lib/auth";
import {
  getDrive,
  getSheets,
  SHEET_ID,
  DRIVE_ROOT_FOLDER_ID,
  ensureSheetHeaders,
} from "@/lib/google";
import { withRetry } from "@/lib/retry";

const DRIVE_TIMEOUT_MS = 30_000;
const SHEETS_TIMEOUT_MS = 15_000;

function escapeForDriveQuery(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function findOrCreateFolder(
  drive: ReturnType<typeof getDrive>,
  name: string,
  parentId: string,
  label: string
): Promise<string> {
  const safeName = escapeForDriveQuery(name);
  const q = `name='${safeName}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const list = await withRetry(
    () => drive.files.list({ q, fields: "files(id)", pageSize: 1 }, { timeout: DRIVE_TIMEOUT_MS }),
    { label: `start-clean:${label}:list` }
  );
  if (list.data.files && list.data.files.length > 0) {
    return list.data.files[0].id!;
  }
  const created = await withRetry(
    () =>
      drive.files.create(
        {
          requestBody: { name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] },
          fields: "id",
        },
        { timeout: DRIVE_TIMEOUT_MS }
      ),
    { label: `start-clean:${label}:create` }
  );
  return created.data.id!;
}

export async function POST(req: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { property } = await req.json();
  if (!property) {
    return NextResponse.json({ error: "Missing property" }, { status: 400 });
  }

  const now = new Date();
  const date = now.toLocaleDateString("en-US", { timeZone: "America/Los_Angeles" });
  const dateIso = now.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
  const startTime = now.toLocaleTimeString("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  const cleanId = randomUUID();
  const sessionFolderName = `clean_${cleanId}`;

  try {
    await ensureSheetHeaders();

    const drive = getDrive();
    const propertyFolderId = await findOrCreateFolder(
      drive,
      property,
      DRIVE_ROOT_FOLDER_ID,
      "property"
    );
    const dateFolderId = await findOrCreateFolder(drive, dateIso, propertyFolderId, "date");

    // Session folder name embeds the UUID so it cannot collide with concurrent cleans
    const sessionFolder = await withRetry(
      () =>
        drive.files.create(
          {
            requestBody: {
              name: sessionFolderName,
              mimeType: "application/vnd.google-apps.folder",
              parents: [dateFolderId],
              appProperties: { cleanId },
            },
            fields: "id",
          },
          { timeout: DRIVE_TIMEOUT_MS }
        ),
      { label: "start-clean:session-create" }
    );

    const sheets = getSheets();
    await withRetry(
      () =>
        sheets.spreadsheets.values.append(
          {
            spreadsheetId: SHEET_ID,
            range: "Clean Log!A:F",
            valueInputOption: "USER_ENTERED",
            requestBody: { values: [[date, property, startTime, "", "", cleanId]] },
          },
          { timeout: SHEETS_TIMEOUT_MS }
        ),
      { label: "start-clean:sheet-append" }
    );

    return NextResponse.json({
      success: true,
      cleanId,
      date,
      startTime,
      sessionFolderId: sessionFolder.data.id,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[start-clean] failed:", err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
