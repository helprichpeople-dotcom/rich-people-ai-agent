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


// ---------- conversation-level (session, tool, guard) ----------
const { evaluateForConversation, onProductSwitch, getNegotiations, setApprovalRequester, orderUnitPrice, approveNegotiatedPrice } = await import("./pricing/session.js");
const { setNegotiationLogAppender } = await import("./pricing/logs.js");
const { enforcePriceGuard, askGrokWithMedia } = await import("./ai/grok.js");
const { clearState, clearHistory } = await import("./memory.js");
const logs: (string | number)[][] = []; const approvals: any[] = [];
setNegotiationLogAppender(async (_r, row) => { logs.push(row); });
setApprovalRequester(async (p) => { approvals.push(p); });
const P1 = rp001();
const P2: Product = { ...rp001({ regular_price: "900", min_sale_price: "800", max_sale_price: "900", max_discount_amount: "100", price_step: "50" }), product_id: "RP-002", product_name: "Mini Clock", price: 900, delivery_inside_dhaka: 80, delivery_outside_dhaka: 150 };
const ev = (key: string, p: Product, offer: number | null, turn: string, stale = false) => evaluateForConversation({ key, product: p, customerOffer: offer, catalogStale: stale, turnId: turn });

await t("7 multi-product: independent state & limits; switch resets in-progress only", () => {
  clearState("m:C7");
  const a = ev("m:C7", P1, 1000, "a1"); const b = ev("m:C7", P2, 500, "b1");
  assert.equal(a.price_to_quote, 1400); assert.equal(b.price_to_quote, 850);
  assert.ok(b.price_to_quote >= 800 && a.price_to_quote >= 1300);
  onProductSwitch("m:C7", "RP-002");
  assert.equal(getNegotiations("m:C7")["RP-001"], undefined);
  ev("m:C7", P2, 900, "b2"); onProductSwitch("m:C7", "RP-001");
  assert.equal(getNegotiations("m:C7")["RP-002"].negotiation_status, "accepted", "agreed deal kept");
});
await t("10b duplicate tool call in same turn does not advance or double-log", () => {
  clearState("m:C10"); const n = logs.length;
  ev("m:C10", P1, 1000, "same"); const r = ev("m:C10", P1, 1000, "same");
  assert.equal(r.price_to_quote, 1400); assert.equal(getNegotiations("m:C10")["RP-001"].negotiation_round, 1); assert.equal(logs.length, n + 1);
});
await t("9b stale catalog via session: no discount, regular quoted", () => {
  clearState("m:C9"); const r = ev("m:C9", P1, 1000, "s1", true); assert.equal(r.price_to_quote, 1450);
});
await t("11b inconsistent config via session -> regular + config_error log", () => {
  clearState("m:C11"); const r = ev("m:C11", rp001({ min_sale_price: "1600" }), 1000, "c1");
  assert.equal(r.decision, "config_error"); assert.equal(r.price_to_quote, 1450); assert.equal(logs.at(-1)![8], "config_error");
});
await t("12 human approval: below floor after final -> one approval request; approve in range only", () => {
  clearState("messenger:C12");
  ["1","2","3","4","5"].forEach((x) => ev("messenger:C12", P1, 1100, x));
  assert.equal(approvals.filter((a) => a.customer_id === "C12").length, 1);
  assert.equal(getNegotiations("messenger:C12")["RP-001"].negotiation_status, "pending_approval");
  assert.equal(approveNegotiatedPrice("messenger:C12", P1, 1200).ok, false);
  assert.equal(approveNegotiatedPrice("messenger:C12", P1, 1500).ok, false);
  assert.equal(approveNegotiatedPrice("messenger:C12", P1, 1300).ok, true);
  const r = ev("messenger:C12", P1, 1100, "6"); assert.equal(r.decision, "accept"); assert.equal(r.price_to_quote, 1300);
  assert.equal(orderUnitPrice("messenger:C12", P1).unit_price, 1300);
});
await t("Negotiation_Logs rows: 10 columns, hashed id, no PII", () => {
  const row = logs.at(-1)!; assert.equal(row.length, 10);
  assert.match(String(row[1]), /^[0-9a-f]{12}$/); assert.ok(!row.join("|").includes("C12"));
});
await t("bypass: model invents lower price -> reply replaced by engine/regular", () => {
  clearState("m:B1");
  const out = enforcePriceGuard("ঠিক আছে 1100 টাকায় দিয়ে দিচ্ছি", [P1], {}, "m:B1", null, "RP-001");
  assert.ok(!out.includes("1100") && out.includes("1450"));
  const e = ev("m:B1", P1, 1000, "x1");
  const out2 = enforcePriceGuard("ok 1250 taka", [P1], {}, "m:B1", e, "RP-001");
  assert.ok(out2.includes("1400") && !out2.includes("1250"));
  assert.equal(enforcePriceGuard("আপনার জন্য 1400 টাকা, ডেলিভারি 80 টাকা, মোট 1480 টাকা", [P1], {}, "m:B1", e), "আপনার জন্য 1400 টাকা, ডেলিভারি 80 টাকা, মোট 1480 টাকা");
});
await t("bypass in tool loop: model skips tool and says 1200 -> blocked", async () => {
  clearState("test:B2"); clearHistory("test:B2");
  const client = { chat: { completions: { create: async () => ({ choices: [{ message: { role: "assistant", content: "আচ্ছা 1200 টাকায় নিন" } }] }) } } } as any;
  const r = await askGrokWithMedia({ userMessage: "1200 hobe?", products: [P1], settings: {}, channel: "test", customerId: "B2", client, activeProductId: "RP-001" });
  assert.ok(!r.text.includes("1200") && r.text.includes("1450"));
});
await t("tool loop: evaluate_offer used, model rewording with engine price kept; offer parsed from text", async () => {
  clearState("test:B3"); clearHistory("test:B3"); let step = 0; let toolOut: any;
  const client = { chat: { completions: { create: async (req: any) => {
    step++;
    if (step === 1) return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "e1", type: "function", function: { name: "evaluate_offer", arguments: JSON.stringify({ product_id: "RP-001" }) } }] } }] };
    toolOut = JSON.parse(req.messages.at(-1).content);
    return { choices: [{ message: { role: "assistant", content: `ভাই, ${toolOut.price_to_quote} টাকা করতে পারি।` } }] };
  } } } } as any;
  const r = await askGrokWithMedia({ userMessage: "baro sho te diben?", products: [P1], settings: {}, channel: "test", customerId: "B3", client, activeProductId: "RP-001" });
  assert.equal(toolOut.price_to_quote, 1400); assert.ok(r.text.includes("1400"));
  assert.equal(getNegotiations("test:B3")["RP-001"].customer_offer, 1200);
});

