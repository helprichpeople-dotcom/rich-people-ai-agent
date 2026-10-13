import type { Product } from "../types/catalog.js";

export const NEGOTIATION_MODES = ["fixed", "step", "split"] as const;
export type NegotiationMode = (typeof NEGOTIATION_MODES)[number];

export type PricingConfig = {
  product_id: string;
  regular: number;
  min: number;
  max: number;
  /** Effective lowest price: max(min, regular - max_discount). */
  floor: number;
  step: number;
  mode: NegotiationMode;
  enabled: boolean;
  notes: string;
};

export type ConfigResult = { ok: true; cfg: PricingConfig } | { ok: false; reason: string; regular: number };

const num = (s: string | undefined): number | null => {
  const t = String(s ?? "").replace(/,/g, "").trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
};

/**
 * Validates negotiation config. Never guesses: any inconsistency -> ok:false (regular price only).
 * All negotiation columns blank -> disabled (ok:true, enabled:false).
 */
export function getPricingConfig(p: Product): ConfigResult {
  const pr = p.pricing;
  const regular = num(pr?.regular_price) ?? p.price;
  const base = { product_id: p.product_id, regular, notes: pr?.pricing_notes || "" };
  const enabledRaw = String(pr?.negotiation_enabled || "").trim().toUpperCase();
  if (!(regular > 0)) return { ok: false, reason: "regular_price invalid", regular: p.price };
  if (enabledRaw !== "TRUE") {
    return { ok: true, cfg: { ...base, min: regular, max: regular, floor: regular, step: 0, mode: "fixed", enabled: false } };
  }
  const min = num(pr?.min_sale_price);
  const max = num(pr?.max_sale_price) ?? regular;
  const maxDisc = num(pr?.max_discount_amount);
  const step = num(pr?.price_step);
  const mode = String(pr?.negotiation_mode || "").trim().toLowerCase() as NegotiationMode;
  const fail = (reason: string): ConfigResult => ({ ok: false, reason, regular });
  if (min === null || Number.isNaN(min) || min <= 0) return fail("min_sale_price missing/invalid");
  if (Number.isNaN(max) || max <= 0) return fail("max_sale_price invalid");
  if (!(min <= regular && regular <= max)) return fail(`need min<=regular<=max (got ${min}/${regular}/${max})`);
  if (maxDisc !== null && (Number.isNaN(maxDisc) || maxDisc < 0)) return fail("max_discount_amount invalid");
  if (!NEGOTIATION_MODES.includes(mode)) return fail(`negotiation_mode "${mode}" unknown`);
  if (mode === "step" && (step === null || Number.isNaN(step) || step <= 0)) return fail("price_step must be > 0 for step mode");
  if (step !== null && (Number.isNaN(step) || step < 0)) return fail("price_step invalid");
  const floor = Math.max(min, maxDisc === null ? min : regular - maxDisc);
  return { ok: true, cfg: { ...base, min, max, floor, step: step || 0, mode, enabled: mode !== "fixed" && floor < regular } };
}
