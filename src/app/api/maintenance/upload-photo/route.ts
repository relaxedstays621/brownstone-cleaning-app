import { NextRequest, NextResponse } from "next/server";
import { Readable } from "stream";
import { isAuthenticated } from "@/lib/auth";
import { getDrive, MAINTENANCE_DRIVE_ROOT_FOLDER_ID } from "@/lib/google";
import { withRetry } from "@/lib/retry";

const DRIVE_TIMEOUT_MS = 30_000;
const MAX_UPLOAD_BYTES = 12 * 1024 * 1024;

function escapeForDriveQuery(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function findOrCreateMaintenanceFolder(
  drive: ReturnType<typeof getDrive>,
  cleanId: string
): Promise<string> {
  const folderName = `maintenance_${cleanId}`;
  const safeName = escapeForDriveQuery(folderName);
  const safeParent = escapeForDriveQuery(MAINTENANCE_DRIVE_ROOT_FOLDER_ID);
  const q = `name='${safeName}' and '${safeParent}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;

  const list = await withRetry(
    () =>
      drive.files.list(
        { q, fields: "files(id)", pageSize: 1 },
        { timeout: DRIVE_TIMEOUT_MS }
      ),
    { label: `maint-folder-lookup:${cleanId.slice(0, 8)}` }
  );
  if (list.data.files && list.data.files.length > 0) {
    return list.data.files[0].id!;
  }

  const created = await withRetry(
    () =>
      drive.files.create(
        {
          requestBody: {
            name: folderName,
            mimeType: "application/vnd.google-apps.folder",
            parents: [MAINTENANCE_DRIVE_ROOT_FOLDER_ID],
            appProperties: { cleanId },
          },
          fields: "id",
        },
        { timeout: DRIVE_TIMEOUT_MS }
      ),
    { label: `maint-folder-create:${cleanId.slice(0, 8)}` }
  );
  return created.data.id!;
}

async function findExistingByUploadId(
  drive: ReturnType<typeof getDrive>,
  uploadId: string,
  folderId: string
): Promise<string | null> {
  const safe = escapeForDriveQuery(uploadId);
  const q = `'${folderId}' in parents and trashed=false and appProperties has { key='uploadId' and value='${safe}' }`;
  const res = await withRetry(
    () =>
      drive.files.list(
        { q, fields: "files(id)", pageSize: 1, spaces: "drive" },
        { timeout: DRIVE_TIMEOUT_MS }
      ),
    { label: `maint-dedup:${uploadId.slice(0, 8)}` }
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
    console.error("[maint-upload] formData parse error:", err);
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
    `[maint-upload] cleanId=${cleanId} uploadId=${uploadId} size=${file.size}`
  );

  try {
    const drive = getDrive();
    const folderId = await findOrCreateMaintenanceFolder(drive, cleanId);

    const existingId = await findExistingByUploadId(drive, uploadId, folderId);
    if (existingId) {
      console.log(`[maint-upload] dedup hit uploadId=${uploadId} fileId=${existingId}`);
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
    const fileName = `maint_${timeStr}_${uploadId.slice(0, 8)}.jpg`;
    const buffer = Buffer.from(await file.arrayBuffer());

    const created = await withRetry(
      () =>
        drive.files.create(
          {
            requestBody: {
              name: fileName,
              parents: [folderId],
              appProperties: { uploadId, cleanId },
            },
            media: { mimeType: "image/jpeg", body: Readable.from(buffer) },
            fields: "id",
          },
          { timeout: DRIVE_TIMEOUT_MS }
        ),
      { label: `maint-file-create:${uploadId.slice(0, 8)}` }
    );

    return NextResponse.json({ success: true, fileId: created.data.id, alreadyExisted: false });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[maint-upload] failed uploadId=${uploadId}:`, err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
