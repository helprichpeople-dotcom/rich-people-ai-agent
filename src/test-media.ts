// Mock-only tests for product media. No network: global fetch is replaced to throw.
process.env.MEDIA_SEND_ENABLED = "";
process.env.MESSENGER_PAGE_ACCESS_TOKEN = "mock-token";
process.env.WHATSAPP_ACCESS_TOKEN = "mock-token";
process.env.GROK_API_KEY = "mock";
globalThis.fetch = (async () => {
  throw new Error("NETWORK BLOCKED IN TESTS");
}) as typeof fetch;

import assert from "node:assert/strict";
import type { Product } from "./types/catalog.js";
import type { FetchFn } from "./media/validate.js";

const { validateImageUrl, validateProductUrl } = await import("./media/validate.js");
const { deliverProductMedia } = await import("./media/deliver.js");
const { askGrok, askGrokWithMedia, buildCatalogLine, runShareProductMedia } = await import("./ai/grok.js");
const { config } = await import("./config.js");
const { buildMessengerImagePayload, sendMessengerImage } = await import("./messenger/webhook.js");
const { buildWhatsAppImagePayload } = await import("./whatsapp/webhook.js");

let pass = 0, fail = 0;
async function t(name: string, fn: () => unknown | Promise<unknown>) {
  try { await fn(); pass++; console.log(`✓ ${name}`); }
  catch (e) { fail++; console.error(`✗ ${name}\n  ${e instanceof Error ? e.message : e}`); }
}

const prod = (o: Partial<Product>): Product => ({
  product_id: "P1", product_name: "Oil", price: 500, stock_status: "in_stock", description: "d", benefits: "b",
  delivery_inside_dhaka: 60, delivery_outside_dhaka: 120, product_url: "https://shop.example/p1",
  image_url: "https://cdn.example/p1.jpg", offer: "", faq: "", active: true, ...o,
});
const products = [prod({}), prod({ product_id: "P2", product_name: "Cream", image_url: "", product_url: "" }),
  prod({ product_id: "P3", image_url: "http://insecure.example/x.jpg" })];

const mockFetch = (status: number, headers: Record<string, string>): FetchFn =>
  async () => new Response(null, { status, headers });
const okImg = mockFetch(200, { "content-type": "image/jpeg", "content-length": "1000" });

await t("flag OFF by default", () => assert.equal(config.mediaSendEnabled, false));

await t("validateProductUrl: https ok", () => assert.equal(validateProductUrl("https://a.com/x").ok, true));
await t("validateProductUrl: http/empty/garbage/localhost rejected", () => {
  for (const u of ["http://a.com", "", "not a url", "https://localhost/x", "https://192.168.1.1/x", "javascript:alert(1)"])
    assert.equal(validateProductUrl(u).ok, false, u);
});
await t("validateImageUrl: ok image", async () => assert.equal((await validateImageUrl("https://cdn.example/a.jpg", { fetchFn: okImg })).ok, true));
await t("validateImageUrl: 404", async () => assert.deepEqual(await validateImageUrl("https://cdn.example/a.jpg", { fetchFn: mockFetch(404, {}) }), { ok: false, reason: "http_404" }));
await t("validateImageUrl: non-image content-type", async () => {
  const r = await validateImageUrl("https://cdn.example/a", { fetchFn: mockFetch(200, { "content-type": "text/html" }) });
  assert.equal(r.ok, false);
});
await t("validateImageUrl: too large", async () => {
  const r = await validateImageUrl("https://cdn.example/a", { fetchFn: mockFetch(200, { "content-type": "image/png", "content-length": String(10 * 1024 * 1024) }) });
  assert.deepEqual(r, { ok: false, reason: "too_large" });
});
await t("validateImageUrl: http rejected without fetching", async () => {
  let called = false;
  const r = await validateImageUrl("http://x.com/a.jpg", { fetchFn: async () => { called = true; return new Response(); } });
  assert.equal(r.ok, false); assert.equal(called, false);
});
await t("validateImageUrl: fetch error handled", async () => {
  const r = await validateImageUrl("https://x.com/a.jpg", { fetchFn: async () => { throw new Error("boom"); } });
  assert.equal(r.ok, false);
});
await t("validateImageUrl: timeout", async () => {
  const hang: FetchFn = (_u, init) => new Promise((_, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))));
  assert.deepEqual(await validateImageUrl("https://x.com/a.jpg", { fetchFn: hang, timeoutMs: 20 }), { ok: false, reason: "timeout" });
});

