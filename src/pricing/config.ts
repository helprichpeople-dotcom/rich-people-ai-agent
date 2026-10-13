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
 * Validates negotiation config. Only min_sale_price + max_sale_price are required.
 * - min or max blank -> negotiation off (Sheet `price` only).
 * - negotiation_enabled blank = TRUE; explicit FALSE disables.
 * - start (regular) = regular_price if given (must be within [min,max]) else max_sale_price.
 * - mode: explicit, else price_step valid -> "step", price_step blank -> "split".
 * Any inconsistency -> ok:false (regular price only, warning). Never guesses.
 */
export function getPricingConfig(p: Product): ConfigResult {
  const pr = p.pricing;
  const min = num(pr?.min_sale_price);
  const max = num(pr?.max_sale_price);
  const regRaw = num(pr?.regular_price);
  const notes = pr?.pricing_notes || "";
  const off = (regular: number): ConfigResult => ({ ok: true, cfg: { product_id: p.product_id, regular, notes, min: regular, max: regular, floor: regular, step: 0, mode: "fixed", enabled: false } });
  const fallbackRegular = regRaw !== null && regRaw > 0 ? regRaw : p.price;
  if (!(fallbackRegular > 0)) return { ok: false, reason: "price invalid", regular: p.price };
  if (min === null || max === null) return off(p.price);
  const fail = (reason: string, regular = fallbackRegular): ConfigResult => ({ ok: false, reason, regular });
  if (Number.isNaN(min) || min <= 0) return fail("min_sale_price invalid");
  if (Number.isNaN(max) || max <= 0) return fail("max_sale_price invalid");
  if (min > max) return fail(`min_sale_price > max_sale_price (${min} > ${max})`);
  if (regRaw !== null && (Number.isNaN(regRaw) || regRaw < min || regRaw > max)) return fail(`regular_price must be within [${min},${max}]`, p.price);
  const regular = regRaw !== null ? regRaw : max;
  if (String(pr?.negotiation_enabled || "").trim().toUpperCase() === "FALSE") return off(regular);
  const maxDisc = num(pr?.max_discount_amount);
  const step = num(pr?.price_step);
  if (maxDisc !== null && (Number.isNaN(maxDisc) || maxDisc < 0)) return fail("max_discount_amount invalid", regular);
  if (step !== null && (Number.isNaN(step) || step <= 0)) return fail("price_step blank/invalid (must be > 0)", regular);
  const modeRaw = String(pr?.negotiation_mode || "").trim().toLowerCase();
  const mode = (modeRaw || (step !== null ? "step" : "split")) as NegotiationMode;
  if (!NEGOTIATION_MODES.includes(mode)) return fail(`negotiation_mode "${modeRaw}" unknown`, regular);
  if (mode === "step" && step === null) return fail("price_step blank/invalid (must be > 0) for step mode", regular);
  const floor = Math.max(min, maxDisc === null ? min : regular - maxDisc);
  return { ok: true, cfg: { product_id: p.product_id, regular, notes, min, max, floor, step: step || 0, mode, enabled: mode !== "fixed" && floor < regular } };
}
