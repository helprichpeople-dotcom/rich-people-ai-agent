// Conversation Intelligence — mock only (scripted fake model, no network, no Sheet writes).
import assert from "node:assert/strict";
import { detectIntent, isAffirmative, extractOrderInfo, maskPhone } from "./conversation/intent.js";
import { handleCustomerText, withCustomerLock } from "./conversation/pipeline.js";
import { askGrokWithMedia, hasExplicitConfirmation } from "./ai/grok.js";
import { clearState, getState, clearHandoff, isHandedOff, getHistory, clearHistory } from "./memory.js";
import { mockCatalog } from "./test-fixtures.js";

let pass = 0, fail = 0;
async function t(name: string, fn: () => unknown) {
  try { await fn(); pass++; console.log(`✓ ${name}`); } catch (e) { fail++; console.log(`✗ ${name}\n  ${e instanceof Error ? e.message : e}`); }
}
const cat = mockCatalog();
const calls: any[] = [];
const handoffs: any[] = [];
const ask = (async (p: any) => { calls.push(p); return { text: "ok", media: [] }; }) as any;
const handoff = (async (p: any) => { handoffs.push(p); const { setHandoff } = await import("./memory.js"); setHandoff(`${p.channel}:${p.customer_id}`); }) as any;
const deps = { catalog: async () => cat, ask, handoff };
const say = (id: string, text: string, extra: any = {}) => handleCustomerText({ channel: "messenger", customerId: id, text, deps, ...extra });
const reset = (id: string) => { clearState(`messenger:${id}`); clearHandoff(`messenger:${id}`); clearHistory(`messenger:${id}`); };

const TABLE: Array<[string, string]> = [
  ["dam koto?", "price_inquiry"], ["এটার দাম কত", "price_inquiry"], ["price plz", "price_inquiry"], ["daam kto", "price_inquiry"],
  ["shesh dam koto", "discount_request"], ["discount hobe?", "discount_request"], ["কম দাম হবে?", "discount_request"], ["last price bolen", "discount_request"],
  ["RP-001 vs RP-006 kon ta valo", "comparison"], ["দুইটার পার্থক্য কি", "comparison"],
  ["delivery charge koto", "delivery_question"], ["ঢাকার বাইরে কবে পাব", "delivery_question"], ["kobe pabo", "delivery_question"],
  ["order korbo", "order_request"], ["অর্ডার করতে চাই", "order_request"], ["2ta lagbe", "order_request"],
  ["kinte chai", "purchase_intent"], ["stock available?", "purchase_intent"],
  ["product ta kharap", "complaint"], ["refund chai", "complaint"], ["প্রোডাক্ট নষ্ট এসেছে", "complaint"], ["order paini", "complaint"],
  ["manush er sathe kotha bolte chai", "human_support_request"], ["agent please", "human_support_request"], ["প্রতিনিধির সাথে কথা বলতে চাই", "human_support_request"],
  ["kivabe use korbo", "product_question"], ["এটা কিভাবে ব্যবহার করব", "product_question"], ["arekta dekhan", "product_question"],
  ["ajke weather kemon", "irrelevant_question"], ["cricket score?", "irrelevant_question"],
];
await t(`intent table (${TABLE.length} Bangla/Banglish/English phrases)`, () => {
  const bad = TABLE.filter(([s, want]) => detectIntent(s).intent !== want).map(([s, w]) => `${s} => ${detectIntent(s).intent} (want ${w})`);
  assert.deepEqual(bad, []);
});
await t("intent confidence is probabilistic (<1, lower when mixed)", () => {
  const a = detectIntent("dam koto"), b = detectIntent("dam koto delivery charge koto");
  assert.ok(a.confidence < 1 && b.confidence <= a.confidence && b.others.length > 0);
});
await t("affirmative / negative detection", () => {
  for (const y of ["ha", "হ্যাঁ", "ji confirm", "ok", "ঠিক আছে", "confirm koren"]) assert.ok(isAffirmative(y), y);
  for (const n of ["na", "না", "pore", "no thanks", "hello"]) assert.ok(!isAffirmative(n), n);
});
await t("order info extraction + phone masking", () => {
  assert.deepEqual(extractOrderInfo("2ta dorkar, 01712345678, dhakar baire"), { phone: "01712345678", quantity: 2, delivery_area: "outside_dhaka" });
  assert.equal(extractOrderInfo("+8801812345678 ঢাকা").delivery_area, "inside_dhaka");
  assert.equal(maskPhone("call 01712345678"), "call 017*****678");
});

