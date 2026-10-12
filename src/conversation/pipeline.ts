import { askGrokWithMedia, type GrokReply } from "../ai/grok.js";
import { getCatalog, type Catalog } from "../sheets/catalog.js";
import { lookupAd } from "../sheets/adMapping.js";
import { resolveProduct } from "../sheets/products.js";
import { getState, isHandedOff, pushHistory, setActiveProduct, setState } from "../memory.js";
import { detectIntent, extractOrderInfo, type IntentGuess } from "./intent.js";
import { humanSupportReply, requestHuman } from "../support/handoff.js";

export type Channel = "messenger" | "whatsapp";

export type PipelineDeps = {
  catalog?: () => Promise<Catalog>;
  ask?: typeof askGrokWithMedia;
  now?: number;
  handoff?: typeof requestHuman;
};

const ORDER_FIELDS = ["product", "quantity", "customer_name", "phone", "address", "delivery_area"] as const;
type Collected = { phone?: string; quantity?: number; delivery_area?: "inside_dhaka" | "outside_dhaka" };

/** Intent-specific guidance for the model (no new facts, only behaviour). */
export function intentNotes(g: IntentGuess, st: { shown_product_ids: string[]; active_product_id?: string }, catalog: Catalog): string[] {
  const n: string[] = [`সম্ভাব্য intent: ${g.intent} (আনুমানিক ${Math.round(g.confidence * 100)}%, নিশ্চিত নয়)${g.others.length ? `; অন্য সম্ভাবনা: ${g.others.join(", ")}` : ""}।`];
  switch (g.intent) {
    case "discount_request":
      n.push("ডিসকাউন্ট/শেষ দাম: শুধু শিটের offer কলাম থেকে বলো; offer খালি হলে বিনয়ের সাথে জানাও দাম ফিক্সড। নিজে কোনো ছাড় বানাবে না।");
      break;
    case "comparison":
      n.push("তুলনা: শুধু শিটের দাম/বিবরণ/সুবিধা দিয়ে নিরপেক্ষভাবে তুলনা করো; কোনটা ‘সেরা’ দাবি করো না, কাস্টমারের প্রয়োজন জিজ্ঞেস করো।");
      break;
    case "irrelevant_question":
      n.push("প্রশ্নটি Rich People প্রোডাক্টের বাইরে মনে হচ্ছে: সংক্ষেপে সৎভাবে বলো এ বিষয়ে সাহায্য করতে পারবে না, তারপর প্রোডাক্ট নিয়ে সাহায্যের প্রস্তাব দাও।");
      break;
    case "purchase_intent":
    case "order_request":
      n.push("অর্ডারের দিকে এক ধাপ: শুধু পরের দরকারি তথ্যটি নম্র ভাবে চাও; কোনো চাপ দিও না।");
      break;
    case "product_question": {
      const others = catalog.products.filter((p) => !st.shown_product_ids.includes(p.product_id)).slice(0, 3);
      n.push(`"আরেকটা দেখান"-ধরনের অনুরোধ হলে আগে দেখানো (${st.shown_product_ids.join(", ") || "কিছু না"}) ছাড়া অন্য প্রোডাক্ট প্রস্তাব করো, যেমন: ${others.map((p) => p.product_id).join(", ")}।`);
      break;
    }
  }
  return n;
}

export function nextNeeded(collected: Collected, hasProduct: boolean): string | undefined {
  if (!hasProduct) return "product";
  if (!collected.quantity) return "quantity";
  return collected.phone ? (collected.delivery_area ? "name_address_check" : "delivery_area") : "phone";
}

const locks = new Map<string, Promise<unknown>>();
/** Serialize turns per customer (prevents concurrent-message races). */
export function withCustomerLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) || Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  const tail = run.catch(() => undefined);
  locks.set(key, tail);
  void tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return run;
}

/**
 * Apply an ad referral: valid mapping -> set active product (overrides previous).
 * Invalid/unknown ad -> logged, state untouched (falls back to text matching).
 */
export function applyReferral(channel: Channel, customerId: string, refId: string | undefined, catalog: Catalog, now = Date.now()): string | null {
  if (!refId) return null;
  const key = `${channel}:${customerId}`;
  const m = lookupAd(catalog.adMap, refId, channel);
  if (!m) {
    console.warn(`[referral] ${key} ad ${refId} has no valid Ad_Mapping row; using text matching`);
    return null;
  }
  setActiveProduct(key, m.product_id, "ad", now);
  console.log(`[referral] ${key} ad ${refId} -> ${m.product_id}`);
  return m.product_id;
}

