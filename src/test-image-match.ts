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

// ---- Similarity matching (aHash / dims / vision) + URL resolution + auto-attach ----
const jpegMod = (await import("jpeg-js")).default;
const { PNG } = await import("pngjs");
const { matchImageDetailed } = await import("./media/match.js");
const { validateImageUrl, normalizeImageUrl } = await import("./media/validate.js");
const { autoAttachIdentifiedProduct, identifyProductInText } = await import("./ai/grok.js");
type Px = (x: number, y: number, w: number, h: number) => [number, number, number];
function raster(w: number, h: number, f: Px): Buffer {
  const d = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const [r, g, b] = f(x, y, w, h); const i = (y * w + x) * 4; d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255; }
  return d;
}
const mkJpeg = (w: number, h: number, f: Px, q = 90) => new Uint8Array(jpegMod.encode({ width: w, height: h, data: raster(w, h, f) }, q).data);
const mkPng = (w: number, h: number, f: Px) => { const p = new PNG({ width: w, height: h }); p.data = raster(w, h, f); return new Uint8Array(PNG.sync.write(p)); };
const diag: Px = (x, y, w, h) => { const v = (x / w + y / h) > 1 ? 230 : 30; return [v, v, v]; };
const checker: Px = (x, y, w, h) => { const v = ((Math.floor((x * 4) / w) + Math.floor((y * 4) / h)) % 2) ? 220 : 20; return [v, 40, 40]; };
const rings: Px = (x, y, w, h) => { const d = Math.hypot(x / w - 0.5, y / h - 0.5); return d < 0.3 ? [240, 240, 240] : [10, 10, 10]; };
const simImgs: Record<string, Uint8Array> = {
  "https://cdn.example/s1.jpg": mkJpeg(400, 400, diag),
  "https://cdn.example/s2.png": mkPng(300, 300, checker),
  "https://cdn.example/s3.jpg": mkJpeg(320, 320, rings),
};
const simProducts = [
  prod({ product_id: "S1", product_name: "Diag Oil", image_url: "https://cdn.example/s1.jpg" }),
  prod({ product_id: "S2", product_name: "Checker Cream", image_url: "https://cdn.example/s2.png" }),
  prod({ product_id: "S3", product_name: "Ring Serum", image_url: "https://cdn.example/s3.jpg" }),
];
const simFetch: FetchFn = async (url) => {
  const b = simImgs[url];
  return b ? new Response(Buffer.from(b), { status: 200, headers: { "content-type": url.endsWith(".png") ? "image/png" : "image/jpeg" } }) : new Response(null, { status: 404 });
};
await t("ahash: recompressed + resized customer photo matches", async () => {
  const cust = mkJpeg(173, 173, diag, 40); // different size + heavy recompression -> different sha
  const r = await matchImageDetailed(cust, simProducts, { fetchFn: simFetch });
  assert.equal(r.product?.product_id, "S1"); assert.equal(r.method, "ahash"); assert.ok((r.score ?? 0) >= 0.85);
});
await t("ahash: png product vs jpeg screenshot matches", async () => {
  const r = await matchImageDetailed(mkJpeg(600, 600, checker, 60), simProducts, { fetchFn: simFetch });
  assert.equal(r.product?.product_id, "S2");
});
await t("ahash: unrelated photo does not match (no invention)", async () => {
  const noise: Px = (x, y) => { const v = ((x * 7919 + y * 104729) % 251); return [v, v, v]; };
  const r = await matchImageDetailed(mkJpeg(200, 200, noise), simProducts, { fetchFn: simFetch, vision: null });
  assert.equal(r.product, null);
});
await t("dims+size tier", async () => {
  const orig = simImgs["https://cdn.example/s3.jpg"]; const tweaked = new Uint8Array(orig.length + 1); tweaked.set(orig); // same pixels/dims, +1 trailing byte -> different sha
  const r = await matchImageDetailed(tweaked, simProducts, { fetchFn: simFetch });
  assert.equal(r.product?.product_id, "S3"); assert.ok(r.method === "dims_size" || r.method === "ahash");
});
await t("vision fallback used when hashes fail; unknown id ignored", async () => {
  const noise: Px = (x, y) => { const v = ((x * 31 + y * 17) % 256); return [v, 0, v]; };
  const cust = mkJpeg(90, 90, noise);
  const r = await matchImageDetailed(cust, simProducts, { fetchFn: simFetch, vision: async () => "S2" });
  assert.equal(r.product?.product_id, "S2"); assert.equal(r.method, "vision");
  const r2 = await matchImageDetailed(cust, simProducts, { fetchFn: simFetch, vision: async () => "FAKE-9" });
  assert.equal(r2.product, null);
  const r3 = await matchImageDetailed(cust, simProducts, { fetchFn: simFetch, vision: async () => { throw new Error("no vision"); } });
  assert.equal(r3.product, null);
});
await t("validate: HTML page resolves to og:image", async () => {
  const f: FetchFn = async (url) => {
    if (url === "https://shop.example/page") return new Response(`<html><head><meta property="og:image" content="https://cdn.example/s1.jpg"></head></html>`, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    return simFetch(url);
  };
  const v = await validateImageUrl("https://shop.example/page", { fetchFn: f });
  assert.deepEqual(v, { ok: true, url: "https://cdn.example/s1.jpg" });
  const bad = await validateImageUrl("https://shop.example/none", { fetchFn: async () => new Response("<html></html>", { status: 200, headers: { "content-type": "text/html" } }) });
  assert.equal(bad.ok, false);
});
await t("validate: share links normalized", async () => {
  assert.equal(normalizeImageUrl("https://drive.google.com/file/d/ABC123/view?usp=sharing"), "https://drive.google.com/uc?export=view&id=ABC123");
  assert.equal(normalizeImageUrl("https://www.dropbox.com/s/x/a.jpg?dl=0"), "https://www.dropbox.com/s/x/a.jpg?raw=1");
  assert.equal(normalizeImageUrl("https://imgur.com/AbC12"), "https://i.imgur.com/AbC12.jpg");
});
await t("outbound: product named in text auto-queues image once", async () => {
  assert.equal(identifyProductInText("ring serum er dam koto?", simProducts)?.product_id, "S3");
  assert.equal(identifyProductInText("hello", simProducts), null);
  const m1: any[] = []; autoAttachIdentifiedProduct("Ring Serum price?", simProducts, m1, "messenger:u1");
  assert.deepEqual(m1, [{ type: "product_image", product_id: "S3" }]);
  const m2: any[] = []; autoAttachIdentifiedProduct("Ring Serum again", simProducts, m2, "messenger:u1");
  assert.equal(m2.length, 0);
});
console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
