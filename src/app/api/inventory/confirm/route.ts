import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getSheets, SHEET_ID } from "@/lib/google";
import { withRetry } from "@/lib/retry";

const SHEETS_TIMEOUT_MS = 15_000;

export async function POST(req: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { property?: string; items?: Array<{ item: string; quantity: number; notes?: string }> };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { property, items } = body;
  if (!property || !items || !Array.isArray(items) || items.length === 0) {
    return NextResponse.json({ error: "Missing property or items" }, { status: 400 });
  }

  const date = new Date().toLocaleDateString("en-US", { timeZone: "America/Los_Angeles" });
  const sheets = getSheets();
  const rows = items.map((item) => [
    date,
    property,
    item.item,
    item.quantity.toString(),
    item.notes || "",
    "Pending",
  ]);

  try {
    await withRetry(
      () =>
        sheets.spreadsheets.values.append(
          {
            spreadsheetId: SHEET_ID,
            range: "Inventory Requests!A:F",
            valueInputOption: "USER_ENTERED",
            requestBody: { values: rows },
          },
          { timeout: SHEETS_TIMEOUT_MS }
        ),
      { label: "inventory-append" }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[inventory/confirm] append failed:", err);
    return NextResponse.json({ error: message }, { status: 502 });
  }

  return NextResponse.json({ success: true, count: rows.length });
}
