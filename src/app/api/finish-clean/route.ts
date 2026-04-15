import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getSheets, SHEET_ID } from "@/lib/google";

export async function POST(req: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { property } = await req.json();
  const now = new Date();
  const finishTime = now.toLocaleTimeString("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  const sheets = getSheets();
  const logData = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "Clean Log!A:E",
  });

  const rows = logData.data.values || [];
  let targetRow = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i][1] === property && (!rows[i][3] || rows[i][3] === "")) {
      targetRow = i + 1;
      break;
    }
  }

  if (targetRow > 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Clean Log!D${targetRow}`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[finishTime]],
      },
    });
  }

  return NextResponse.json({ success: true, finishTime });
}
