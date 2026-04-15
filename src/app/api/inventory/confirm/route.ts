import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getSheets, SHEET_ID } from "@/lib/google";

export async function POST(req: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { property, items } = await req.json();
  if (!property || !items || !Array.isArray(items)) {
    return NextResponse.json({ error: "Missing data" }, { status: 400 });
  }

  const date = new Date().toLocaleDateString("en-US", { timeZone: "America/Los_Angeles" });
  const sheets = getSheets();

  const rows = items.map((item: { item: string; quantity: number; notes: string }) => [
    date,
    property,
    item.item,
    item.quantity.toString(),
    item.notes || "",
    "Pending",
  ]);

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: "Inventory Requests!A:F",
    valueInputOption: "USER_ENTERED",
    requestBody: { values: rows },
  });

  return NextResponse.json({ success: true, count: rows.length });
}
