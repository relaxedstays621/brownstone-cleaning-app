import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getDrive, DRIVE_ROOT_FOLDER_ID } from "@/lib/google";
import { withRetry } from "@/lib/retry";
import { Readable } from "stream";

const DRIVE_TIMEOUT_MS = 30_000;

async function findOrCreateFolder(
  drive: ReturnType<typeof getDrive>,
  name: string,
  parentId: string
): Promise<string> {
  const safeName = name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const query = `name='${safeName}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;

  const list = await withRetry(
    () =>
      drive.files.list(
        { q: query, fields: "files(id)", pageSize: 1 },
        { timeout: DRIVE_TIMEOUT_MS }
      ),
    { label: `folder-list:${name}` }
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
    { label: `folder-create:${name}` }
  );
  return created.data.id!;
}

async function findExistingByUploadId(
  drive: ReturnType<typeof getDrive>,
  uploadId: string,
  folderId: string
): Promise<string | null> {
  const safe = uploadId.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const query = `'${folderId}' in parents and trashed=false and appProperties has { key='uploadId' and value='${safe}' }`;
  const res = await withRetry(
    () =>
      drive.files.list(
        { q: query, fields: "files(id)", pageSize: 1, spaces: "drive" },
        { timeout: DRIVE_TIMEOUT_MS }
      ),
    { label: `dedup-lookup:${uploadId}` }
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

  const property = formData.get("property") as string | null;
  const uploadId = formData.get("uploadId") as string | null;
  const file = formData.get("photo") as File | null;

  if (!property || !uploadId || !file) {
    return NextResponse.json(
      { error: "Missing property, uploadId, or photo" },
      { status: 400 }
    );
  }

  console.log(`[upload-photos] property=${property} uploadId=${uploadId} size=${file.size}`);

  try {
    const drive = getDrive();
    const dateStr = new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    const propertyFolderId = await findOrCreateFolder(drive, property, DRIVE_ROOT_FOLDER_ID);
    const dateFolderId = await findOrCreateFolder(drive, dateStr, propertyFolderId);

    const existingId = await findExistingByUploadId(drive, uploadId, dateFolderId);
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
              parents: [dateFolderId],
              appProperties: { uploadId },
            },
            media: { mimeType: "image/jpeg", body: Readable.from(buffer) },
            fields: "id",
          },
          { timeout: DRIVE_TIMEOUT_MS }
        ),
      { label: `file-create:${uploadId}` }
    );

    return NextResponse.json({ success: true, fileId: created.data.id, alreadyExisted: false });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[upload-photos] failed uploadId=${uploadId}:`, err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