await t("scenario: price only (ad product)", async () => {
  reset("S1");
  await say("S1", "dam koto", { referralId: "AD100" });
  const c = calls.at(-1);
  assert.equal(c.activeProductId, "RP-001");
  assert.ok(c.contextNotes.some((n: string) => n.includes("price_inquiry")));
});
await t("scenario: 5 consecutive questions same product keep context", async () => {
  reset("S2");
  await say("S2", "Neem Soap");
  for (const q of ["dam koto", "delivery kobe pabo", "kivabe use korbo", "stock ache", "shesh dam"]) await say("S2", q);
  assert.ok(calls.slice(-5).every((c) => c.activeProductId === "RP-006"));
  assert.ok(calls.at(-1).contextNotes.some((n: string) => n.includes("offer")));
});
await t("scenario: comparison guidance", async () => {
  reset("S3");
  await say("S3", "RP-001 vs RP-006 kon ta valo");
  assert.ok(calls.at(-1).contextNotes.some((n: string) => n.includes("তুলনা")));
});
await t("scenario: ambiguous -> clarify note, no active product guess", async () => {
  reset("S4");
  await say("S4", "serum er dam koto");
  assert.equal(calls.at(-1).activeProductId, undefined);
  assert.ok(calls.at(-1).contextNotes.some((n: string) => n.includes("একাধিক")));
});
await t("scenario: irrelevant question handled honestly", async () => {
  reset("S5");
  await say("S5", "ajke weather kemon");
  assert.ok(calls.at(-1).contextNotes.some((n: string) => n.includes("বাইরে")));
});
await t("scenario: complaint -> handoff + AI paused, model not called", async () => {
  reset("S6"); const n = calls.length;
  const r = await say("S6", "product ta kharap, refund chai");
  assert.equal(r?.handedOff, true);
  assert.ok(r!.text.includes("wa.me/8801604139500") && r!.text.includes("দুঃখিত"));
  assert.equal(calls.length, n);
  assert.ok(isHandedOff("messenger:S6"));
  assert.equal(await say("S6", "hello?"), null);
  assert.equal(handoffs.at(-1).reason, "auto:complaint");
});
await t("scenario: human request -> handoff", async () => {
  reset("S7");
  const r = await say("S7", "manush er sathe kotha bolte chai");
  assert.equal(r?.handedOff, true);
});
await t("scenario: context switch via new ad + explicit change", async () => {
  reset("S8");
  await say("S8", "eta koto", { referralId: "AD100" });
  await say("S8", "dam?", { referralId: "AD200" });
  assert.equal(calls.at(-1).activeProductId, "RP-020");
  await say("S8", "Aloe Vera Gel er dam");
  assert.equal(calls.at(-1).activeProductId, "RP-002");
  await say("S8", "delivery koto");
  assert.equal(calls.at(-1).activeProductId, "RP-002");
});
await t("scenario: Bangla + Banglish mix, order info collected gently", async () => {
  reset("S9");
  await say("S9", "পেঁয়াজ তেল ta nite chai");
  assert.equal(calls.at(-1).activeProductId, "RP-001");
  await say("S9", "2ta lagbe, amar number 01712345678");
  const st = getState("messenger:S9") as any;
  assert.equal(st.collected.quantity, 2); assert.equal(st.collected.phone, "01712345678");
  assert.equal(st.next_needed, "delivery_area");
  assert.ok(calls.at(-1).contextNotes.some((n: string) => n.includes("চাপ")));
  assert.ok(!JSON.stringify(calls.at(-1).contextNotes).includes("01712345678"), "phone not echoed into notes");
});
await t("'arekta dekhan' suggests not-yet-shown products", async () => {
  reset("S10");
  await say("S10", "Neem Soap");
  await say("S10", "arekta dekhan");
  const note = calls.at(-1).contextNotes.find((n: string) => n.includes("আরেকটা"));
  assert.ok(note && !note.split("যেমন:")[1].includes("RP-006"));
});
await t("session expiry clears active product", async () => {
  reset("S11");
  await say("S11", "Neem Soap");
  assert.equal(getState("messenger:S11", Date.now() + 7 * 3600_000).active_product_id, undefined);
});
await t("per-customer lock serializes concurrent turns", async () => {
  const order: number[] = [];
  await Promise.all([
    withCustomerLock("k", async () => { await new Promise((r) => setTimeout(r, 30)); order.push(1); }),
    withCustomerLock("k", async () => { order.push(2); }),
  ]);
  assert.deepEqual(order, [1, 2]);
});
await t("order gate: needs summary-confirm question then explicit yes", () => {
  const h = [{ role: "assistant", content: "মোট 620 টাকা। কনফার্ম করবেন?" }];
  assert.ok(hasExplicitConfirmation(h, "ha"));
  assert.ok(!hasExplicitConfirmation(h, "na pore"));
  assert.ok(!hasExplicitConfirmation([{ role: "assistant", content: "নাম বলুন" }], "ha"));
  assert.ok(!hasExplicitConfirmation([], "ok"));
});
await t("order gate in tool loop: unconfirmed create_order blocked (no Sheet write)", async () => {
  clearHistory("test:G1");
  let step = 0; const seen: any[] = [];
  const client = { chat: { completions: { create: async (req: any) => {
    seen.push(req.messages.at(-1));
    step++;
    if (step === 1) return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "create_order", arguments: JSON.stringify({ customer_name: "A", phone: "01712345678", address: "x", product_id: "RP-001", quantity: 1, delivery_area: "inside_dhaka" }) } }] } }] };
    return { choices: [{ message: { role: "assistant", content: "আগে সারাংশ দেখাই। কনফার্ম করবেন?" } }] };
  } } } } as any;
  const r = await askGrokWithMedia({ userMessage: "order korbo", products: cat.products, settings: {}, channel: "test", customerId: "G1", client });
  assert.ok(String(seen[1].content).includes("NOT_CONFIRMED"));
  assert.ok(r.text.includes("কনফার্ম"));
  assert.equal(getHistory("test:G1").at(-1)?.role, "assistant");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
