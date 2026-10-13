// Deterministic negotiation engine. Pure: no AI, no I/O. The model can only phrase its output.
import type { PricingConfig } from "./config.js";

export type NegotiationStatus =
  | "none" | "countered" | "final_offered" | "accepted" | "no_negotiation"
  | "no_discount_stale" | "config_error" | "pending_approval" | "approved";

export type NegotiationState = {
  product_id: string;
  regular_price: number;
  last_quoted_price: number;
  customer_offer: number | null;
  last_counter_offer: number | null;
  negotiation_round: number;
  negotiation_status: NegotiationStatus;
  approved_final_price: number | null;
  approved_at: number | null;
  last_turn_id?: string;
  last_result?: OfferResult;
};

export type Decision = "accept" | "counter" | "final" | "no_negotiation" | "quote" | "needs_approval";

export type OfferResult = {
  decision: Decision;
  price: number;
  is_final: boolean;
  status: NegotiationStatus;
  human_needed: boolean;
  round: number;
  reason: string;
};

export const MAX_ROUNDS = Number(process.env.NEGOTIATION_MAX_ROUNDS || 3);
export const APPROVAL_TTL_MS = 30 * 60 * 1000;

export function newNegotiation(cfg: PricingConfig): NegotiationState {
  return {
    product_id: cfg.product_id, regular_price: cfg.regular, last_quoted_price: cfg.regular,
    customer_offer: null, last_counter_offer: null, negotiation_round: 0,
    negotiation_status: "none", approved_final_price: null, approved_at: null,
  };
}

/** Round UP to whole taka (seller-favourable), clamp into [floor, regular]. */
function clamp(n: number, cfg: PricingConfig): number {
  const r = Math.ceil(n);
  return Math.min(cfg.regular, Math.max(cfg.floor, r));
}

function guard(price: number, cfg: PricingConfig, approved = false): number {
  const low = approved ? cfg.min : cfg.floor;
  if (!(Number.isFinite(price) && price >= cfg.min && price >= low && price <= cfg.max)) {
    console.error(`[pricing] guard tripped for ${cfg.product_id}: ${price} outside [${cfg.floor},${cfg.max}] -> regular`);
    return cfg.regular;
  }
  return price;
}

/**
 * Evaluate a customer offer (null = "discount hobe?" without a number).
 * Maximizes price: starts at regular, small steps, accepts only if offer >= current counter,
 * or (final round) offer >= floor. Never below floor/min, never above max. Counters never go up.
 */
