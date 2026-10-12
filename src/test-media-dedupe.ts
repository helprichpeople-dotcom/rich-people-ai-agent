// Mock-only: no duplicate product image sends. No network.
import assert from "node:assert/strict";
import { deliverProductMedia, clearRecentMediaSends } from "./media/deliver.js";
import { isDuplicateMid } from "./messenger/webhook.js";
const p = { product_id: "RP-001", product_name: "Oil", image_url: "https://cdn.example/rp1.jpg" } as any;
const fetchFn = (async () => new Response(Buffer.from([0xff, 0xd8, 0xff]), { status: 200, headers: { "content-type": "image/jpeg", "content-length": "3" } })) as any;
const m = { type: "product_image" as const, product_id: "RP-001" };
let sent = 0;
const run = (key = "messenger:U1") => deliverProductMedia({ media: [m, m, m], products: [p], enabled: true, fetchFn, recipientKey: key, sendImage: async () => { sent++; } });
clearRecentMediaSends();
await run(); assert.equal(sent, 1, "same reply x3 -> 1");
await Promise.all([run(), run(), run()]); assert.equal(sent, 1, "concurrent calls -> no resend");
await run("messenger:U2"); assert.equal(sent, 2, "other user still gets it");
clearRecentMediaSends(); sent = 0;
await Promise.all([run(), run(), run()]); assert.equal(sent, 1, "3 concurrent requests -> 1");
assert.equal(isDuplicateMid("m.1"), false); assert.equal(isDuplicateMid("m.1"), true);
console.log("media dedupe tests OK");
