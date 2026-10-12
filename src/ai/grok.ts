import OpenAI from "openai";
import { assertGrokConfig, config } from "../config.js";
import type { Product, SettingMap } from "../types/catalog.js";
import { createOrder } from "../sheets/orders.js";
import { requestHuman } from "../support/handoff.js";
import { validateImageUrl, validateProductUrl } from "../media/validate.js";
import { getHistory, pushHistory, clearHistory } from "../memory.js";

const TOOLS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
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

export async function askGrokWithMedia(params: AskParams): Promise<GrokReply> {
  const media: ReplyMedia[] = [];
  const channel = params.channel || "test";
  const customerId = params.customerId || "local";
  const memKey = `${channel}:${customerId}`;
  const client = params.client || createGrokClient();
  const catalog = params.products.map(buildCatalogLine).join("\n");

  const settingsText = Object.entries(params.settings)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");

  const system = `তুমি Rich People ব্র্যান্ডের AI সেলস ও কাস্টমার সাপোর্ট সহকারী।
নিয়ম:
1) শুধু নিচের Products ও Settings তথ্য ব্যবহার করো। তথ্য না থাকলে বলো না জানো।
2) বাংলা বা ইংরেজিতে স্বাভাবিকভাবে উত্তর দাও।
3) দাম, স্টক, ডেলিভারি চার্জ বানানো যাবে না।
4) অর্ডার নিতে হলে নাম, ফোন, ঠিকানা, প্রোডাক্ট, পরিমাণ চাও।
5) মানুষের সাথে কথা বলতে চাইলে request_human টুল কল করো।
6) অর্ডার প্রক্রিয়া: নাম, ফোন, ঠিকানা, প্রোডাক্ট, পরিমাণ এবং ঢাকার ভিতরে না বাইরে জেনে নাও। তারপর একটি সারাংশ দেখাও (প্রোডাক্ট, পরিমাণ, দাম, ডেলিভারি চার্জ, মোট) এবং "কনফার্ম করবেন?" জিজ্ঞেস করো। কাস্টমার স্পষ্টভাবে কনফার্ম করলে তবেই create_order টুল কল করো। নিজে কখনো order_id বানাবে না।
7) create_order সফল হলে order_id সহ সংক্ষিপ্ত অর্ডার সারাংশ দিয়ে ধন্যবাদ জানাও (ক্যাশ অন ডেলিভারি, শীঘ্রই কনফার্মেশন কল আসবে)।
8) কাস্টমার ছবি বা লিংক দেখতে চাইলে share_product_media টুল কল করো। কখনো নিজে URL বানাবে না।

Settings:
${settingsText}

Products:
${catalog || "(কোনো অ্যাকটিভ প্রোডাক্ট নেই)"}`;

  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: system },
    ...getHistory(memKey),
    { role: "user", content: params.userMessage },
  ];
  pushHistory(memKey, { role: "user", content: params.userMessage });
  let orderPlaced = false;

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
      const reply = msg.content?.trim() || "উত্তর তৈরি হয়নি।";
      autoAttachIdentifiedProduct(params.userMessage, params.products, media, memKey);
      if (orderPlaced) clearHistory(memKey);
      else pushHistory(memKey, { role: "assistant", content: reply });
      return { text: reply, media };
    }
    messages.push(msg);
    for (const call of calls) {
      let result: unknown;
      try {
        const args = JSON.parse(call.function.arguments || "{}");
        if (call.function.name === "create_order") {
          result = await createOrder({ ...args, channel, customer_id: customerId }, params.products);
          orderPlaced = true;
        } else if (call.function.name === "request_human") {
          await requestHuman({ channel, customer_id: customerId, reason: String(args.reason || "") });
          result = { ok: true, message: "Human support notified. Tell the customer a team member will reply soon." };
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
