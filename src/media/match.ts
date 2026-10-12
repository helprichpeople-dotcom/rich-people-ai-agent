import crypto from "node:crypto";
import type { Product } from "../types/catalog.js";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";
import { normalizeImageUrl, validateImageUrl, type FetchFn } from "./validate.js";

/**
 * Inbound image matching (customer sends a photo).
 * Tiered: SHA-256 -> dimensions+filesize -> 8x8 average-hash similarity (survives
 * recompression/resizing by Messenger/WhatsApp) -> optional Grok vision. When nothing
 * matches we say so and show the real catalog. Never invents products.
 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
export const AHASH_THRESHOLD = 0.85;

export type ImageInfo = { sha: string; size: number; width: number; height: number; ahash: bigint | null };
const infoCache = new Map<string, { info: ImageInfo | null; at: number }>();

export function sha256(buf: Uint8Array): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export async function fetchImageBytes(url: string, fetchFn: FetchFn = fetch as FetchFn, headers?: Record<string, string>): Promise<Uint8Array | null> {
  try {
    if (!/^https:\/\//i.test(url)) return null;
    const r = await fetchFn(url, { headers });
    if (!r.ok) return null;
    const ct = r.headers.get("content-type") || "";
    if (ct && !ct.startsWith("image/") && !ct.startsWith("application/octet-stream")) return null;
    const buf = new Uint8Array(await r.arrayBuffer());
    if (!buf.length || buf.length > MAX_IMAGE_BYTES) return null;
    return buf;
  } catch {
    return null;
  }
}

type Rgba = { width: number; height: number; data: Uint8Array };

/** Pure-JS decode (jpeg-js / pngjs). Returns null for unsupported formats (e.g. webp). */
export function decodeImage(buf: Uint8Array): Rgba | null {
  try {
    const b = Buffer.from(buf);
    if (b[0] === 0xff && b[1] === 0xd8) {
      const img = jpeg.decode(b, { useTArray: true, maxMemoryUsageInMB: 256, formatAsRGBA: true });
      return { width: img.width, height: img.height, data: img.data as Uint8Array };
    }
    if (b[0] === 0x89 && b[1] === 0x50) {
      const img = PNG.sync.read(b);
      return { width: img.width, height: img.height, data: img.data };
    }
  } catch {
    /* fallthrough */
  }
  return null;
}

/** 8x8 average hash (64-bit) over grayscale box-sampled image. */
export function averageHash(img: Rgba): bigint {
  const N = 8;
  const vals: number[] = [];
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const x0 = Math.floor((x * img.width) / N), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * img.width) / N));
      const y0 = Math.floor((y * img.height) / N), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * img.height) / N));
      const stepX = Math.max(1, Math.floor((x1 - x0) / 16)), stepY = Math.max(1, Math.floor((y1 - y0) / 16));
      let sum = 0, n = 0;
      for (let yy = y0; yy < y1; yy += stepY) {
        for (let xx = x0; xx < x1; xx += stepX) {
          const i = (yy * img.width + xx) * 4;
          sum += 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
          n++;
        }
      }
      vals.push(n ? sum / n : 0);
    }
  }
  const mean = vals.reduce((a, v) => a + v, 0) / vals.length;
  let h = 0n;
  for (const v of vals) h = (h << 1n) | (v >= mean ? 1n : 0n);
  return h;
}

export function hashSimilarity(a: bigint, b: bigint): number {
  let x = a ^ b, d = 0;
  while (x) { d += Number(x & 1n); x >>= 1n; }
  return 1 - d / 64;
}

export function imageInfo(bytes: Uint8Array): ImageInfo {
  const img = decodeImage(bytes);
  return { sha: sha256(bytes), size: bytes.length, width: img?.width || 0, height: img?.height || 0, ahash: img ? averageHash(img) : null };
}

