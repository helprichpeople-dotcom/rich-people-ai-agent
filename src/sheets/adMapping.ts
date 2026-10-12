import { readSheetValues } from "./client.js";
import type { AdMapping, Product } from "../types/catalog.js";

export type AdMappingResult = { map: Map<string, AdMapping>; warnings: string[] };

/**
 * Ad_Mapping tab: ad_id | product_id | platform | campaign_name | active | note.
 * Rows with unknown/inactive product are skipped; duplicate ad_id -> last wins (warned).
 * Empty `active` counts as active; only explicit FALSE disables.
 */
export function parseAdMapping(rows: string[][], products: Product[]): AdMappingResult {
  const map = new Map<string, AdMapping>();
  const warnings: string[] = [];
  if (rows.length < 2) return { map, warnings };
  const header = rows[0].map((h) => String(h || "").trim().toLowerCase());
  const c = (n: string) => header.indexOf(n);
  if (c("ad_id") < 0 || c("product_id") < 0) {
    warnings.push("Ad_Mapping header missing ad_id/product_id");
    return { map, warnings };
  }
  const ids = new Set(products.map((p) => p.product_id.toLowerCase()));
  rows.slice(1).forEach((row, i) => {
    const g = (n: string) => (c(n) >= 0 ? String(row[c(n)] ?? "").trim() : "");
    const ad_id = g("ad_id");
    const product_id = g("product_id");
    if (!ad_id) return;
    if (g("active").toUpperCase() === "FALSE") return;
    if (!product_id || !ids.has(product_id.toLowerCase())) {
      warnings.push(`row ${i + 2}: ad ${ad_id} -> unknown/inactive product "${product_id}"`);
      return;
    }
    const pl = g("platform").toLowerCase();
    const platform = pl === "messenger" || pl === "whatsapp" ? pl : "both";
    if (map.has(ad_id)) warnings.push(`row ${i + 2}: duplicate ad_id ${ad_id} (last wins)`);
    const real = products.find((p) => p.product_id.toLowerCase() === product_id.toLowerCase())!;
    map.set(ad_id, { ad_id, product_id: real.product_id, platform, campaign_name: g("campaign_name") });
  });
  return { map, warnings };
}

/** Missing tab -> empty mapping (never throws for that). */
export async function loadAdMappingRows(): Promise<string[][]> {
  try {
    return await readSheetValues("Ad_Mapping!A:F");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Unable to parse range|not found/i.test(msg)) return [];
    throw err;
  }
}

export function lookupAd(map: Map<string, AdMapping>, refId: string | undefined, platform: "messenger" | "whatsapp"): AdMapping | null {
  if (!refId) return null;
  const m = map.get(String(refId).trim());
  if (!m) return null;
  return m.platform === "both" || m.platform === platform ? m : null;
}
