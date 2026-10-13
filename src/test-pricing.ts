// Smart Negotiation — mock only. Every price asserted within [min, max] and never below min.
import assert from "node:assert/strict";
import { getPricingConfig, type PricingConfig } from "./pricing/config.js";
import { evaluateOffer, newNegotiation, priceForOrder, type NegotiationState, type OfferResult } from "./pricing/engine.js";
import { parseOffer } from "./pricing/parseOffer.js";
import type { Product } from "./types/catalog.js";

let pass = 0, fail = 0;
export async function t(name: string, fn: () => unknown) {
  try { await fn(); pass++; console.log(`✓ ${name}`); } catch (e) { fail++; console.log(`✗ ${name}\n  ${e instanceof Error ? e.stack?.split("\n").slice(0, 3).join(" ") : e}`); }
}
const MIN = 1300, MAX = 1450;
export function rp001(over: Partial<NonNullable<Product["pricing"]>> = {}): Product {
  return {
    product_id: "RP-001", product_name: "Islamic LED Wall Clock", price: 1450, stock_status: "in_stock", description: "", benefits: "",
    delivery_inside_dhaka: 80, delivery_outside_dhaka: 150, product_url: "", image_url: "", offer: "", faq: "", active: true, aliases: [],
    pricing: { regular_price: "1450", min_sale_price: "1300", max_sale_price: "1450", negotiation_enabled: "TRUE", negotiation_mode: "step", max_discount_amount: "150", price_step: "50", pricing_notes: "Always try to sell as high as possible", ...over },
  };
}
const cfgOf = (p: Product) => { const r = getPricingConfig(p); assert.ok(r.ok, (r as any).reason); return (r as any).cfg as PricingConfig; };
const inRange = (r: OfferResult, min = MIN, max = MAX) => assert.ok(r.price >= min && r.price <= max, `price ${r.price} outside [${min},${max}]`);
function run(cfg: PricingConfig, offers: (number | null)[], opts: { stale?: boolean } = {}) {
  let st: NegotiationState = newNegotiation(cfg); const out: OfferResult[] = [];
  offers.forEach((o, i) => { const r = evaluateOffer({ cfg, state: st, customerOffer: o, catalogStale: opts.stale, turnId: `t${i}` }); st = r.state; out.push(r.result); inRange(r.result, cfg.min, cfg.max); });
  return { out, st };
}
const cfg = cfgOf(rp001());