export async function productImageInfo(p: Product, fetchFn?: FetchFn): Promise<ImageInfo | null> {
  if (!p.image_url) return null;
  const c = infoCache.get(p.image_url);
  if (c && Date.now() - c.at < CACHE_TTL_MS) return c.info;
  let url = normalizeImageUrl(p.image_url);
  const v = await validateImageUrl(p.image_url, { fetchFn });
  if (v.ok) url = v.url;
  const bytes = await fetchImageBytes(url, fetchFn);
  const info = bytes ? imageInfo(bytes) : null;
  infoCache.set(p.image_url, { info, at: Date.now() });
  return info;
}

/** Back-compat helper. */
export async function productImageHash(p: Product, fetchFn?: FetchFn): Promise<string | null> {
  return (await productImageInfo(p, fetchFn))?.sha ?? null;
}

export function clearImageHashCache(): void {
  infoCache.clear();
}

export type MatchMethod = "url" | "sha256" | "dims_size" | "ahash" | "vision";
export type VisionMatcher = (bytes: Uint8Array, products: Product[]) => Promise<string | null>;

/**
 * Tiered match: SHA-256 exact -> same dimensions + filesize (±2%) -> aHash similarity
 * (>= AHASH_THRESHOLD, unique best) -> optional vision model. Never invents products.
 */
export async function matchImageDetailed(
  bytes: Uint8Array,
  products: Product[],
  opts: { fetchFn?: FetchFn; vision?: VisionMatcher | null } = {}
): Promise<{ product: Product | null; method?: MatchMethod; score?: number }> {
  const cust = imageInfo(bytes);
  const infos: Array<{ p: Product; i: ImageInfo }> = [];
  for (const p of products) {
    const i = await productImageInfo(p, opts.fetchFn);
    if (i) infos.push({ p, i });
  }
  const exact = infos.find((x) => x.i.sha === cust.sha);
  if (exact) return { product: exact.p, method: "sha256", score: 1 };
  if (cust.width) {
    const dims = infos.filter((x) => x.i.width === cust.width && x.i.height === cust.height && Math.abs(x.i.size - cust.size) <= cust.size * 0.02);
    if (dims.length === 1) return { product: dims[0].p, method: "dims_size", score: 0.99 };
  }
  if (cust.ahash !== null) {
    const scored = infos
      .filter((x) => x.i.ahash !== null)
      .map((x) => ({ p: x.p, s: hashSimilarity(cust.ahash!, x.i.ahash!) }))
      .sort((a, b) => b.s - a.s);
    if (scored[0] && scored[0].s >= AHASH_THRESHOLD && (!scored[1] || scored[0].s - scored[1].s >= 0.03)) {
      return { product: scored[0].p, method: "ahash", score: scored[0].s };
    }
  }
  if (opts.vision) {
    try {
      const id = await opts.vision(bytes, products);
      const p = id ? products.find((x) => x.product_id === id) : undefined;
      if (p) return { product: p, method: "vision" };
    } catch (err) {
      console.warn("[image-in] vision match failed:", err instanceof Error ? err.message : err);
    }
  }
  return { product: null };
}

export async function matchImageToProduct(bytes: Uint8Array, products: Product[], fetchFn?: FetchFn): Promise<Product | null> {
  return (await matchImageDetailed(bytes, products, { fetchFn })).product;
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

export type InboundImageResult = { product: Product | null; text: string; method?: MatchMethod; score?: number };

/** Core inbound path shared by Messenger & WhatsApp. */
export async function handleInboundImage(params: {
  bytes: Uint8Array | null;
  sourceUrl?: string;
  products: Product[];
  fetchFn?: FetchFn;
  vision?: VisionMatcher | null;
}): Promise<InboundImageResult> {
  const urlHit = params.sourceUrl ? matchByImageUrl(params.sourceUrl, params.products) : null;
  if (urlHit) return { product: urlHit, method: "url", score: 1, text: matchedReplyText(urlHit) };
  if (params.bytes) {
    const m = await matchImageDetailed(params.bytes, params.products, { fetchFn: params.fetchFn, vision: params.vision });
    if (m.product) return { product: m.product, method: m.method, score: m.score, text: matchedReplyText(m.product) };
  }
  return { product: null, text: unmatchedReplyText(params.products) };
}
