import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getDrive, MAINTENANCE_DRIVE_ROOT_FOLDER_ID } from "@/lib/google";
import { withRetry } from "@/lib/retry";

// Ground-truth photo count for a clean, read straight from Drive — this is what the
// Finish modal shows so the "N photos uploaded" tripwire reflects what actually
// landed (not a client-side tally that resets on clearAll / reload / a version-gate
// refresh). Counts the Submit-Photos session folder and the maintenance folder
// separately; they are distinct categories (a clean needs its own photos, while
// maintenance photos are incidental issue reports).
export const dynamic = "force-dynamic";

const DRIVE_TIMEOUT_MS = 15_000;

function escapeForDriveQuery(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function countImagesInNamedFolder(
  drive: ReturnType<typeof getDrive>,
  name: string,
  parentId?: string
): Promise<number> {
  const safeName = escapeForDriveQuery(name);
  let q = `name='${safeName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  if (parentId) q += ` and '${escapeForDriveQuery(parentId)}' in parents`;
  const folderRes = await withRetry(
    () => drive.files.list({ q, fields: "files(id)", pageSize: 1 }, { timeout: DRIVE_TIMEOUT_MS }),
    { label: `photo-count:folder:${name.slice(0, 16)}` }
  );
  const folderId = folderRes.data.files?.[0]?.id;
  if (!folderId) return 0;

  let total = 0;
  let pageToken: string | undefined;
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
      { label: "photo-count:images" }
    );
    total += res.data.files?.length ?? 0;
    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);
  return total;
}

export async function GET(req: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const cleanId = req.nextUrl.searchParams.get("cleanId");
  if (!cleanId) {
    return NextResponse.json({ error: "Missing cleanId" }, { status: 400 });
  }

  try {
    const drive = getDrive();
    const [photos, maintenance] = await Promise.all([
      countImagesInNamedFolder(drive, `clean_${cleanId}`),
      countImagesInNamedFolder(drive, `maintenance_${cleanId}`, MAINTENANCE_DRIVE_ROOT_FOLDER_ID),
    ]);
    return NextResponse.json({ photos, maintenance });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[photo-count] failed cleanId=${cleanId}:`, err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
