import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getDrive, getSheets, SHEET_ID, DRIVE_ROOT_FOLDER_ID } from "@/lib/google";
import { Readable } from "stream";

async function findOrCreateFolder(
  drive: ReturnType<typeof getDrive>,
  name: string,
  parentId: string
): Promise<string> {
  const query = `name='${name.replace(/'/g, "\\'")}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const res = await drive.files.list({ q: query, fields: "files(id)" });
  if (res.data.files && res.data.files.length > 0) {
    return res.data.files[0].id!;
  }
  const folder = await drive.files.create({
    requestBody: {
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    },
    fields: "id",
  });
  return folder.data.id!;
}

export async function POST(req: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const formData = await req.formData();
  const property = formData.get("property") as string;
  const files = formData.getAll("photos") as File[];

  if (!property || files.length === 0) {
    return NextResponse.json({ error: "Missing property or photos" }, { status: 400 });
  }

  const drive = getDrive();
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" }); // YYYY-MM-DD

  // Create folder hierarchy: root > property > date
  const propertyFolderId = await findOrCreateFolder(drive, property, DRIVE_ROOT_FOLDER_ID);
  const dateFolderId = await findOrCreateFolder(drive, dateStr, propertyFolderId);

  // Upload each photo
  let uploadedCount = 0;
  for (const file of files) {
    const timestamp = new Date();
    const timeStr = timestamp.toLocaleTimeString("en-US", {
      timeZone: "America/Los_Angeles",
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).replace(/:/g, "-");

    const fileName = `photo_${timeStr}_${uploadedCount + 1}.jpg`;
    const buffer = Buffer.from(await file.arrayBuffer());

    await drive.files.create({
      requestBody: {
        name: fileName,
        parents: [dateFolderId],
      },
      media: {
        mimeType: "image/jpeg",
        body: Readable.from(buffer),
      },
    });
    uploadedCount++;
  }

  // Update the Clean Log with photo count (column E)
  // Find the matching row (most recent row with this property and no finish time)
  const sheets = getSheets();
  const logData = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "Clean Log!A:E",
  });

  const rows = logData.data.values || [];
  let targetRow = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i][1] === property && (!rows[i][3] || rows[i][3] === "")) {
      targetRow = i + 1; // 1-indexed for Sheets API
      break;
    }
  }

  if (targetRow > 0) {
    // Get existing photo count and add to it
    const existing = rows[targetRow - 1][4];
    const existingCount = existing ? parseInt(existing, 10) || 0 : 0;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Clean Log!E${targetRow}`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[(existingCount + uploadedCount).toString()]],
      },
    });
  }

  return NextResponse.json({ success: true, count: uploadedCount });
}