await t("catalog shows presence, never raw image_url", () => {
  const line = buildCatalogLine(products[0]);
  assert.ok(!line.includes("cdn.example")); assert.ok(line.includes("লিংক: আছে")); assert.ok(line.includes("ছবি: আছে"));
  const l2 = buildCatalogLine(products[1]);
  assert.ok(l2.includes("লিংক: নেই")); assert.ok(l2.includes("ছবি: নেই"));
});
await t("share_product_media: queues image, returns link", () => {
  const media: any[] = [];
  const r: any = runShareProductMedia("P1", products, media);
  assert.equal(r.product_url, "https://shop.example/p1"); assert.equal(media.length, 1);
  runShareProductMedia("P1", products, media); assert.equal(media.length, 1, "dedupe");
});
await t("share_product_media: no image / unknown", () => {
  const media: any[] = [];
  assert.equal((runShareProductMedia("P2", products, media) as any).image_queued, false);
  assert.equal((runShareProductMedia("NOPE", products, media) as any).ok, false);
  assert.equal(media.length, 0);
});

function mockClient(script: any[]) {
  let i = 0;
  return { chat: { completions: { create: async () => ({ choices: [{ message: script[i++] }] }) } } } as any;
}
await t("askGrokWithMedia: tool call → text + media", async () => {
  const client = mockClient([
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "share_product_media", arguments: '{"product_id":"P1"}' } }] },
    { role: "assistant", content: "এই যে লিংক: https://shop.example/p1" },
  ]);
  const r = await askGrokWithMedia({ userMessage: "ছবি দেখান", products, settings: {}, customerId: "t1", client });
  assert.equal(r.text, "এই যে লিংক: https://shop.example/p1");
  assert.deepEqual(r.media, [{ type: "product_image", product_id: "P1" }]);
});
await t("askGrok string wrapper still returns string", async () => {
  const r = await askGrok({ userMessage: "hi", products, settings: {}, customerId: "t2", client: mockClient([{ role: "assistant", content: "hello" }]) });
  assert.equal(r, "hello");
});

const media = [{ type: "product_image" as const, product_id: "P1" }];
await t("deliver: flag OFF → skipped, no send, no fetch", async () => {
  let sent = 0, fetched = 0;
  const r = await deliverProductMedia({ media, products, enabled: false, sendImage: async () => { sent++; }, fetchFn: async () => { fetched++; return new Response(); } });
  assert.equal(sent, 0); assert.equal(fetched, 0); assert.equal(r[0].status, "skipped"); assert.equal(r[0].reason, "media_send_disabled");
});
await t("deliver: flag ON (mock) → sent with caption", async () => {
  const calls: string[][] = [];
  const r = await deliverProductMedia({ media, products, enabled: true, fetchFn: okImg, sendImage: async (u, c) => { calls.push([u, c]); } });
  assert.equal(r[0].status, "sent"); assert.deepEqual(calls, [["https://cdn.example/p1.jpg", "Oil"]]);
});
await t("deliver: invalid image → skipped", async () => {
  let sent = 0;
  const r = await deliverProductMedia({ media, products, enabled: true, fetchFn: mockFetch(404, {}), sendImage: async () => { sent++; } });
  assert.equal(sent, 0); assert.equal(r[0].status, "skipped");
});
await t("deliver: http image / no image / unknown product skipped", async () => {
  const r = await deliverProductMedia({
    media: ["P3", "P2", "ZZ"].map((product_id) => ({ type: "product_image" as const, product_id })),
    products, enabled: true, fetchFn: okImg, sendImage: async () => { throw new Error("should not send"); },
  });
  assert.deepEqual(r.map((x) => x.status), ["skipped", "skipped", "skipped"]);
});
await t("deliver: send failure is caught", async () => {
  const r = await deliverProductMedia({ media, products, enabled: true, fetchFn: okImg, sendImage: async () => { throw new Error("meta 500"); } });
  assert.equal(r[0].status, "failed");
});
await t("deliver: max 3 images, dedupe", async () => {
  const many = Array.from({ length: 5 }, (_, i) => prod({ product_id: `M${i}` }));
  let sent = 0;
  const r = await deliverProductMedia({
    media: [...many, many[0]].map((p) => ({ type: "product_image" as const, product_id: p.product_id })),
    products: many, enabled: true, fetchFn: okImg, sendImage: async () => { sent++; },
  });
  assert.equal(sent, 3); assert.equal(r.length, 5);
});

await t("Messenger image payload", () => assert.deepEqual(buildMessengerImagePayload("psid1", "https://cdn.example/a.jpg"), {
  recipient: { id: "psid1" }, messaging_type: "RESPONSE",
  message: { attachment: { type: "image", payload: { url: "https://cdn.example/a.jpg", is_reusable: true } } },
}));
await t("sendMessengerImage uses injected fetch (mock)", async () => {
  let url = ""; let body: any;
  await sendMessengerImage("psid1", "https://cdn.example/a.jpg", async (u, init) => { url = u; body = JSON.parse(String(init?.body)); return new Response("{}", { status: 200 }); });
  assert.ok(url.startsWith("https://graph.facebook.com/")); assert.equal(body.message.attachment.type, "image");
});
await t("WhatsApp image payload", () => assert.deepEqual(buildWhatsAppImagePayload("8801", "https://cdn.example/a.jpg", "Oil"), {
  messaging_product: "whatsapp", recipient_type: "individual", to: "8801", type: "image",
  image: { link: "https://cdn.example/a.jpg", caption: "Oil" },
}));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