await t("config RP-001 valid: floor 1300, step 50, mode step", () => {
  assert.equal(cfg.floor, 1300); assert.equal(cfg.step, 50); assert.equal(cfg.mode, "step"); assert.ok(cfg.enabled);
});
await t("1 accept regular: offer 1450 -> accept 1450, no discount", () => {
  const { out } = run(cfg, [1450]); assert.equal(out[0].decision, "accept"); assert.equal(out[0].price, 1450);
});
await t("2 lowball 500 -> counter 1400 (small step from top), not accepted", () => {
  const { out } = run(cfg, [500]); assert.equal(out[0].decision, "counter"); assert.equal(out[0].price, 1400);
});
await t("3 multi-round: counters strictly non-increasing, stop at 1300 final", () => {
  const { out } = run(cfg, [1000, 1000, 1000, 1000]);
  assert.deepEqual(out.map((r) => r.price), [1400, 1350, 1300, 1300]);
  assert.ok(out[2].is_final); assert.equal(out[3].decision, "needs_approval"); assert.ok(out[3].human_needed);
});
await t("3b offer between steps accepted at offer (maximize): 1380 -> 1400 then accept 1380", () => {
  const { out } = run(cfg, [1380, 1380]); assert.deepEqual(out.map((r) => [r.decision, r.price]), [["counter", 1400], ["accept", 1380]]);
});
await t("3c generic 'kom hobe?' (no number) steps 1400, 1350, final 1300", () => {
  const { out } = run(cfg, [null, null, null]); assert.deepEqual(out.map((r) => r.price), [1400, 1350, 1300]);
});
await t("4 offer = min (1300): countered first, accepted at final round, never below", () => {
  const { out, st } = run(cfg, [1300, 1300, 1300]);
  assert.deepEqual(out.map((r) => r.decision), ["counter", "counter", "accept"]);
  assert.equal(out[2].price, 1300); assert.equal(st.approved_final_price, 1300);
});
await t("5 push below min (1250/1200/1100/900) never below 1300", () => {
  const { out } = run(cfg, [1250, 1200, 1100, 900, 1299]);
  assert.ok(out.every((r) => r.price >= 1300)); assert.ok(!out.some((r) => r.decision === "accept"));
});
await t("6 disabled / fixed -> regular only", () => {
  for (const p of [rp001({ negotiation_enabled: "FALSE" }), rp001({ negotiation_mode: "fixed" }), rp001({ negotiation_enabled: "", min_sale_price: "", max_sale_price: "", negotiation_mode: "", price_step: "", max_discount_amount: "" })]) {
    const c = cfgOf(p); const { out } = run(c, [1000, 1000]);
    assert.ok(out.every((r) => r.price === 1450 && r.decision === "no_negotiation"));
  }
});
await t("9 stale catalog -> no new discount (holds current price)", () => {
  const { out } = run(cfg, [1000, 1000], { stale: true }); assert.ok(out.every((r) => r.price === 1450 && r.status === "no_discount_stale"));
});
await t("10 duplicate turn (same turnId) does not advance round", () => {
  let st = newNegotiation(cfg);
  const a = evaluateOffer({ cfg, state: st, customerOffer: 1000, turnId: "x" }); st = a.state;
  const b = evaluateOffer({ cfg, state: st, customerOffer: 1000, turnId: "x" });
  assert.equal(b.state.negotiation_round, 1); assert.equal(b.result.price, 1400);
});
await t("11 inconsistent config -> no negotiation, reason given (no guessing)", () => {
  const bad: [Partial<NonNullable<Product["pricing"]>>, RegExp][] = [
    [{ min_sale_price: "1500" }, /min<=regular/], [{ min_sale_price: "" }, /min_sale_price/], [{ max_sale_price: "1400" }, /min<=regular<=max/],
    [{ price_step: "0" }, /price_step/], [{ negotiation_mode: "auction" }, /unknown/], [{ max_discount_amount: "-5" }, /max_discount/], [{ min_sale_price: "abc" }, /min_sale_price/],
  ];
  for (const [o, re] of bad) { const r = getPricingConfig(rp001(o)); assert.equal(r.ok, false); assert.match((r as any).reason, re); assert.equal((r as any).regular, 1450); }
});
await t("max_discount tighter than min raises floor (max_discount 100 -> floor 1350)", () => {
  const c = cfgOf(rp001({ max_discount_amount: "100" })); assert.equal(c.floor, 1350);
  const { out } = run(c, [1000, 1000, 1000, 1000]); assert.ok(out.every((r) => r.price >= 1350));
});
await t("split mode stays in range and never increases", () => {
  const c = cfgOf(rp001({ negotiation_mode: "split" })); const { out } = run(c, [1100, 1200, 1250]);
  for (let i = 1; i < out.length; i++) assert.ok(out[i].price <= out[i - 1].price);
});
await t("random fuzz: 2000 sequences never below min/floor or above max", () => {
  for (let k = 0; k < 2000; k++) {
    const offers = Array.from({ length: 1 + (k % 6) }, () => (Math.random() < 0.2 ? null : Math.round(Math.random() * 2000)));
    run(cfg, offers);
  }
});
await t("priceForOrder: valid accepted price used; expired / changed / tampered -> regular", () => {
  const { st } = run(cfg, [1380, 1380]);
  assert.deepEqual(priceForOrder(cfg, st, 1450), { unit_price: 1380, negotiated: true });
  assert.equal(priceForOrder(cfg, st, 1450, Date.now() + 31 * 60_000).unit_price, 1450);
  assert.equal(priceForOrder({ ...cfg, regular: 1500 }, st, 1500).unit_price, 1500);
  assert.equal(priceForOrder(cfg, { ...st, approved_final_price: 900 }, 1450).unit_price, 1450);
  assert.equal(priceForOrder(cfg, { ...st, negotiation_status: "countered" }, 1450).unit_price, 1450);
  assert.equal(priceForOrder(null, st, 1450).unit_price, 1450);
});
await t("parseOffer: Bangla/Banglish/English amounts", () => {
  const cases: [string, number | null][] = [
    ["1200 hobe?", 1200], ["১২০০ দিবেন?", 1200], ["12 sho dibo", 1200], ["baro sho te den", 1200], ["বারো শ টাকায় দিবেন", 1200],
    ["1.3k", 1300], ["1,350 tk", 1350], ["৳১৩০০", 1300], ["13 shoto", 1300], ["dam kom hobe?", null], ["2ta nile 2500", 2500],
    ["amar number 01712345678", null], ["1200 na 1300?", null], ["last 1250", 1250], ["ek hajar", null], ["1250 taka final?", 1250],
  ];
  const bad = cases.filter(([s, w]) => parseOffer(s).amount !== w).map(([s, w]) => `${s} => ${parseOffer(s).amount} want ${w}`);
  assert.deepEqual(bad, []);
  assert.equal(parseOffer("1200 na 1300?").ambiguous, true);
});

export function summary() { console.log(`\n${pass} passed, ${fail} failed`); if (fail) process.exit(1); }
if (process.argv[1]?.endsWith("test-pricing.ts")) summary();
