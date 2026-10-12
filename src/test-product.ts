// Product Intelligence — mock only (25 products, no network, no Sheet, no Meta).
import assert from "node:assert/strict";
import { parseProducts, resolveProduct } from "./sheets/products.js";
import { parseAdMapping, lookupAd } from "./sheets/adMapping.js";
import { setCatalogSource, getCatalog, refreshCatalog, catalogStatus } from "./sheets/catalog.js";
import { extractMessengerReferral, extractWhatsAppReferral } from "./conversation/referral.js";
import { handleCustomerText, applyReferral } from "./conversation/pipeline.js";
import { findUnknownPrices } from "./ai/grok.js";
import { getState, clearState, isDuplicateMessageId, setHandoff, clearHandoff } from "./memory.js";
import { productRows, AD_ROWS, mockCatalog } from "./test-fixtures.js";

let pass = 0, fail = 0;
async function t(name: string, fn: () => unknown) {
  try { await fn(); pass++; console.log(`✓ ${name}`); } catch (e) { fail++; console.log(`✗ ${name}\n  ${e instanceof Error ? e.message : e}`); }
}

await t("parse 25 products without aliases column", () => {
  const ps = parseProducts(productRows());
  assert.equal(ps.length, 25);
  assert.deepEqual(ps[0].aliases, []);
  assert.equal(ps[0].price, 500);
});
await t("parse with aliases + skip inactive/empty id rows", () => {
  const ps = parseProducts(productRows({ aliases: true, extraRows: [["RP-900", "Hidden", "1", "", "", "", "", "", "", "", "", "", "FALSE"], ["", "No id"]] }));
  assert.equal(ps.length, 25);
  assert.deepEqual(ps[0].aliases, ["piyaj tel", "পেঁয়াজ তেল"]);
});
await t("missing required column throws", () => {
  const rows = productRows(); rows[0] = rows[0].map((h) => (h === "price" ? "cost" : h));
  assert.throws(() => parseProducts(rows), /price/);
});
await t("all required fields present", () => {
  const p = parseProducts(productRows())[3];
  for (const k of ["product_id", "product_name", "price", "stock_status", "description", "offer", "faq", "image_url", "delivery_inside_dhaka", "delivery_outside_dhaka"]) assert.ok(k in p, k);
});

const cat = mockCatalog();
await t("Ad_Mapping: valid, unknown product skipped, inactive skipped, platform", () => {
  assert.equal(cat.adMap.size, 3);
  assert.ok(cat.warnings.some((w) => w.includes("AD300")));
  assert.equal(lookupAd(cat.adMap, "AD100", "whatsapp")?.product_id, "RP-001");
  assert.equal(lookupAd(cat.adMap, "AD200", "whatsapp"), null);
  assert.equal(lookupAd(cat.adMap, "AD200", "messenger")?.product_id, "RP-020");
  assert.equal(lookupAd(cat.adMap, "AD500", "messenger"), null);
  assert.equal(lookupAd(cat.adMap, "NOPE", "messenger"), null);
});
await t("Ad_Mapping duplicate ad_id: last wins + warning; header-only = empty", () => {
  const r = parseAdMapping([...AD_ROWS, ["AD100", "RP-005", "both", "", "", ""]], cat.products);
  assert.equal(r.map.get("AD100")?.product_id, "RP-005");
  assert.ok(r.warnings.some((w) => w.includes("duplicate")));
  assert.equal(parseAdMapping([AD_ROWS[0]], cat.products).map.size, 0);
  assert.equal(parseAdMapping([], cat.products).map.size, 0);
});
await t("referral extraction Messenger/WhatsApp", () => {
  assert.equal(extractMessengerReferral({ referral: { ad_id: "AD100", source: "ADS" } }), "AD100");
  assert.equal(extractMessengerReferral({ message: { referral: { ad_id: "AD1" } } }), "AD1");
  assert.equal(extractMessengerReferral({ postback: { referral: { ad_id: "AD2" } } }), "AD2");
  assert.equal(extractMessengerReferral({}), undefined);
  assert.equal(extractWhatsAppReferral({ referral: { source_id: "AD100", source_type: "ad" } }), "AD100");
  assert.equal(extractWhatsAppReferral({}), undefined);
});
await t("text matching: id, name, alias, typo, Bangla digits", () => {
  const ps = cat.products;
  const m = (s: string) => { const r = resolveProduct(s, ps); return r.kind === "match" ? r.product.product_id : r.kind; };
  assert.equal(m("RP-007 er dam koto"), "RP-007");
  assert.equal(m("rp 007 ache?"), "RP-007");
  assert.equal(m("Neem Soap price?"), "RP-006");
  assert.equal(m("piyaj tel ta chai"), "RP-001");
  assert.equal(m("kalojira tel dam"), "RP-020");
  assert.equal(m("sunscren spf50 ache"), "RP-008");
  assert.equal(m("hello"), "none");
});
await t("ambiguous text -> ask (serum matches several)", () => {
  const r = resolveProduct("serum ta koto", cat.products);
  assert.equal(r.kind, "ambiguous");
  if (r.kind === "ambiguous") assert.ok(r.candidates.length >= 2);
});

