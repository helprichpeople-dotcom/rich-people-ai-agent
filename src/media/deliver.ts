import type { Product } from "../types/catalog.js";
import type { ReplyMedia } from "../ai/grok.js";
import { validateImageUrl, type FetchFn } from "./validate.js";

export type DeliveryResult = { product_id: string; status: "sent" | "skipped" | "failed"; reason?: string };

export const MAX_MEDIA_PER_REPLY = 3;
export const MEDIA_DEDUPE_MS = 10 * 60 * 1000;

/** recipientKey|product_id -> reserved-at ms. Reserved synchronously so concurrent deliveries dedupe. */
const recentSends = new Map<string, number>();
export function clearRecentMediaSends(): void { recentSends.clear(); }
function reserve(key: string, now: number): boolean {
  const at = recentSends.get(key);
  if (at !== undefined && now - at < MEDIA_DEDUPE_MS) return false;
  recentSends.set(key, now);
  if (recentSends.size > 10000) for (const [k, v] of recentSends) if (now - v >= MEDIA_DEDUPE_MS) recentSends.delete(k);
  return true;
}

/**
 * Sends product images requested by the AI. Gated by `enabled` (MEDIA_SEND_ENABLED).
 * Never throws: failures are logged and returned so the text reply is unaffected.
 */
export async function deliverProductMedia(params: {
  media: ReplyMedia[];
  products: Product[];
  enabled: boolean;
  sendImage: (imageUrl: string, caption: string) => Promise<void>;
  fetchFn?: FetchFn;
  /** e.g. "messenger:<psid>". When set, a product image goes to that recipient at most once per MEDIA_DEDUPE_MS, across calls/requests. */
  recipientKey?: string;
  now?: () => number;
}): Promise<DeliveryResult[]> {
  const out: DeliveryResult[] = [];
  const seen = new Set<string>();
  for (const m of params.media) {
    if (seen.has(m.product_id)) continue;
    seen.add(m.product_id);
    if (!params.enabled) {
      out.push({ product_id: m.product_id, status: "skipped", reason: "media_send_disabled" });
      continue;
    }
    if (out.filter((r) => r.status === "sent").length >= MAX_MEDIA_PER_REPLY) {
      out.push({ product_id: m.product_id, status: "skipped", reason: "limit" });
      continue;
    }
    const p = params.products.find((x) => x.product_id === m.product_id);
    if (!p || !p.image_url) {
      out.push({ product_id: m.product_id, status: "skipped", reason: p ? "no_image" : "unknown_product" });
      continue;
    }
    const dkey = params.recipientKey ? `${params.recipientKey}|${p.product_id}` : null;
    if (dkey && !reserve(dkey, (params.now || Date.now)())) {
      console.log(`[media] dedupe skip ${dkey}`);
      out.push({ product_id: m.product_id, status: "skipped", reason: "duplicate_recent" });
      continue;
    }
    const v = await validateImageUrl(p.image_url, { fetchFn: params.fetchFn });
    if (!v.ok) {
      console.warn(`[media] invalid image for ${p.product_id}: ${v.reason}`);
      if (dkey) recentSends.delete(dkey);
      out.push({ product_id: m.product_id, status: "skipped", reason: v.reason });
      continue;
    }
    try {
      await params.sendImage(v.url, p.product_name);
      out.push({ product_id: m.product_id, status: "sent" });
    } catch (err) {
      console.error(`[media] send failed for ${p.product_id}:`, err);
      if (dkey) recentSends.delete(dkey);
      out.push({ product_id: m.product_id, status: "failed", reason: err instanceof Error ? err.message : "error" });
    }
  }
  return out;
}