// ---------- orders ----------
const { createOrder, setOrderSheetIO, clearRecentOrders } = await import("./sheets/orders.js");
const sheet: string[][] = [["order_id","created_at","channel","customer_id","customer_name","phone","address","product_id","product_name","quantity","unit_price","delivery_charge","total","status","note"]];
let dropWrites = false;
setOrderSheetIO({ read: async () => sheet.map((r) => [...r]), append: async (_r, row) => { if (!dropWrites) sheet.push(row.map(String)); } });
const base = { channel: "messenger", customer_id: "O1", customer_name: "A", address: "Dhaka", delivery_area: "inside_dhaka" as const };
await t("8 delivery total: negotiated 1380 x2 + delivery once (80) = 2840", async () => {
  clearState("messenger:O1"); clearRecentOrders();
  ev("messenger:O1", P1, 1380, "o1"); ev("messenger:O1", P1, 1380, "o2");
  const r = await createOrder({ ...base, phone: "01711111111", product_id: "RP-001", quantity: 2 }, [P1], (p) => orderUnitPrice("messenger:O1", p).unit_price);
  assert.equal(r.unit_price, 1380); assert.equal(r.delivery_charge, 80); assert.equal(r.total, 2840); assert.equal(r.verified, true);
  assert.ok(r.unit_price >= MIN);
  assert.match(sheet.at(-1)![14], /negotiated 1380 \(regular 1450\)/);
});
await t("8b multi-item: delivery charged once, per-product prices/limits", async () => {
  clearState("messenger:O2"); clearRecentOrders();
  ev("messenger:O2", P2, 850, "p1");
  const n = sheet.length;
  const r = await createOrder({ ...base, customer_id: "O2", phone: "01722222222", delivery_area: "outside_dhaka", items: [{ product_id: "RP-001", quantity: 1 }, { product_id: "RP-002", quantity: 2 }] }, [P1, P2], (p) => orderUnitPrice("messenger:O2", p).unit_price);
  assert.equal(sheet.length, n + 2); assert.equal(r.delivery_charge, 150);
  assert.equal(r.total, 1450 + 850 * 2 + 150);
  assert.equal(sheet[n][11], "150"); assert.equal(sheet[n + 1][11], "0");
  assert.ok(r.items!.every((i) => i.unit_price >= (i.product_id === "RP-001" ? 1300 : 800)));
});
await t("order without agreed price uses regular; tampered state ignored", async () => {
  clearState("messenger:O3"); clearRecentOrders();
  const r = await createOrder({ ...base, customer_id: "O3", phone: "01733333333", product_id: "RP-001", quantity: 1 }, [P1], (p) => orderUnitPrice("messenger:O3", p).unit_price);
  assert.equal(r.unit_price, 1450);
});
await t("10c duplicate order (same phone+items today) not written twice", async () => {
  clearRecentOrders(); const n = sheet.length;
  const r = await createOrder({ ...base, customer_id: "O3", phone: "01733333333", product_id: "RP-001", quantity: 1 }, [P1]);
  assert.equal(r.duplicate, true); assert.equal(sheet.length, n);
});
await t("order write not readable back -> verified=false", async () => {
  clearRecentOrders(); dropWrites = true;
  const r = await createOrder({ ...base, customer_id: "O4", phone: "01744444444", product_id: "RP-001", quantity: 1 }, [P1]);
  assert.equal(r.verified, false); dropWrites = false;
});
setOrderSheetIO(null);

