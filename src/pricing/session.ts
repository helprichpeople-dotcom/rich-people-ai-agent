// Per-conversation negotiation state (in-memory, inside ConvState) + glue to engine/logs/approval.
import { getState, setState } from "../memory.js";
import type { Product } from "../types/catalog.js";
import { getPricingConfig, type PricingConfig } from "./config.js";
import { evaluateOffer, newNegotiation, priceForOrder, type NegotiationState, type OfferResult } from "./engine.js";
import { logNegotiation } from "./logs.js";
import { phrase } from "./phrases.js";
import { appendSheetRow } from "../sheets/client.js";

export type NegMap = Record<string, NegotiationState>;
export const getNegotiations = (key: string): NegMap => (getState(key).negotiation as NegMap) || {};
const saveNeg = (key: string, m: NegMap) => setState(key, { negotiation: m });

type ApprovalFn = (p: { channel: string; customer_id: string; product_id: string; offer: number | null; floor: number }) => Promise<void>;
/** Default: record a price-approval request in Support sheet (bot is NOT paused). */
const defaultApproval: ApprovalFn = async (p) => {
  const stamp = new Date(Date.now() + 6 * 3600_000).toISOString().slice(0, 19).replace("T", " ");
  console.log(`[negotiation] approval requested ${p.channel}:${p.customer_id} product=${p.product_id} offer=${p.offer ?? "-"} floor=${p.floor}`);
  try {
    await appendSheetRow("Support!A1", [stamp, p.channel, p.customer_id, `price_approval product=${p.product_id} offer=${p.offer ?? "-"} floor=${p.floor}`, "open"]);
  } catch {
    console.log("[negotiation] Support sheet not found; approval request logged only.");
  }
};
let approvalFn: ApprovalFn = defaultApproval;
export function setApprovalRequester(f: ApprovalFn | null): void { approvalFn = f || defaultApproval; }

/** Reset in-progress (not agreed) negotiations of other products when the active product changes. */
export function onProductSwitch(key: string, newProductId: string): void {
  const m = getNegotiations(key);
  let changed = false;
  for (const [pid, s] of Object.entries(m)) {
    if (pid !== newProductId && s.negotiation_status !== "accepted" && s.negotiation_status !== "approved") {
      delete m[pid];
      changed = true;
    }
  }
  if (changed) saveNeg(key, { ...m });
}

export type EvaluateToolResult = {
  ok: boolean;
  product_id: string;
  decision: OfferResult["decision"] | "config_error";
  price_to_quote: number;
  is_final: boolean;
  delivery_inside_dhaka: number;
  delivery_outside_dhaka: number;
  phrasing_hint: string;
  note: string;
};

export function evaluateForConversation(params: {
  key: string; product: Product; customerOffer: number | null; catalogStale: boolean; turnId: string;
}): EvaluateToolResult {
  const { key, product } = params;
  const base = { product_id: product.product_id, delivery_inside_dhaka: product.delivery_inside_dhaka, delivery_outside_dhaka: product.delivery_outside_dhaka };
  const pc = getPricingConfig(product);
  if (!pc.ok) {
    logNegotiation({ conversation: key, product_id: product.product_id, regular: pc.regular, offer: params.customerOffer, counter: null, final: null, status: "config_error", human_needed: false });
    return { ok: true, ...base, decision: "config_error", price_to_quote: pc.regular, is_final: true,
      phrasing_hint: phrase("no_negotiation", { price: pc.regular, inside: product.delivery_inside_dhaka, outside: product.delivery_outside_dhaka }),
      note: "Pricing config inconsistent: quote regular price only, no discount." };
  }
  const cfg = pc.cfg;
  const m = getNegotiations(key);
  let st = m[product.product_id];
  if (!st || st.regular_price !== cfg.regular) st = newNegotiation(cfg);
  const prevStatus = st.negotiation_status;
  const { result, state } = evaluateOffer({ cfg, state: st, customerOffer: params.customerOffer, catalogStale: params.catalogStale, turnId: params.turnId });
  saveNeg(key, { ...getNegotiations(key), [product.product_id]: state });
  const fresh = st.last_turn_id !== params.turnId;
  if (fresh) {
    logNegotiation({ conversation: key, product_id: product.product_id, regular: cfg.regular, offer: params.customerOffer, counter: result.decision === "counter" || result.decision === "final" ? result.price : null, final: result.decision === "accept" ? result.price : null, status: result.status, human_needed: result.human_needed });
    if (result.human_needed && prevStatus !== "pending_approval") {
      const [channel, ...rest] = key.split(":");
      void approvalFn({ channel, customer_id: rest.join(":"), product_id: product.product_id, offer: params.customerOffer, floor: cfg.floor }).catch(() => undefined);
    }
  }
  return {
    ok: true, ...base, decision: result.decision, price_to_quote: result.price, is_final: result.is_final,
    phrasing_hint: phrase(result.decision, { price: result.price, inside: product.delivery_inside_dhaka, outside: product.delivery_outside_dhaka }),
    note: result.decision === "accept"
      ? "Agreed unit price. Delivery charge is separate (once per order). Use this exact price in the order summary."
      : "Quote exactly price_to_quote. Never mention any other lower price.",
  };
}

/** Prices the model may legitimately mention this turn (engine-quoted/agreed for this conversation). */
export function allowedNegotiatedPrices(key: string): number[] {
  return Object.values(getNegotiations(key)).flatMap((s) => [s.last_quoted_price, s.last_counter_offer ?? 0, s.approved_final_price ?? 0]).filter((n) => n > 0);
}

/** Unit price for ordering: valid agreed price, else Sheet regular. */
export function orderUnitPrice(key: string, product: Product, now = Date.now()): { unit_price: number; negotiated: boolean } {
  const pc = getPricingConfig(product);
  const cfg: PricingConfig | null = pc.ok ? pc.cfg : null;
  const regular = pc.ok ? pc.cfg.regular : pc.regular;
  return priceForOrder(cfg, getNegotiations(key)[product.product_id], regular, now);
}

/** Manager approval (admin): price must be within [min, max]. */
export function approveNegotiatedPrice(key: string, product: Product, price: number, now = Date.now()): { ok: boolean; error?: string } {
  const pc = getPricingConfig(product);
  if (!pc.ok) return { ok: false, error: `config: ${pc.reason}` };
  const cfg = pc.cfg;
  if (!(price >= cfg.min && price <= cfg.max)) return { ok: false, error: `price must be within ${cfg.min}-${cfg.max}` };
  const m = getNegotiations(key);
  const st = m[product.product_id] || newNegotiation(cfg);
  saveNeg(key, { ...m, [product.product_id]: { ...st, negotiation_status: "approved", approved_final_price: price, approved_at: now, last_counter_offer: price, last_quoted_price: price, last_result: undefined, last_turn_id: undefined } });
  logNegotiation({ conversation: key, product_id: product.product_id, regular: cfg.regular, offer: st.customer_offer, counter: null, final: price, status: "approved", human_needed: false });
  return { ok: true };
}
