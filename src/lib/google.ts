import { google } from "googleapis";

function getAuth() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
  oauth2Client.setCredentials({
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
  });
  return oauth2Client;
}

export function getDrive() {
  return google.drive({ version: "v3", auth: getAuth() });
}

export function getSheets() {
  return google.sheets({ version: "v4", auth: getAuth() });
}

export const SHEET_ID = process.env.GOOGLE_SHEET_ID!;
export const DRIVE_ROOT_FOLDER_ID = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID!;

const CLEAN_LOG_HEADERS = ["Date", "Property", "Start Time", "Finish Time", "# Photos"];
const INVENTORY_HEADERS = ["Date", "Property", "Item", "Quantity", "Notes", "Status"];

export async function ensureSheetHeaders() {
  const sheets = getSheets();

  // Check Clean Log tab
  const cleanLog = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "Clean Log!A1:E1",
  });
  if (!cleanLog.data.values || cleanLog.data.values.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: "Clean Log!A1:E1",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [CLEAN_LOG_HEADERS] },
    });
  }

  // Check Inventory Requests tab
  const inventory = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "Inventory Requests!A1:F1",
  });
  if (!inventory.data.values || inventory.data.values.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: "Inventory Requests!A1:F1",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [INVENTORY_HEADERS] },
    });
  }
}