export function evaluateOffer(params: {
  cfg: PricingConfig;
  state: NegotiationState;
  customerOffer: number | null;
  catalogStale?: boolean;
  turnId?: string;
  maxRounds?: number;
}): { result: OfferResult; state: NegotiationState } {
  const { cfg } = params;
  const customerOffer = params.customerOffer !== null && params.customerOffer > 0 ? params.customerOffer : null;
  const maxRounds = params.maxRounds ?? MAX_ROUNDS;
  let s = { ...params.state };
  if (params.turnId && s.last_turn_id === params.turnId && s.last_result) return { result: s.last_result, state: s };

  const done = (r: Omit<OfferResult, "price"> & { price: number }) => {
    const price = guard(r.price, cfg, r.status === "approved");
    const result = { ...r, price };
    s = { ...s, last_quoted_price: price, last_turn_id: params.turnId, last_result: result };
    return { result, state: s };
  };
  const current = s.last_counter_offer ?? cfg.regular;

  // Already approved/accepted price stays (still clamped by guard).
  if ((s.negotiation_status === "accepted" || s.negotiation_status === "approved") && s.approved_final_price) {
    return done({ decision: "accept", price: s.approved_final_price, is_final: true, status: s.negotiation_status, human_needed: false, round: s.negotiation_round, reason: "already agreed" });
  }
  if (!cfg.enabled) {
    return done({ decision: "no_negotiation", price: cfg.regular, is_final: true, status: "no_negotiation", human_needed: false, round: s.negotiation_round, reason: "negotiation disabled" });
  }
  if (params.catalogStale) {
    return done({ decision: "no_negotiation", price: current, is_final: true, status: "no_discount_stale", human_needed: false, round: s.negotiation_round, reason: "price data stale; no new discounts" });
  }

  // Offer at/above what we are currently asking -> accept at our current ask (never more than quoted, never less).
  if (customerOffer !== null && customerOffer >= current) {
    s = { ...s, customer_offer: customerOffer, negotiation_status: "accepted", approved_final_price: current, approved_at: Date.now() };
    return done({ decision: "accept", price: current, is_final: true, status: "accepted", human_needed: false, round: s.negotiation_round, reason: "offer >= current price" });
  }

  // Already gave final price: hold it; repeated push below floor -> manager approval path.
  if (s.negotiation_status === "final_offered" || s.negotiation_status === "pending_approval") {
    const human = customerOffer !== null && customerOffer < cfg.floor;
    s = { ...s, customer_offer: customerOffer ?? s.customer_offer, negotiation_status: human ? "pending_approval" : "final_offered" };
    return done({ decision: human ? "needs_approval" : "final", price: current, is_final: true, status: s.negotiation_status, human_needed: human, round: s.negotiation_round, reason: human ? "below floor after final; manager can review" : "final price already given" });
  }

  const round = s.negotiation_round + 1;
  const isFinal = round >= maxRounds;
  s = { ...s, negotiation_round: round, customer_offer: customerOffer ?? s.customer_offer };

  // Final round: accept any offer >= floor; otherwise give floor as final.
  if (isFinal) {
    if (customerOffer !== null && customerOffer >= cfg.floor) {
      const p = Math.min(current, Math.max(cfg.floor, Math.ceil(customerOffer)));
      s = { ...s, last_counter_offer: p, negotiation_status: "accepted", approved_final_price: p, approved_at: Date.now() };
      return done({ decision: "accept", price: p, is_final: true, status: "accepted", human_needed: false, round, reason: "final round, offer >= floor" });
    }
    const finalPrice = Math.min(current, nextCounter(cfg, current, customerOffer, true));
    s = { ...s, last_counter_offer: finalPrice, negotiation_status: "final_offered" };
    return done({ decision: "final", price: finalPrice, is_final: true, status: "final_offered", human_needed: false, round, reason: "final round" });
  }

  const counter = Math.min(current, nextCounter(cfg, current, customerOffer, false));
  // Counter met the customer's own offer -> that is an accept at the offer (rounded up).
  if (customerOffer !== null && counter <= Math.ceil(customerOffer)) {
    const p = Math.max(cfg.floor, Math.min(current, Math.ceil(customerOffer)));
    s = { ...s, last_counter_offer: p, negotiation_status: "accepted", approved_final_price: p, approved_at: Date.now() };
    return done({ decision: "accept", price: p, is_final: true, status: "accepted", human_needed: false, round, reason: "next step reaches offer" });
  }
  const atFloor = counter <= cfg.floor;
  s = { ...s, last_counter_offer: counter, negotiation_status: atFloor ? "final_offered" : "countered" };
  return done({ decision: atFloor ? "final" : "counter", price: counter, is_final: atFloor, status: s.negotiation_status, human_needed: false, round, reason: atFloor ? "reached floor" : "counter" });
}

function nextCounter(cfg: PricingConfig, current: number, offer: number | null, finalRound: boolean): number {
  // Step size comes ONLY from the Sheet's price_step (no hardcoded default).
  if (cfg.mode === "step") return clamp(current - cfg.step, cfg);
  // split: final round = floor; with offer = ceil midpoint(offer>=floor, last); no number = drop 1/3 of gap to floor.
  if (finalRound) return cfg.floor;
  if (offer !== null) return clamp(current - Math.max(1, (current - Math.max(offer, cfg.floor)) / 2), cfg);
  return clamp(current - (current - cfg.floor) / 3, cfg);
}

/** Validate a stored agreed price for ordering. Returns price to charge (agreed if still valid, else regular). */
export function priceForOrder(cfg: PricingConfig | null, s: NegotiationState | undefined, regular: number, now = Date.now()): { unit_price: number; negotiated: boolean } {
  if (!cfg || !s || !s.approved_final_price || !s.approved_at) return { unit_price: regular, negotiated: false };
  if (s.negotiation_status !== "accepted" && s.negotiation_status !== "approved") return { unit_price: regular, negotiated: false };
  if (now - s.approved_at > APPROVAL_TTL_MS) return { unit_price: regular, negotiated: false };
  if (s.regular_price !== cfg.regular) return { unit_price: regular, negotiated: false };
  const p = s.approved_final_price;
  if (!(p >= cfg.min && p <= cfg.max)) return { unit_price: regular, negotiated: false };
  if (s.negotiation_status === "accepted" && p < cfg.floor) return { unit_price: regular, negotiated: false };
  return { unit_price: p, negotiated: p !== regular };
}
