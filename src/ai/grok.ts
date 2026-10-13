import OpenAI from "openai";
import { assertGrokConfig, config } from "../config.js";
import type { Product, SettingMap } from "../types/catalog.js";
import { isAffirmative } from "../conversation/intent.js";
import { createOrder } from "../sheets/orders.js";
import { requestHuman, humanSupportReply, resolveWhatsAppContact } from "../support/handoff.js";
import { validateImageUrl, validateProductUrl } from "../media/validate.js";
import { getHistory, pushHistory, clearHistory, setState } from "../memory.js";
import { allowedNegotiatedPrices, evaluateForConversation, type EvaluateToolResult } from "../pricing/session.js";
import { parseOffer } from "../pricing/parseOffer.js";
import { phrase } from "../pricing/phrases.js";
import crypto from "node:crypto";

const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "evaluate_offer",
      description:
        "MUST be called whenever the customer asks for a discount / lower / last / final price or offers an amount. The shop's pricing engine decides; quote exactly price_to_quote (you may reword phrasing_hint naturally in Bangla). Never state any other discounted price.",
      parameters: {
        type: "object",
        properties: {
          product_id: { type: "string", description: "product_id from the Products list" },
          customer_offer: { type: "number", description: "Amount (BDT, per unit) the customer offered, if they named one" },
        },
        required: ["product_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_order",
      description:
        "Save a confirmed order to the Orders sheet. Call ONLY after the customer has explicitly confirmed (e.g. 'হ্যাঁ', 'confirm', 'ok') a summary you showed with all details.",
      parameters: {
        type: "object",
        properties: {
          customer_name: { type: "string" },
          phone: { type: "string", description: "Bangladeshi mobile number, e.g. 01XXXXXXXXX" },
          address: { type: "string" },
          product_id: { type: "string", description: "product_id from the Products list" },
          quantity: { type: "integer", minimum: 1 },
          delivery_area: { type: "string", enum: ["inside_dhaka", "outside_dhaka"] },
          note: { type: "string" },
        },
        required: ["customer_name", "phone", "address", "product_id", "quantity", "delivery_area"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "request_human",
      description: "Customer wants to talk to a human / agent / support person, or has a complaint you cannot solve.",
      parameters: {
        type: "object",
        properties: { reason: { type: "string" } },
        required: ["reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "share_product_media",
      description:
        "Customer wants to see a product's picture/photo or link. Returns the product link (if any) to include in your reply and queues the product image to be sent separately. Never paste image URLs yourself.",
      parameters: {
        type: "object",
        properties: { product_id: { type: "string", description: "product_id from the Products list" } },
        required: ["product_id"],
      },
    },
  },
];

export type ReplyMedia = { type: "product_image"; product_id: string };
export type GrokReply = { text: string; media: ReplyMedia[] };

export function createGrokClient(): OpenAI {
  assertGrokConfig();
  return new OpenAI({
    apiKey: config.grokApiKey,
    baseURL: config.grokBaseUrl,
  });
}

type AskParams = {
  userMessage: string;
  products: Product[];
  settings: SettingMap;
  languageHint?: string;
  channel?: string;
  customerId?: string;
  client?: Pick<OpenAI, "chat">;
  /** Product the conversation is currently about (from ad / text / image). */
  activeProductId?: string;
  /** Extra system notes from the pipeline (ambiguity, intent, state). */
  contextNotes?: string[];
  /** Catalog served from stale cache (Sheets read failed): no new discounts. */
  catalogStale?: boolean;
};

/** Backwards-compatible: text only. */
export async function askGrok(params: AskParams): Promise<string> {
  return (await askGrokWithMedia(params)).text;
}

export function buildCatalogLine(p: Product): string {
  const link = validateProductUrl(p.product_url).ok ? "আছে" : "নেই";
  const img = p.image_url?.trim() ? "আছে" : "নেই";
  return `- ${p.product_id} | ${p.product_name} | দাম ${p.price} BDT | স্টক: ${p.stock_status} | ${p.description} | সুবিধা: ${p.benefits} | অফার: ${p.offer} | FAQ: ${p.faq} | ঢাকা ডেলিভারি ${p.delivery_inside_dhaka} | বাইরে ${p.delivery_outside_dhaka} | লিংক: ${link} | ছবি: ${img}`;
}

export function runShareProductMedia(productId: string, products: Product[], media: ReplyMedia[]): unknown {
  const p = products.find((x) => x.product_id === productId);
  if (!p) return { ok: false, error: "unknown product_id" };
  const link = validateProductUrl(p.product_url);
  const hasImage = Boolean(p.image_url?.trim());
  if (hasImage && !media.some((m) => m.product_id === p.product_id)) {
    media.push({ type: "product_image", product_id: p.product_id });
  }
  return {
    ok: true,
    product_url: link.ok ? link.url : null,
    image_queued: hasImage,
    note: hasImage
      ? "Image will be sent automatically if available. Do not paste image URLs."
      : "No image for this product; share the link if present.",
  };
}

/** create_order gate: an earlier assistant turn asked to confirm, and the latest customer message is a clear yes. */
export function hasExplicitConfirmation(history: { role: string; content: string }[], userMessage: string): boolean {
  const lastAssistant = [...history].reverse().find((m) => m.role === "assistant");
  if (!lastAssistant || !/(কনফার্ম|confirm|নিশ্চিত)/i.test(lastAssistant.content)) return false;
  return isAffirmative(userMessage);
}

export async function askGrokWithMedia(params: AskParams): Promise<GrokReply> {
  const media: ReplyMedia[] = [];
  const channel = params.channel || "test";
  const customerId = params.customerId || "local";
  const memKey = `${channel}:${customerId}`;
  const client = params.client || createGrokClient();
  const catalog = params.products.map(buildCatalogLine).join("\n");
  const active = params.activeProductId ? params.products.find((p) => p.product_id === params.activeProductId) : undefined;
  const activeText = active
    ? `\n\nবর্তমান প্রোডাক্ট (active_product_id=${active.product_id}): কাস্টমার অন্য প্রোডাক্টের নাম না বললে "দাম কত", "ডেলিভারি", "অর্ডার" ইত্যাদি এই প্রোডাক্ট নিয়েই ধরো।\n${buildCatalogLine(active)}`
    : "";
  const notesText = params.contextNotes?.length ? `\n\nকনটেক্সট নোট:\n${params.contextNotes.map((n) => `- ${n}`).join("\n")}` : "";

  const settingsText = Object.entries(params.settings)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");

  const system = `তুমি Rich People ব্র্যান্ডের AI সেলস ও কাস্টমার সাপোর্ট সহকারী।
নিয়ম:
1) শুধু নিচের Products ও Settings তথ্য ব্যবহার করো। তথ্য না থাকলে বলো না জানো।
2) বাংলা বা ইংরেজিতে স্বাভাবিকভাবে উত্তর দাও।
3) দাম, স্টক, ডেলিভারি চার্জ বানানো যাবে না।
4) অর্ডার নিতে হলে নাম, ফোন, ঠিকানা, প্রোডাক্ট, পরিমাণ চাও।
5) মানুষের সাথে কথা বলতে চাইলে request_human টুল কল করো, তারপর বাংলায় জানাও যে Rich People-এর জন্য WhatsApp-এ কল/মেসেজ করতে: ${resolveWhatsAppContact(params.settings).link} (${resolveWhatsAppContact(params.settings).number})। অন্য কোনো নম্বর বানাবে না।
6) অর্ডার প্রক্রিয়া: নাম, ফোন, ঠিকানা, প্রোডাক্ট, পরিমাণ এবং ঢাকার ভিতরে না বাইরে জেনে নাও। তারপর একটি সারাংশ দেখাও (প্রোডাক্ট, পরিমাণ, দাম, ডেলিভারি চার্জ, মোট) এবং "কনফার্ম করবেন?" জিজ্ঞেস করো। কাস্টমার স্পষ্টভাবে কনফার্ম করলে তবেই create_order টুল কল করো। নিজে কখনো order_id বানাবে না।
7) create_order সফল হলে order_id সহ সংক্ষিপ্ত অর্ডার সারাংশ দিয়ে ধন্যবাদ জানাও (ক্যাশ অন ডেলিভারি, শীঘ্রই কনফার্মেশন কল আসবে)।
8) কাস্টমার ছবি বা লিংক দেখতে চাইলে share_product_media টুল কল করো। কখনো নিজে URL বানাবে না।
9) কাস্টমার বাংলা, Banglish (রোমান হরফে বাংলা) বা ইংরেজি — যেভাবেই লিখুক, বানান ভুল হলেও অর্থ বুঝে একই ভাষার ধাঁচে উত্তর দাও। "dam koto", "shesh dam", "arekta dekhan" ইত্যাদি আগের কথোপকথন ও বর্তমান প্রোডাক্টের প্রসঙ্গে বোঝো।
10) একাধিক প্রোডাক্ট হতে পারলে অনুমান না করে কোনটি জানতে চাও। কাস্টমারের উদ্দেশ্য নিশ্চিত না হলে নম্রভাবে জিজ্ঞেস করো।
11) অর্ডারের জন্য কখনো চাপ দিও না; প্রতি উত্তরে সর্বোচ্চ একটি নম্র পরবর্তী ধাপ।
12) প্রোডাক্টের বাইরের প্রশ্নে সৎভাবে বলো সাহায্য করতে পারবে না; কোনো তথ্য বানাবে না। অভিযোগ/রিফান্ড/মানুষের সাথে কথা বলতে চাইলে request_human কল করো।
13) কাস্টমারের ব্যক্তিগত তথ্য শুধু অর্ডারের জন্য যা দরকার তাই চাও।
14) দরদাম/ডিসকাউন্ট/শেষ দাম/কাস্টমার কোনো দাম প্রস্তাব করলে অবশ্যই evaluate_offer টুল কল করো এবং ঠিক price_to_quote সংখ্যাটাই বলো। নিজে কখনো কোনো কম দাম, ছাড় বা "শেষ দাম" বানাবে না। কাস্টমারের প্রস্তাবিত দাম মেনে নিয়েছো এমন বলবে না যতক্ষণ না টুল decision=accept দেয়। দোকানদারের মতো ভদ্র, স্বাভাবিক বাংলায় বলো, প্রতিবার একই বাক্য নয়।
15) ডেলিভারি চার্জ পুরো অর্ডারে একবারই (যত প্রোডাক্টই হোক)। একাধিক প্রোডাক্ট হলে create_order-এ items দাও।

Settings:
${settingsText}

Products:
${catalog || "(কোনো অ্যাকটিভ প্রোডাক্ট নেই)"}${activeText}${notesText}`;

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: system },
    ...getHistory(memKey),
    { role: "user", content: params.userMessage },
  ];
  pushHistory(memKey, { role: "user", content: params.userMessage });
  let orderPlaced = false;
  const turnId = crypto.randomUUID();
  let lastEval: EvaluateToolResult | null = null;

  for (let step = 0; step < 4; step++) {
    const completion = await client.chat.completions.create({
      model: config.grokModel,
      messages,
      tools: TOOLS,
      temperature: 0.3,
    });
    const msg = completion.choices[0]?.message;
    if (!msg) break;
    const calls = msg.tool_calls || [];
    if (!calls.length) {
      const reply0 = msg.content?.trim() || "উত্তর তৈরি হয়নি।";
      const reply = enforcePriceGuard(reply0, params.products, params.settings, memKey, lastEval, params.activeProductId);
      autoAttachIdentifiedProduct(params.userMessage, params.products, media, memKey);
      if (orderPlaced) { clearHistory(memKey); setState(memKey, { collected: {}, next_needed: undefined }); }
      else pushHistory(memKey, { role: "assistant", content: reply });
      return { text: reply, media };
    }
    messages.push(msg);
    for (const call of calls) {
      let result: unknown;
      try {
        const args = JSON.parse(call.function.arguments || "{}");
        if (call.function.name === "create_order") {
          if (!hasExplicitConfirmation(getHistory(memKey), params.userMessage)) {
            console.warn(`[order] ${memKey} create_order blocked: no explicit confirmation after summary`);
            result = { ok: false, error: "NOT_CONFIRMED: first show the full order summary (product, qty, price, delivery charge, total) and ask 'কনফার্ম করবেন?'. Call create_order only after the customer clearly says yes." };
          } else {
            const r = await createOrder({ ...args, channel, customer_id: customerId }, params.products);
            result = r.verified === false
              ? { ...r, note: "Row write could not be verified. Do NOT promise the order is saved; say the team will confirm by phone shortly." }
              : r;
            orderPlaced = true;
          }
        } else if (call.function.name === "request_human") {
          await requestHuman({ channel, customer_id: customerId, reason: String(args.reason || "") });
          const wa = resolveWhatsAppContact(params.settings);
          result = {
            ok: true,
            whatsapp_number: wa.number,
            whatsapp_link: wa.link,
            message: `Human support notified. Reply in Bangla: tell the customer to call or message Rich People on WhatsApp at ${wa.link} (${wa.number}). Suggested reply: ${humanSupportReply(params.settings)}`,
          };
        } else if (call.function.name === "evaluate_offer") {
          const p = params.products.find((x) => x.product_id === String(args.product_id || "").trim());
          if (!p) result = { ok: false, error: "unknown product_id" };
          else {
            const offerArg = Number(args.customer_offer);
            const parsed = parseOffer(params.userMessage);
            const offer = Number.isFinite(offerArg) && offerArg > 0 ? offerArg : parsed.amount;
            lastEval = evaluateForConversation({ key: memKey, product: p, customerOffer: offer, catalogStale: Boolean(params.catalogStale), turnId: `${turnId}:${p.product_id}` });
            result = lastEval;
          }
        } else if (call.function.name === "share_product_media") {
          result = runShareProductMedia(String(args.product_id || ""), params.products, media);
        } else {
          result = { error: "unknown tool" };
        }
      } catch (err) {
        console.error(`Tool ${call.function.name} failed:`, err);
        result = { error: err instanceof Error ? err.message : "failed" };
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
    }
  }
  return { text: "দুঃখিত, এখন অনুরোধটি সম্পন্ন করা যায়নি। একটু পরে আবার চেষ্টা করুন।", media };
}

const autoSent = new Map<string, Set<string>>();
export function clearAutoSent(): void { autoSent.clear(); }

/** Finds the single active product named in the text (by product_id or product_name). */
export function identifyProductInText(text: string, products: Product[]): Product | null {
  const t = String(text || "").toLowerCase();
  if (!t.trim()) return null;
  const hits = products.filter((p) => {
    const id = p.product_id.trim().toLowerCase();
    const name = p.product_name.trim().toLowerCase();
    return (id && t.includes(id)) || (name.length >= 3 && t.includes(name));
  });
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Outbound: when the customer's message clearly identifies one product and the model did
 * not queue its image, queue it — once per product per conversation (no spam).
 */
export function autoAttachIdentifiedProduct(text: string, products: Product[], media: ReplyMedia[], memKey: string): void {
  if (media.length) return;
  const p = identifyProductInText(text, products);
  if (!p || !p.image_url?.trim()) return;
  const sent = autoSent.get(memKey) || new Set<string>();
  if (sent.has(p.product_id)) return;
  sent.add(p.product_id);
  autoSent.set(memKey, sent);
  if (autoSent.size > 5000) autoSent.clear();
  media.push({ type: "product_image", product_id: p.product_id });
}

function sniffMime(b: Uint8Array): string | null {
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
  if (b[0] === 0x89 && b[1] === 0x50) return "image/png";
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) return "image/webp";
  return null;
}

/**
 * Vision fallback for inbound images: asks Grok which product_id (if any) the photo shows.
 * Returns null on any error / unsupported model / "NONE".
 */
export async function grokVisionMatch(bytes: Uint8Array, products: Product[], client?: Pick<OpenAI, "chat">): Promise<string | null> {
  const mime = sniffMime(bytes);
  if (!mime || !config.grokApiKey) return null;
  const c = client || createGrokClient();
  const list = products.map((p) => `- ${p.product_id}: ${p.product_name} — ${p.description}`).join("\n");
  const content: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [
    { type: "text", text: `Customer photo below. Which ONE product from this catalog does it show? Reply with only the product_id, or NONE if unsure.\n${list}` },
    { type: "image_url", image_url: { url: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}` } },
  ];
  for (const p of products.slice(0, 6)) {
    if (!p.image_url) continue;
    const v = await validateImageUrl(p.image_url);
    if (!v.ok) continue;
    content.push({ type: "text", text: `Reference image for ${p.product_id}:` });
    content.push({ type: "image_url", image_url: { url: v.url } });
  }
  const r = await c.chat.completions.create({ model: config.grokVisionModel, messages: [{ role: "user", content }], temperature: 0 });
  const out = (r.choices[0]?.message?.content || "").trim();
  const id = products.find((p) => out.toUpperCase().includes(p.product_id.toUpperCase()));
  return id ? id.product_id : null;
}

/**
 * Price guard: returns amounts written next to a currency marker (৳/tk/taka/টাকা/BDT)
 * that are not any Sheet price, delivery charge, valid total, or number in offer/Settings text.
 */
export function findUnknownPrices(reply: string, products: Product[], settings: SettingMap = {}): number[] {
  const t = String(reply || "").replace(/[০-৯]/g, (d) => String("০১২৩৪৫৬৭৮৯".indexOf(d)));
  const re = /(?:৳|tk\.?|taka|টাকা|bdt)\s*([\d,]+)|([\d,]+)\s*(?:৳|tk\b|taka|টাকা|bdt)/gi;
  const known = new Set<number>();
  const textNums = (x: string) => (x.replace(/[০-৯]/g, (d) => String("০১২৩৪৫৬৭৮৯".indexOf(d))).match(/\d[\d,]*/g) || []).map((n) => Number(n.replace(/,/g, "")));
  for (const p of products) {
    for (const v of [p.price, p.delivery_inside_dhaka, p.delivery_outside_dhaka]) known.add(v);
    for (const q of [1, 2, 3, 4, 5]) {
      known.add(p.price * q);
      known.add(p.price * q + p.delivery_inside_dhaka);
      known.add(p.price * q + p.delivery_outside_dhaka);
    }
    textNums(`${p.offer} ${p.faq} ${p.description}`).forEach((n) => known.add(n));
  }
  Object.values(settings).forEach((v) => textNums(String(v)).forEach((n) => known.add(n)));
  const out: number[] = [];
  for (const m of t.matchAll(re)) {
    const n = Number(String(m[1] || m[2]).replace(/,/g, ""));
    if (Number.isFinite(n) && n > 0 && !known.has(n)) out.push(n);
  }
  return out;
}

/**
 * Hard price guard: if the reply states any amount that is not a Sheet price/charge/total and not
 * an engine-quoted price for this conversation, replace the reply with the engine's template.
 */
export function enforcePriceGuard(reply: string, products: Product[], settings: SettingMap, memKey: string, lastEval: EvaluateToolResult | null, activeProductId?: string): string {
  const allowed = allowedNegotiatedPrices(memKey);
  const bad = findUnknownPrices(reply, products, settings).filter((n) => !isAllowedAmount(n, allowed, products));
  if (!bad.length) return reply;
  console.warn(`[price-guard] ${memKey} blocked reply with unapproved amounts: ${bad.join(",")}`);
  if (lastEval) return lastEval.phrasing_hint;
  const p = products.find((x) => x.product_id === activeProductId);
  if (p) {
    const regular = Number(p.pricing?.regular_price) || p.price;
    return phrase("quote", { price: regular, inside: p.delivery_inside_dhaka, outside: p.delivery_outside_dhaka });
  }
  return "দাম জানতে কোন প্রোডাক্টটি চান জানাবেন? আমি শিট থেকে সঠিক দাম বলে দিচ্ছি।";
}

function isAllowedAmount(n: number, allowed: number[], products: Product[]): boolean {
  const units = new Set<number>(allowed);
  for (const p of products) { units.add(p.price); const r = Number(p.pricing?.regular_price); if (r > 0) units.add(r); }
  const lines: number[] = [];
  for (const u of units) for (let q = 1; q <= 5; q++) lines.push(u * q);
  const charges = new Set<number>([0]);
  for (const p of products) { charges.add(p.delivery_inside_dhaka); charges.add(p.delivery_outside_dhaka); }
  const lineSet = new Set(lines);
  for (const c of charges) {
    const x = n - c;
    if (x <= 0) continue;
    if (lineSet.has(x)) return true;
    for (const a of lines) if (a < x && lineSet.has(x - a)) return true; // two-item order totals
  }
  return false;
}
