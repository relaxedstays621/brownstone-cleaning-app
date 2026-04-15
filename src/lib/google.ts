import { google } from "googleapis";

function getAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "{}");
  return new google.auth.GoogleAuth({
    credentials,
    scopes: [
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/spreadsheets",
    ],
  });
}

export function getDrive() {
  return google.drive({ version: "v3", auth: getAuth() });
}

export function getSheets() {
  return google.sheets({ version: "v4", auth: getAuth() });
}

export const SHEET_ID = process.env.GOOGLE_SHEET_ID!;
export const DRIVE_ROOT_FOLDER_ID = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID!;