await t("12b admin pending list shows below-floor push; approval clears it", async () => {
  const { listPendingApprovals } = await import("./pricing/session.js");
  clearState("whatsapp:A1");
  ["1","2","3","4"].forEach((x) => ev("whatsapp:A1", P1, 1000, x));
  assert.ok(listPendingApprovals().some((a) => a.key === "whatsapp:A1" && a.product_id === "RP-001"));
  assert.equal(approveNegotiatedPrice("whatsapp:A1", P1, 1350).ok, true);
  assert.ok(!listPendingApprovals().some((a) => a.key === "whatsapp:A1"));
});

await t("blank max_discount_amount -> floor = min_sale_price", () => {
  const c = cfgOf(rp001({ max_discount_amount: "" })); assert.equal(c.floor, 1300);
  const { out } = run(c, [1000, 1000, 1000, 1000]); assert.equal(Math.min(...out.map((r) => r.price)), 1300);
});
await t("per-product step from Sheet: 30 and 100", () => {
  const c30 = cfgOf(rp001({ price_step: "30" })); assert.deepEqual(run(c30, [1000, 1000, 1000]).out.map((r) => r.price), [1420, 1390, 1360]);
  const c100 = cfgOf(rp001({ price_step: "100" })); assert.deepEqual(run(c100, [1000, 1000, 1000]).out.map((r) => r.price), [1350, 1300, 1300]);
  const odd = cfgOf(rp001({ price_step: "25" })); assert.deepEqual(run(odd, [null, null]).out.map((r) => r.price), [1425, 1400]);
});
await t("blank/invalid price_step in step mode -> config issue, regular only (no guessing)", () => {
  for (const st of ["", "0", "-10", "abc"]) {
    const r = getPricingConfig(rp001({ price_step: st })); assert.equal(r.ok, false, st); assert.match((r as any).reason, /price_step/);
  }
  clearState("m:S0"); const e = ev("m:S0", rp001({ price_step: "" }), 1000, "z");
  assert.equal(e.decision, "config_error"); assert.equal(e.price_to_quote, 1450);
});
await t("catalog warns on blank price_step", async () => {
  const { setCatalogSource, refreshCatalog } = await import("./sheets/catalog.js");
  const { REQUIRED_PRODUCT_COLUMNS, PRICING_COLUMNS } = await import("./sheets/products.js");
  const hdr = [...REQUIRED_PRODUCT_COLUMNS, ...PRICING_COLUMNS] as string[];
  const row = ["RP-001","Clock","1450","in_stock","","","80","150","","","","","TRUE","1450","1300","1450","TRUE","step","","","x"];
  setCatalogSource({ productRows: async () => [hdr, row], settings: async () => ({}), adRows: async () => [] });
  const c = await refreshCatalog(); assert.ok(c.warnings.some((w) => /RP-001.*price_step/.test(w)));
  setCatalogSource(null);
});

export function summary() { console.log(`\n${pass} passed, ${fail} failed`); if (fail) process.exit(1); }
if (process.argv[1]?.endsWith("test-pricing.ts")) summary();