const calls: any[] = [];
const ask = (async (p: any) => { calls.push(p); return { text: "ok", media: [] }; }) as any;
const deps = { catalog: async () => cat, ask };
await t("ad referral sets active product; persists across 5 messages", async () => {
  clearState("messenger:U1");
  await handleCustomerText({ channel: "messenger", customerId: "U1", text: "hi", referralId: "AD100", deps });
  for (const q of ["dam koto", "delivery charge?", "stock ache?", "offer ache?", "kivabe use korbo"]) await handleCustomerText({ channel: "messenger", customerId: "U1", text: q, deps });
  assert.ok(calls.slice(-6).every((c) => c.activeProductId === "RP-001"));
  assert.equal(getState("messenger:U1").product_source, "ad");
});
await t("new ad overrides; explicit product change overrides", async () => {
  await handleCustomerText({ channel: "messenger", customerId: "U1", text: "eta?", referralId: "AD200", deps });
  assert.equal(calls.at(-1).activeProductId, "RP-020");
  await handleCustomerText({ channel: "messenger", customerId: "U1", text: "Neem Soap dekhan", deps });
  assert.equal(calls.at(-1).activeProductId, "RP-006");
});
await t("invalid mapping -> fallback to text, no crash", async () => {
  clearState("whatsapp:W1");
  const id = applyReferral("whatsapp", "W1", "AD300", cat);
  assert.equal(id, null);
  await handleCustomerText({ channel: "whatsapp", customerId: "W1", text: "Aloe Vera Gel", referralId: "AD300", deps });
  assert.equal(calls.at(-1).activeProductId, "RP-002");
});
await t("product removed from sheet -> active cleared + note", async () => {
  clearState("whatsapp:W2");
  await handleCustomerText({ channel: "whatsapp", customerId: "W2", text: "x", referralId: "AD100", deps });
  const smaller = { ...cat, products: cat.products.filter((p) => p.product_id !== "RP-001") };
  await handleCustomerText({ channel: "whatsapp", customerId: "W2", text: "dam koto", deps: { ...deps, catalog: async () => smaller } });
  assert.equal(calls.at(-1).activeProductId, undefined);
  assert.ok(calls.at(-1).contextNotes.some((n: string) => n.includes("অ্যাকটিভ নেই")));
});
await t("handoff -> pipeline returns null, model not called", async () => {
  const n = calls.length; setHandoff("messenger:H1");
  assert.equal(await handleCustomerText({ channel: "messenger", customerId: "H1", text: "hi", deps }), null);
  assert.equal(calls.length, n); clearHandoff("messenger:H1");
});
await t("duplicate message id dedupe (time window)", () => {
  assert.equal(isDuplicateMessageId("wa:1", 0), false);
  assert.equal(isDuplicateMessageId("wa:1", 1000), true);
  assert.equal(isDuplicateMessageId("wa:1", 7 * 3600_000), false);
});
await t("price guard flags invented amounts only", () => {
  assert.deepEqual(findUnknownPrices("দাম ৫০০ টাকা, ডেলিভারি 60 tk, মোট ৳560", cat.products), []);
  assert.deepEqual(findUnknownPrices("offer price 450 taka", cat.products), []);
  assert.deepEqual(findUnknownPrices("special 333 টাকা", cat.products), [333]);
});
await t("catalog cache: TTL, single-flight, stale on error, image change", async () => {
  let n = 0, failNext = false;
  const rows = productRows();
  setCatalogSource({ productRows: async () => { n++; if (failNext) throw new Error("api down"); return rows; }, settings: async () => ({}), adRows: async () => AD_ROWS });
  const [a, b] = await Promise.all([getCatalog(1000), getCatalog(1000)]);
  assert.equal(n, 1); assert.equal(a.products.length, 25); assert.equal(b, a);
  await getCatalog(2000); assert.equal(n, 1);
  await getCatalog(1000 + 61_000); assert.equal(n, 2);
  failNext = true;
  const c = await refreshCatalog(200_000); assert.equal(c.stale, true); assert.equal(c.products.length, 25);
  failNext = false; rows[1][9] = "https://cdn.example/new.jpg";
  const d = await refreshCatalog(300_000); assert.equal(d.stale, false); assert.equal(d.products[0].image_url, "https://cdn.example/new.jpg");
  assert.equal(catalogStatus().products, 25);
});
await t("catalog: missing Ad_Mapping tab tolerated; first-load failure throws", async () => {
  setCatalogSource({ productRows: async () => productRows(), settings: async () => ({}), adRows: async () => [] });
  assert.equal((await refreshCatalog()).adMap.size, 0);
  setCatalogSource({ productRows: async () => { throw new Error("down"); }, settings: async () => ({}), adRows: async () => [] });
  await assert.rejects(() => refreshCatalog());
  setCatalogSource(null);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
