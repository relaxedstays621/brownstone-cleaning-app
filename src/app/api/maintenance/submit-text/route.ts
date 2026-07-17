import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { getDrive, getSheets, SHEET_ID } from "@/lib/google";
import { withRetry } from "@/lib/retry";

const DRIVE_TIMEOUT_MS = 30_000;
const SHEETS_TIMEOUT_MS = 15_000;
const MAX_TEXT_CHARS = 5_000;

function escapeForDriveQuery(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

interface SessionMeta {
  date: string;
  property: string;
  startTime: string;
}

async function loadSessionMeta(
  drive: ReturnType<typeof getDrive>,
  cleanId: string
): Promise<SessionMeta | null> {
  // Cleaning session folder was created with appProperties { cleanId, date, startTime, property }.
  // Folders live under property/date/ subfolders; search the whole drive by name + cleanId.
  const safeName = escapeForDriveQuery(`clean_${cleanId}`);
  const q = `name='${safeName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const list = await withRetry(
    () =>
      drive.files.list(
        { q, fields: "files(id,appProperties)", pageSize: 5 },
        { timeout: DRIVE_TIMEOUT_MS }
      ),
    { label: "maint-text-session-lookup" }
  );
  // Prefer the file whose ancestor is DRIVE_ROOT_FOLDER_ID, but a single match is fine.
  const files = list.data.files || [];
  if (files.length === 0) return null;
  const props = files[0].appProperties || {};
  return {
    date: typeof props.date === "string" ? props.date : "",
    property: typeof props.property === "string" ? props.property : "",
    startTime: typeof props.startTime === "string" ? props.startTime : "",
  };
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { property?: string; cleanId?: string; text?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const cleanId = (body.cleanId || "").trim();
  const text = (body.text || "").trim();
  const propertyHint = (body.property || "").trim();

  if (!cleanId || !text) {
    return NextResponse.json(
      { error: "Missing cleanId or text" },
      { status: 400 }
    );
  }
  if (text.length > MAX_TEXT_CHARS) {
    return NextResponse.json(
      { error: `Text exceeds ${MAX_TEXT_CHARS} characters` },
      { status: 400 }
    );
  }
  // Suppress unused-var lint without dropping the field — we may want to surface
  // a mismatch warning between client-claimed property and session metadata later.
  void propertyHint;

  try {
    const drive = getDrive();
    const meta = await loadSessionMeta(drive, cleanId);
    if (!meta) {
      return NextResponse.json(
        { error: "Session folder not found — start a new clean" },
        { status: 404 }
      );
    }

    const sheets = getSheets();
    await withRetry(
      () =>
        sheets.spreadsheets.values.append(
          {
            spreadsheetId: SHEET_ID,
            range: "Maintenance Requests!A:G",
            valueInputOption: "USER_ENTERED",
            // Col G = Submitted By: the session team ("" for legacy logins).
            requestBody: {
              values: [
                [meta.date, meta.property, meta.startTime, cleanId, text, "Pending", session.team],
              ],
            },
          },
          { timeout: SHEETS_TIMEOUT_MS }
        ),
      { label: "maint-text-append" }
    );

    console.log(
      `[maint-text] cleanId=${cleanId} property="${meta.property}" chars=${text.length}`
    );
    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[maint-text] failed cleanId=${cleanId}:`, err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
