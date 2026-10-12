// Mock-only tests for inbound image matching. No network.
process.env.MEDIA_SEND_ENABLED = "true";
process.env.MESSENGER_PAGE_ACCESS_TOKEN = "mock-token";
process.env.WHATSAPP_ACCESS_TOKEN = "mock-token";
process.env.GROK_API_KEY = "mock";
globalThis.fetch = (async () => { throw new Error("NETWORK BLOCKED IN TESTS"); }) as typeof fetch;

import assert from "node:assert/strict";
import type { Product } from "./types/catalog.js";
import type { FetchFn } from "./media/validate.js";
const { handleInboundImage, clearImageHashCache } = await import("./media/match.js");
const { handleMessengerImage } = await import("./messenger/webhook.js");
const { handleWhatsAppImage } = await import("./whatsapp/webhook.js");

let pass = 0, fail = 0;
async function t(name: string, fn: () => unknown | Promise<unknown>) {
  clearImageHashCache();
  try { await fn(); pass++; console.log(`✓ ${name}`); }
  catch (e) { fail++; console.error(`✗ ${name}\n  ${e instanceof Error ? e.message : e}`); }
}
const prod = (o: Partial<Product>): Product => ({
  product_id: "P1", product_name: "Oil", price: 500, stock_status: "in_stock", description: "d", benefits: "b",
  delivery_inside_dhaka: 60, delivery_outside_dhaka: 120, product_url: "https://shop.example/p1",
  image_url: "https://cdn.example/p1.jpg", offer: "", faq: "", active: true, ...o,
});
const products = [prod({}), prod({ product_id: "P2", product_name: "Cream", image_url: "https://cdn.example/p2.jpg", product_url: "https://shop.example/p2" })];
const imgs: Record<string, Uint8Array> = {
  "https://cdn.example/p1.jpg": new Uint8Array([1, 2, 3]),
  "https://cdn.example/p2.jpg": new Uint8Array([4, 5, 6]),
  "https://fbcdn.example/cust-same.jpg": new Uint8Array([4, 5, 6]),
  "https://fbcdn.example/cust-other.jpg": new Uint8Array([9, 9]),
  "https://lookaside.wa.example/m1": new Uint8Array([1, 2, 3]),
};
const mock: FetchFn = async (url, init) => {
  if (init?.method === "HEAD") return new Response(null, { status: 200, headers: { "content-type": "image/jpeg", "content-length": "3" } });
  if (url.includes("graph.facebook.com") && url.endsWith("/WAMEDIA1")) return Response.json({ url: "https://lookaside.wa.example/m1" });
  const b = imgs[url];
  return b ? new Response(Buffer.from(b), { status: 200, headers: { "content-type": "image/jpeg" } }) : new Response(null, { status: 404 });
};

await t("hash match finds product", async () => {
  const r = await handleInboundImage({ bytes: new Uint8Array([4, 5, 6]), products, fetchFn: mock });
  assert.equal(r.product?.product_id, "P2");
  assert.match(r.text, /Cream/); assert.match(r.text, /shop.example\/p2/);
});
await t("no match -> catalog list, no invented product", async () => {
  const r = await handleInboundImage({ bytes: new Uint8Array([7]), products, fetchFn: mock });
  assert.equal(r.product, null); assert.match(r.text, /চিনতে পারিনি/); assert.match(r.text, /Oil/);
});
await t("url equality match", async () => {
  const r = await handleInboundImage({ bytes: null, sourceUrl: "https://cdn.example/p1.jpg?x=1", products, fetchFn: mock });
  assert.equal(r.product?.product_id, "P1");
});
await t("messenger: match replies text + sends product image", async () => {
  const texts: string[] = [], sent: string[] = [];
  const r = await handleMessengerImage("psid", "https://fbcdn.example/cust-same.jpg", { fetchFn: mock, products, sendText: async (x) => { texts.push(x); }, sendImage: async (u) => { sent.push(u); } });
  assert.equal(r.product?.product_id, "P2"); assert.equal(texts.length, 1); assert.deepEqual(sent, ["https://cdn.example/p2.jpg"]);
});
await t("messenger: no match sends no image", async () => {
  const sent: string[] = [];
  const r = await handleMessengerImage("psid", "https://fbcdn.example/cust-other.jpg", { fetchFn: mock, products, sendText: async () => {}, sendImage: async (u) => { sent.push(u); } });
  assert.equal(r.product, null); assert.equal(sent.length, 0);
});
await t("whatsapp: media id download + match", async () => {
  const sent: string[] = [];
  const r = await handleWhatsAppImage("PN", "8801", "WAMEDIA1", { fetchFn: mock, products, sendText: async () => {}, sendImage: async (u) => { sent.push(u); } });
  assert.equal(r.product?.product_id, "P1"); assert.deepEqual(sent, ["https://cdn.example/p1.jpg"]);
});
await t("whatsapp: download failure -> unmatched reply", async () => {
  const r = await handleWhatsAppImage("PN", "8801", "BAD", { fetchFn: mock, products, sendText: async () => {} });
  assert.equal(r.product, null);
});
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
