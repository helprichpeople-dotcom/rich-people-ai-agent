// Mock catalog fixtures (no network). 25 products.
import type { Catalog } from "./sheets/catalog.js";
import { parseProducts, REQUIRED_PRODUCT_COLUMNS } from "./sheets/products.js";
import { parseAdMapping } from "./sheets/adMapping.js";

const NAMES = [
  "Onion Hair Oil", "Aloe Vera Gel", "Vitamin C Serum", "Charcoal Face Wash", "Rose Water Toner",
  "Neem Soap", "Argan Hair Mask", "Sunscreen SPF50", "Lip Balm Strawberry", "Coconut Body Lotion",
  "Beard Growth Oil", "Kojic Acid Cream", "Tea Tree Shampoo", "Herbal Conditioner", "Saffron Night Cream",
  "Turmeric Face Pack", "Hyaluronic Moisturizer", "Retinol Serum", "Under Eye Cream", "Black Seed Oil",
  "Keratin Hair Serum", "Whitening Body Wash", "Foot Care Cream", "Nail Growth Oil", "Perfume Oud Royal",
];

export function productRows(opts: { aliases?: boolean; extraRows?: string[][] } = {}): string[][] {
  const header = [...REQUIRED_PRODUCT_COLUMNS, ...(opts.aliases ? ["aliases"] : [])] as string[];
  const rows = NAMES.map((n, i) => {
    const id = `RP-${String(i + 1).padStart(3, "0")}`;
    const r = [
      id, n, String(500 + i * 50), i === 4 ? "out_of_stock" : "in_stock", `${n} description`, "benefit",
      "60", "120", `https://shop.example/${id}`, `https://cdn.example/${id}.jpg`, i === 0 ? "10% off, now 450" : "", "", "TRUE",
    ];
    if (opts.aliases) r.push(i === 0 ? "piyaj tel, পেঁয়াজ তেল" : i === 19 ? "kalojira tel" : "");
    return r;
  });
  return [header, ...rows, ...(opts.extraRows || [])];
}

export const AD_ROWS: string[][] = [
  ["ad_id", "product_id", "platform", "campaign_name", "active", "note"],
  ["AD100", "RP-001", "both", "onion", "TRUE", ""],
  ["AD200", "RP-020", "messenger", "kalojira", "", ""],
  ["AD300", "RP-999", "both", "bad", "TRUE", "unknown product"],
  ["AD400", "RP-003", "whatsapp", "serum", "TRUE", ""],
  ["AD500", "RP-002", "both", "old", "FALSE", "disabled"],
];

export function mockCatalog(over: Partial<Catalog> = {}): Catalog {
  const products = parseProducts(productRows({ aliases: true }));
  const ad = parseAdMapping(AD_ROWS, products);
  return { products, settings: { whatsapp_contact: "01604139500" }, adMap: ad.map, warnings: ad.warnings, loadedAt: Date.now(), stale: false, ...over };
}
