import { NextResponse } from "next/server";
import { getDrive, DRIVE_ROOT_FOLDER_ID } from "@/lib/google";

export async function GET() {
  const drive = getDrive();
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - 45);

  let deleted = 0;

  async function cleanFolder(folderId: string) {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: "files(id, name, mimeType, modifiedTime)",
    });

    for (const file of res.data.files || []) {
      if (file.mimeType === "application/vnd.google-apps.folder") {
        await cleanFolder(file.id!);
        // Check if folder is now empty
        const children = await drive.files.list({
          q: `'${file.id}' in parents and trashed=false`,
          fields: "files(id)",
        });
        if (!children.data.files || children.data.files.length === 0) {
          await drive.files.delete({ fileId: file.id! });
        }
      } else if (file.modifiedTime && new Date(file.modifiedTime) < cutoffDate) {
        await drive.files.delete({ fileId: file.id! });
        deleted++;
      }
    }
  }

  try {
    await cleanFolder(DRIVE_ROOT_FOLDER_ID);
    return NextResponse.json({ success: true, deleted });
  } catch (error) {
    console.error("Cleanup error:", error);
    return NextResponse.json(
      { error: "Cleanup failed", details: String(error) },
      { status: 500 }
    );
  }
}
