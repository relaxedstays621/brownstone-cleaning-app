import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getDrive, appendUploadLog } from "@/lib/google";
import { withRetry } from "@/lib/retry";
import { Readable } from "stream";

const DRIVE_TIMEOUT_MS = 30_000;
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

function escapeForDriveQuery(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function findSessionFolder(
  drive: ReturnType<typeof getDrive>,
  cleanId: string
): Promise<string | null> {
  const safeId = escapeForDriveQuery(cleanId);
  const q = `name='clean_${safeId}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const res = await withRetry(
    () => drive.files.list({ q, fields: "files(id)", pageSize: 1 }, { timeout: DRIVE_TIMEOUT_MS }),
    { label: `session-folder:${cleanId.slice(0, 8)}` }
  );
  return res.data.files?.[0]?.id ?? null;
}

async function findExistingByUploadId(
  drive: ReturnType<typeof getDrive>,
  uploadId: string,
  sessionFolderId: string
): Promise<string | null> {
  const safe = escapeForDriveQuery(uploadId);
  const q = `'${sessionFolderId}' in parents and trashed=false and appProperties has { key='uploadId' and value='${safe}' }`;
  const res = await withRetry(
    () =>
      drive.files.list(
        { q, fields: "files(id)", pageSize: 1, spaces: "drive" },
        { timeout: DRIVE_TIMEOUT_MS }
      ),
    { label: `dedup-lookup:${uploadId.slice(0, 8)}` }
  );
  return res.data.files?.[0]?.id ?? null;
}

export async function POST(req: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch (err) {
    console.error("[upload-photos] formData parse error:", err);
    return NextResponse.json({ error: "Invalid form data" }, { status: 400 });
  }

  const cleanId = formData.get("cleanId") as string | null;
  const uploadId = formData.get("uploadId") as string | null;
  const file = formData.get("photo") as File | null;

  if (!cleanId || !uploadId || !file) {
    return NextResponse.json(
      { error: "Missing cleanId, uploadId, or photo" },
      { status: 400 }
    );
  }

  // Processed photos are well under 1 MB; this only catches a raw original that
  // slipped past the client guard. 413 is terminal client-side (not retried).
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      { error: "Photo too large — please retake it" },
      { status: 413 }
    );
  }

  console.log(
    `[upload-photos] cleanId=${cleanId} uploadId=${uploadId} size=${file.size}`
  );

  try {
    const drive = getDrive();
    const sessionFolderId = await findSessionFolder(drive, cleanId);
    if (!sessionFolderId) {
      return NextResponse.json(
        { error: "Session folder not found — start a new clean" },
        { status: 404 }
      );
    }

    const existingId = await findExistingByUploadId(drive, uploadId, sessionFolderId);
    if (existingId) {
      console.log(`[upload-photos] dedup hit uploadId=${uploadId} fileId=${existingId}`);
      return NextResponse.json({ success: true, fileId: existingId, alreadyExisted: true });
    }

    const timeStr = new Date()
      .toLocaleTimeString("en-US", {
        timeZone: "America/Los_Angeles",
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
      .replace(/:/g, "-");
    const fileName = `photo_${timeStr}_${uploadId.slice(0, 8)}.jpg`;
    const buffer = Buffer.from(await file.arrayBuffer());

    const created = await withRetry(
      () =>
        drive.files.create(
          {
            requestBody: {
              name: fileName,
              parents: [sessionFolderId],
              appProperties: { uploadId },
            },
            media: { mimeType: "image/jpeg", body: Readable.from(buffer) },
            fields: "id",
          },
          { timeout: DRIVE_TIMEOUT_MS }
        ),
      { label: `file-create:${uploadId.slice(0, 8)}` }
    );

    return NextResponse.json({ success: true, fileId: created.data.id, alreadyExisted: false });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[upload-photos] failed uploadId=${uploadId}:`, err);
    // Record the server-side failure (Drive/Sheets) the client only sees as a 502.
    await appendUploadLog({
      timestamp: new Date().toLocaleString("en-US", { timeZone: "America/Los_Angeles" }),
      event: "server-upload-error",
      cleanId,
      uploadId,
      status: 502,
      error: message,
      photoSize: file.size,
    });
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
