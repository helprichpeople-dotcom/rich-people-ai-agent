import { readSheetValues } from "./client.js";
import type { Product } from "../types/catalog.js";

function toBool(v: string): boolean {
  return String(v).trim().toUpperCase() === "TRUE";
}

function toNum(v: string): number {
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

export async function loadProducts(): Promise<Product[]> {
  const rows = await readSheetValues("Products!A:M");
  if (rows.length < 2) return [];
  const header = rows[0].map((h) => h.trim());
  const idx = (name: string) => header.indexOf(name);

  const needed = [
    "product_id",
    "product_name",
    "price",
    "stock_status",
    "description",
    "benefits",
    "delivery_inside_dhaka",
    "delivery_outside_dhaka",
    "product_url",
    "image_url",
    "offer",
    "faq",
    "active",
  ];
  for (const col of needed) {
    if (idx(col) < 0) {
      throw new Error(`Products শিটে কলাম নেই: ${col}`);
    }
  }

  return rows.slice(1).map((row) => ({
    product_id: row[idx("product_id")] || "",
    product_name: row[idx("product_name")] || "",
    price: toNum(row[idx("price")]),
    stock_status: row[idx("stock_status")] || "",
    description: row[idx("description")] || "",
    benefits: row[idx("benefits")] || "",
    delivery_inside_dhaka: toNum(row[idx("delivery_inside_dhaka")]),
    delivery_outside_dhaka: toNum(row[idx("delivery_outside_dhaka")]),
    product_url: row[idx("product_url")] || "",
    image_url: row[idx("image_url")] || "",
    offer: row[idx("offer")] || "",
    faq: row[idx("faq")] || "",
    active: toBool(row[idx("active")]),
  })).filter((p) => p.product_id && p.active);
}

export function findProducts(products: Product[], query: string): Product[] {
  const q = query.trim().toLowerCase();
  if (!q) return products;
  return products.filter((p) => {
    const hay = [
      p.product_id,
      p.product_name,
      p.description,
      p.benefits,
      p.offer,
      p.faq,
    ]
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });
}