/** Decide active product for this turn + notes for the model. Never guesses on ambiguity. */
export function resolveTurnProduct(channel: Channel, customerId: string, text: string, catalog: Catalog, now = Date.now()) {
  const key = `${channel}:${customerId}`;
  const notes: string[] = [];
  const r = resolveProduct(text, catalog.products);
  if (r.kind === "match") {
    const prev = getState(key, now).active_product_id;
    if (prev !== r.product.product_id) setActiveProduct(key, r.product.product_id, "text", now);
    else setState(key, {}, now);
  } else if (r.kind === "ambiguous") {
    notes.push(
      `কাস্টমারের মেসেজ একাধিক প্রোডাক্টের সাথে মিলতে পারে: ${r.candidates.map((p) => `${p.product_id} (${p.product_name})`).join(", ")}। নিশ্চিত না হয়ে উত্তর দিও না — কোনটি জানতে চায় সংক্ষেপে জিজ্ঞেস করো।`
    );
  }
  const st = getState(key, now);
  const active = st.active_product_id && catalog.products.some((p) => p.product_id === st.active_product_id) ? st.active_product_id : undefined;
  if (st.active_product_id && !active) {
    notes.push("আগের প্রোডাক্টটি এখন শিটে অ্যাকটিভ নেই — কাস্টমারকে জানাও এবং দাম/স্টক বলো না।");
    setState(key, { active_product_id: undefined }, now);
  }
  if (!active && r.kind === "none" && catalog.products.length > 1) {
    notes.push("কোন প্রোডাক্ট নিয়ে কথা হচ্ছে নিশ্চিত নয়। প্রোডাক্ট-নির্দিষ্ট প্রশ্ন হলে কোন প্রোডাক্ট জানতে চাও।");
  }
  if (catalog.stale) notes.push("প্রোডাক্ট তথ্য সাময়িকভাবে পুরোনো হতে পারে; স্টক নিশ্চিত করতে বললে টিম কনফার্ম করবে বলো।");
  return { activeProductId: active, notes, resolve: r };
}

/** Full text turn. Returns null when bot is paused (human handoff). */
export async function handleCustomerText(params: {
  channel: Channel;
  customerId: string;
  text: string;
  referralId?: string;
  deps?: PipelineDeps;
}): Promise<(GrokReply & { catalog: Catalog; intent?: IntentGuess; handedOff?: boolean }) | null> {
  return withCustomerLock(`${params.channel}:${params.customerId}`, () => runTurn(params));
}

async function runTurn(params: Parameters<typeof handleCustomerText>[0]): Promise<(GrokReply & { catalog: Catalog; intent?: IntentGuess; handedOff?: boolean }) | null> {
  const { channel, customerId, text } = params;
  const key = `${channel}:${customerId}`;
  const now = params.deps?.now ?? Date.now();
  const catalog = await (params.deps?.catalog ?? getCatalog)();
  if (isHandedOff(`${channel}:${customerId}`)) {
    console.log(`[handoff] bot paused for ${channel}:${customerId}; message left for human`);
    return null;
  }
  applyReferral(channel, customerId, params.referralId, catalog, now);
  const turn = resolveTurnProduct(channel, customerId, text, catalog, now);
  const intent = detectIntent(text);

  // Complaint / refund / human: hand off directly (does not depend on the model), pause AI.
  if ((intent.intent === "complaint" || intent.intent === "human_support_request") && intent.confidence >= 0.6) {
    await (params.deps?.handoff ?? requestHuman)({ channel, customer_id: customerId, reason: `auto:${intent.intent}` });
    const reply = humanSupportReply(catalog.settings);
    const prefix = intent.intent === "complaint" ? "আপনার অসুবিধার জন্য আমরা আন্তরিকভাবে দুঃখিত। " : "";
    pushHistory(key, { role: "user", content: text });
    pushHistory(key, { role: "assistant", content: prefix + reply });
    setState(key, { intent: intent.intent }, now);
    console.log(`[intent] ${key} ${intent.intent} conf=${intent.confidence} -> handoff`);
    return { text: prefix + reply, media: [], catalog, intent, handedOff: true };
  }

  const prevCollected = (getState(key, now).collected as Collected) || {};
  const collected: Collected = { ...prevCollected, ...extractOrderInfo(text) };
  const need = nextNeeded(collected, Boolean(turn.activeProductId));
  const st = setState(key, { intent: intent.intent, intent_confidence: intent.confidence, collected, next_needed: need }, now);
  turn.notes.push(...intentNotes(intent, st, catalog));
  if (intent.intent === "order_request" || intent.intent === "purchase_intent" || prevCollected.phone || prevCollected.quantity) {
    turn.notes.push(`অর্ডার তথ্য (আনুমানিক): পরিমাণ=${collected.quantity ?? "?"}, ফোন=${collected.phone ? "পাওয়া গেছে" : "?"}, এলাকা=${collected.delivery_area ?? "?"}। পরের দরকারি তথ্য: ${need}। দরকারি ফিল্ড: ${ORDER_FIELDS.join(", ")}।`);
  }
  const ask = params.deps?.ask ?? askGrokWithMedia;
  const reply = await ask({
    userMessage: text,
    products: catalog.products,
    settings: catalog.settings,
    channel,
    customerId,
    activeProductId: turn.activeProductId,
    contextNotes: turn.notes,
  });
  return { ...reply, catalog, intent };
}
