import { readSheetValues } from "./client.js";
import type { Product } from "../types/catalog.js";

function toBool(v: string): boolean {
  return String(v ?? "").trim().toUpperCase() === "TRUE";
}

function toNum(v: string): number {
  const n = Number(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

export const REQUIRED_PRODUCT_COLUMNS = [
  "product_id", "product_name", "price", "stock_status", "description", "benefits",
  "delivery_inside_dhaka", "delivery_outside_dhaka", "product_url", "image_url", "offer", "faq", "active",
] as const;

/** Pure parser (testable). `aliases` column is optional. Inactive / id-less rows dropped. */
export function parseProducts(rows: string[][]): Product[] {
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => String(h || "").trim());
  const idx = (name: string) => header.indexOf(name);
  for (const col of REQUIRED_PRODUCT_COLUMNS) {
    if (idx(col) < 0) throw new Error(`Products শিটে কলাম নেই: ${col}`);
  }
  const ai = idx("aliases");
  const opt = (row: string[], c: string) => (idx(c) >= 0 ? String(row[idx(c)] ?? "").trim() : "");
  const get = (row: string[], c: string) => String(row[idx(c)] ?? "").trim();
  return rows
    .slice(1)
    .map((row) => ({
      product_id: get(row, "product_id"),
      product_name: get(row, "product_name"),
      price: toNum(get(row, "price")),
      stock_status: get(row, "stock_status"),
      description: get(row, "description"),
      benefits: get(row, "benefits"),
      delivery_inside_dhaka: toNum(get(row, "delivery_inside_dhaka")),
      delivery_outside_dhaka: toNum(get(row, "delivery_outside_dhaka")),
      product_url: get(row, "product_url"),
      image_url: get(row, "image_url"),
      offer: get(row, "offer"),
      faq: get(row, "faq"),
      active: toBool(get(row, "active")),
      pricing: Object.fromEntries(PRICING_COLUMNS.map((c) => [c, opt(row, c)])) as NonNullable<Product["pricing"]>,
      aliases: ai >= 0 ? String(row[ai] ?? "").split(/[,;|]/).map((s) => s.trim()).filter(Boolean) : [],
    }))
    .filter((p) => p.product_id && p.active);
}

export const PRICING_COLUMNS = [
  "regular_price", "min_sale_price", "max_sale_price", "negotiation_enabled",
  "negotiation_mode", "max_discount_amount", "price_step", "pricing_notes",
] as const;

export async function loadProducts(): Promise<Product[]> {
  return parseProducts(await readSheetValues("Products!A:Z"));
}

export function findProducts(products: Product[], query: string): Product[] {
  const q = query.trim().toLowerCase();
  if (!q) return products;
  return products.filter((p) => {
    const hay = [p.product_id, p.product_name, p.description, p.benefits, p.offer, p.faq, ...(p.aliases || [])]
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });
}

/** Lowercase, Bangla digits -> ASCII, strip punctuation, collapse spaces. */
export function normalizeText(s: string): string {
  return String(s || "")
    .toLowerCase()
    .replace(/[০-৯]/g, (d) => String("০১২৩৪৫৬৭৮৯".indexOf(d)))
    .replace(/[^\p{L}\p{M}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 99;
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

const STOP = new Set(["the", "and", "for", "with", "rich", "people", "oil", "ml", "gm", "pcs", "pack", "set"]);

export type ResolveResult =
  | { kind: "match"; product: Product; score: number }
  | { kind: "ambiguous"; candidates: Product[] }
  | { kind: "none" };

/**
 * Identify product from customer text. Exact id / full name / alias = strong (score 1).
 * Otherwise distinctive name words (typo tolerant) score partial. Ties -> ambiguous (ask).
 */
export function resolveProduct(text: string, products: Product[]): ResolveResult {
  const t = normalizeText(text);
  if (!t) return { kind: "none" };
  const words = t.split(" ");
  const scored: { p: Product; s: number }[] = [];
  for (const p of products) {
    const id = normalizeText(p.product_id);
    const names = [p.product_name, ...(p.aliases || [])].map(normalizeText).filter((n) => n.length >= 3);
    let s = 0;
    if (id && (` ${t} `.includes(` ${id} `) || t.replace(/[\s-]/g, "").includes(id.replace(/[\s-]/g, "")))) s = 1;
    else if (names.some((n) => ` ${t} `.includes(` ${n} `))) s = 1;
    else {
      const toks = [...new Set(names.join(" ").split(" "))].filter((w) => w.length >= 3 && !STOP.has(w));
      if (toks.length) {
        const hit = toks.filter((w) => words.some((x) => x === w || (w.length >= 5 && x.length >= 4 && editDistance(x, w) <= 1)));
        s = hit.length ? 0.4 + 0.5 * (hit.length / toks.length) : 0;
      }
    }
    if (s > 0) scored.push({ p, s });
  }
  if (!scored.length) return { kind: "none" };
  scored.sort((a, b) => b.s - a.s);
  const top = scored[0].s;
  const tied = scored.filter((x) => x.s >= top - 0.05);
  if (tied.length > 1) return { kind: "ambiguous", candidates: tied.map((x) => x.p).slice(0, 5) };
  if (top < 0.6 && scored.length > 1) return { kind: "ambiguous", candidates: scored.map((x) => x.p).slice(0, 5) };
  return { kind: "match", product: scored[0].p, score: top };
}
