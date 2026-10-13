import type { AdMapping, Product, SettingMap } from "../types/catalog.js";
import { parseProducts } from "./products.js";
import { readSheetValues } from "./client.js";
import { loadSettings } from "./settings.js";
import { loadAdMappingRows, parseAdMapping } from "./adMapping.js";
import { getPricingConfig } from "../pricing/config.js";
import { clearImageHashCache } from "../media/match.js";
import { clearValidateCache } from "../media/validate.js";

export type Catalog = {
  products: Product[];
  settings: SettingMap;
  adMap: Map<string, AdMapping>;
  warnings: string[];
  loadedAt: number;
  stale: boolean;
};

export type CatalogSource = {
  productRows: () => Promise<string[][]>;
  settings: () => Promise<SettingMap>;
  adRows: () => Promise<string[][]>;
};

const defaultSource: CatalogSource = {
  productRows: () => readSheetValues("Products!A:Z"),
  settings: loadSettings,
  adRows: loadAdMappingRows,
};

let source: CatalogSource = defaultSource;
let current: Catalog | null = null;
let inflight: Promise<Catalog> | null = null;
export const CATALOG_TTL_MS = Number(process.env.CATALOG_TTL_MS || 60_000);

export function setCatalogSource(s: CatalogSource | null): void {
  source = s || defaultSource;
  current = null;
  inflight = null;
}

async function build(): Promise<Catalog> {
  const [productRows, settings] = await Promise.all([source.productRows(), source.settings()]);
  const products = parseProducts(productRows);
  let adRows: string[][] = [];
  const warnings: string[] = [];
  try {
    adRows = await source.adRows();
  } catch (err) {
    warnings.push(`Ad_Mapping load failed: ${err instanceof Error ? err.message : err}`);
    if (current) return { ...current, products, settings, warnings, loadedAt: Date.now(), stale: false };
  }
  const ad = parseAdMapping(adRows, products);
  warnings.push(...ad.warnings);
  for (const p of products) {
    const pc = getPricingConfig(p);
    if (!pc.ok) warnings.push(`pricing config ${p.product_id}: ${pc.reason} (negotiation off)`);
  }
  return { products, settings, adMap: ad.map, warnings, loadedAt: Date.now(), stale: false };
}

function imagesChanged(a: Product[], b: Product[]): boolean {
  const m = new Map(a.map((p) => [p.product_id, p.image_url]));
  return b.some((p) => m.has(p.product_id) && m.get(p.product_id) !== p.image_url);
}

/** Force reload. On API failure keeps last good catalog (marked stale); throws only if none. */
export async function refreshCatalog(now = Date.now()): Promise<Catalog> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const next = await build();
      if (current && imagesChanged(current.products, next.products)) {
        clearImageHashCache();
        clearValidateCache();
      }
      if (next.warnings.length) console.warn(`[catalog] ${next.warnings.join("; ")}`);
      console.log(`[catalog] loaded products=${next.products.length} ads=${next.adMap.size}`);
      current = { ...next, loadedAt: now };
      return current;
    } catch (err) {
      console.error("[catalog] refresh failed:", err instanceof Error ? err.message : err);
      if (current) {
        current = { ...current, stale: true, loadedAt: now };
        return current;
      }
      throw err;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export async function getCatalog(now = Date.now()): Promise<Catalog> {
  if (current && now - current.loadedAt < CATALOG_TTL_MS) return current;
  return refreshCatalog(now);
}

export function catalogStatus() {
  return current
    ? { products: current.products.length, ads: current.adMap.size, loadedAt: current.loadedAt, stale: current.stale, warnings: current.warnings }
    : { products: 0, ads: 0, loadedAt: 0, stale: true, warnings: ["not loaded"] };
}
