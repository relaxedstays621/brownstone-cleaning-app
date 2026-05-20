import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import {
  getSheets,
  SHEET_ID,
  CLEAN_LOG_RANGE,
  CLEAN_LOG_CLEAN_ID_COL,
  CLEAN_LOG_INVENTORY_REQUEST_COL_LETTER,
} from "@/lib/google";
import { withRetry } from "@/lib/retry";

const SHEETS_TIMEOUT_MS = 15_000;

async function markInventoryRequestOnCleanLog(
  sheets: ReturnType<typeof getSheets>,
  cleanId: string
): Promise<void> {
  const logData = await withRetry(
    () =>
      sheets.spreadsheets.values.get(
        { spreadsheetId: SHEET_ID, range: CLEAN_LOG_RANGE },
        { timeout: SHEETS_TIMEOUT_MS }
      ),
    { label: "inv-confirm:read-clean-log" }
  );
  const rows = logData.data.values || [];
  let targetRow = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i][CLEAN_LOG_CLEAN_ID_COL] === cleanId) {
      targetRow = i + 1;
      break;
    }
  }
  if (targetRow < 0) {
    console.warn(`[inventory/confirm] no Clean Log row for cleanId=${cleanId}`);
    return;
  }

  await withRetry(
    () =>
      sheets.spreadsheets.values.update(
        {
          spreadsheetId: SHEET_ID,
          range: `Clean Log!${CLEAN_LOG_INVENTORY_REQUEST_COL_LETTER}${targetRow}`,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [["Yes"]] },
        },
        { timeout: SHEETS_TIMEOUT_MS }
      ),
    { label: "inv-confirm:mark-clean-log" }
  );
}

export async function POST(req: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: {
    property?: string;
    cleanId?: string;
    items?: Array<{ item: string; quantity: number; notes?: string }>;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { property, cleanId, items } = body;
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

  // Best-effort: flag the Clean Log row. Sheet append already succeeded, so a
  // failure here should not look like a failed inventory submission to the cleaner.
  if (cleanId) {
    try {
      await markInventoryRequestOnCleanLog(sheets, cleanId);
    } catch (err) {
      console.error(
        `[inventory/confirm] mark-clean-log failed cleanId=${cleanId}:`,
        err
      );
    }
  }

  return NextResponse.json({ success: true, count: rows.length });
}
