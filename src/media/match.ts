import crypto from "node:crypto";
import type { Product } from "../types/catalog.js";
import type { FetchFn } from "./validate.js";

/**
 * Inbound image matching (customer sends a photo).
 * Approach: exact SHA-256 of image bytes vs. SHA-256 of each product's image_url
 * download (cached in memory). Works when the customer forwards/re-sends our own
 * product photo unchanged. LIMITATION: screenshots, crops, re-compression (WhatsApp/
 * Messenger often recompress) or camera photos will NOT match; we then say we
 * couldn't identify the product and show the real catalog. Never invents products.
 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const hashCache = new Map<string, { hash: string | null; at: number }>();

export function sha256(buf: Uint8Array): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export async function fetchImageBytes(url: string, fetchFn: FetchFn = fetch as FetchFn, headers?: Record<string, string>): Promise<Uint8Array | null> {
  try {
    if (!/^https:\/\//i.test(url)) return null;
    const r = await fetchFn(url, { headers });
    if (!r.ok) return null;
    const ct = r.headers.get("content-type") || "";
    if (ct && !ct.startsWith("image/")) return null;
    const buf = new Uint8Array(await r.arrayBuffer());
    if (!buf.length || buf.length > MAX_IMAGE_BYTES) return null;
    return buf;
  } catch {
    return null;
  }
}

export async function productImageHash(p: Product, fetchFn?: FetchFn): Promise<string | null> {
  if (!p.image_url) return null;
  const c = hashCache.get(p.image_url);
  if (c && Date.now() - c.at < CACHE_TTL_MS) return c.hash;
  const bytes = await fetchImageBytes(p.image_url, fetchFn);
  const hash = bytes ? sha256(bytes) : null;
  hashCache.set(p.image_url, { hash, at: Date.now() });
  return hash;
}

export function clearImageHashCache(): void {
  hashCache.clear();
}

export async function matchImageToProduct(bytes: Uint8Array, products: Product[], fetchFn?: FetchFn): Promise<Product | null> {
  const h = sha256(bytes);
  for (const p of products) {
    if ((await productImageHash(p, fetchFn)) === h) return p;
  }
  return null;
}

export function matchByImageUrl(url: string, products: Product[]): Product | null {
  const norm = (u: string) => u.trim().split("?")[0].toLowerCase();
  return products.find((p) => p.image_url && norm(p.image_url) === norm(url)) || null;
}

export function matchedReplyText(p: Product): string {
  const lines = [
    `ছবির পণ্যটি সম্ভবত: ${p.product_name}`,
    `দাম: ${p.price} টাকা`,
    p.stock_status ? `স্টক: ${p.stock_status}` : "",
    p.offer ? `অফার: ${p.offer}` : "",
    p.product_url ? `লিংক: ${p.product_url}` : "",
    "অর্ডার করতে চাইলে জানান।",
  ];
  return lines.filter(Boolean).join("\n");
}

export function unmatchedReplyText(products: Product[]): string {
  const list = products.slice(0, 8).map((p) => `• ${p.product_name}${p.product_url ? ` — ${p.product_url}` : ""}`);
  return [
    "দুঃখিত, ছবি থেকে পণ্যটি নিশ্চিতভাবে চিনতে পারিনি।",
    list.length ? "আমাদের পণ্যগুলো:\n" + list.join("\n") : "",
    "পণ্যের নাম লিখে জানালে বিস্তারিত দিতে পারব।",
  ].filter(Boolean).join("\n");
}

export type InboundImageResult = { product: Product | null; text: string };

/** Core inbound path shared by Messenger & WhatsApp. */
export async function handleInboundImage(params: {
  bytes: Uint8Array | null;
  sourceUrl?: string;
  products: Product[];
  fetchFn?: FetchFn;
}): Promise<InboundImageResult> {
  let product: Product | null = params.sourceUrl ? matchByImageUrl(params.sourceUrl, params.products) : null;
  if (!product && params.bytes) product = await matchImageToProduct(params.bytes, params.products, params.fetchFn);
  return { product, text: product ? matchedReplyText(product) : unmatchedReplyText(params.products) };
}
