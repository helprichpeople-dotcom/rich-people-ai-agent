import { google } from "googleapis";
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

export function getSheetsClient() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_CONTENT || "";
  const jsonPath = path.resolve(process.cwd(), config.googleServiceAccountJson);
  let credentials: any;
  if (raw.trim()) {
    credentials = JSON.parse(raw);
  } else if (fs.existsSync(jsonPath)) {
    credentials = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  } else {
    throw new Error(
      `Google Service Account JSON পাওয়া যায়নি। Render-এ GOOGLE_SERVICE_ACCOUNT_JSON_CONTENT সেট করুন অথবা লোকালে ${jsonPath} রাখুন।`
    );
  }
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  return google.sheets({ version: "v4", auth });
}


export async function readSheetValues(
  range: string
): Promise<string[][]> {
  const sheets = getSheetsClient();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: config.sheetsId,
    range,
  });
  return (res.data.values as string[][]) || [];
}
