import { readSheetValues } from "./client.js";
import type { SettingMap } from "../types/catalog.js";

export async function loadSettings(): Promise<SettingMap> {
  const rows = await readSheetValues("Settings!A:C");
  const map: SettingMap = {};
  for (const row of rows.slice(1)) {
    const key = (row[0] || "").trim();
    const value = (row[1] || "").trim();
    if (key) map[key] = value;
  }
  return map;
}
