import { askGrokWithMedia, type GrokReply } from "../ai/grok.js";
import { getCatalog, type Catalog } from "../sheets/catalog.js";
import { lookupAd } from "../sheets/adMapping.js";
import { resolveProduct } from "../sheets/products.js";
import { getState, isHandedOff, setActiveProduct, setState } from "../memory.js";

export type Channel = "messenger" | "whatsapp";

export type PipelineDeps = {
  catalog?: () => Promise<Catalog>;
  ask?: typeof askGrokWithMedia;
  now?: number;
};

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
}): Promise<(GrokReply & { catalog: Catalog }) | null> {
  const { channel, customerId, text } = params;
  const now = params.deps?.now ?? Date.now();
  const catalog = await (params.deps?.catalog ?? getCatalog)();
  if (isHandedOff(`${channel}:${customerId}`)) {
    console.log(`[handoff] bot paused for ${channel}:${customerId}; message left for human`);
    return null;
  }
  applyReferral(channel, customerId, params.referralId, catalog, now);
  const turn = resolveTurnProduct(channel, customerId, text, catalog, now);
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
  return { ...reply, catalog };
}
