import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getSheets, SHEET_ID, ensureSheetHeaders } from "@/lib/google";

export async function POST(req: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { property } = await req.json();
  const now = new Date();
  const date = now.toLocaleDateString("en-US", { timeZone: "America/Los_Angeles" });
  const startTime = now.toLocaleTimeString("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  await ensureSheetHeaders();

  const sheets = getSheets();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: "Clean Log!A:E",
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[date, property, startTime, "", ""]],
    },
  });

  return NextResponse.json({ success: true, date, startTime });
}
