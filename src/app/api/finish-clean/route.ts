import { NextRequest, NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import {
  getSheets,
  SHEET_ID,
  CLEAN_LOG_RANGE,
  CLEAN_LOG_CLEAN_ID_COL,
} from "@/lib/google";
import { withRetry } from "@/lib/retry";

const SHEETS_TIMEOUT_MS = 15_000;

export async function POST(req: NextRequest) {
  if (!(await isAuthenticated())) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { property, cleanId } = await req.json();
  const now = new Date();
  const finishTime = now.toLocaleTimeString("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  try {
    const sheets = getSheets();
    const logData = await withRetry(
      () =>
        sheets.spreadsheets.values.get(
          { spreadsheetId: SHEET_ID, range: CLEAN_LOG_RANGE },
          { timeout: SHEETS_TIMEOUT_MS }
        ),
      { label: "finish-clean:sheet-read" }
    );
    const rows = logData.data.values || [];
    let targetRow = -1;
    if (cleanId) {
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i][CLEAN_LOG_CLEAN_ID_COL] === cleanId) {
          targetRow = i + 1;
          break;
        }
      }
    }
    if (targetRow < 0 && property) {
      // Fallback for legacy rows that have no Clean ID
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i][1] === property && (!rows[i][3] || rows[i][3] === "")) {
          targetRow = i + 1;
          break;
        }
      }
    }

    if (targetRow > 0) {
      await withRetry(
        () =>
          sheets.spreadsheets.values.update(
            {
              spreadsheetId: SHEET_ID,
              range: `Clean Log!D${targetRow}`,
              valueInputOption: "USER_ENTERED",
              requestBody: { values: [[finishTime]] },
            },
            { timeout: SHEETS_TIMEOUT_MS }
          ),
        { label: "finish-clean:sheet-write" }
      );
    }

    return NextResponse.json({ success: true, finishTime });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[finish-clean] failed:", err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
