import OpenAI from "openai";
import { assertGrokConfig, config } from "../config.js";
import type { Product, SettingMap } from "../types/catalog.js";
import { createOrder } from "../sheets/orders.js";
import { requestHuman } from "../support/handoff.js";
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
];

export function createGrokClient(): OpenAI {
  assertGrokConfig();
  return new OpenAI({
    apiKey: config.grokApiKey,
    baseURL: config.grokBaseUrl,
  });
}

export async function askGrok(params: {
  userMessage: string;
  products: Product[];
  settings: SettingMap;
  languageHint?: string;
  channel?: string;
  customerId?: string;
}): Promise<string> {
  const channel = params.channel || "test";
  const customerId = params.customerId || "local";
  const memKey = `${channel}:${customerId}`;
  const client = createGrokClient();
  const catalog = params.products
    .map(
      (p) =>
        `- ${p.product_id} | ${p.product_name} | দাম ${p.price} BDT | স্টক: ${p.stock_status} | ${p.description} | সুবিধা: ${p.benefits} | অফার: ${p.offer} | FAQ: ${p.faq} | ঢাকা ডেলিভারি ${p.delivery_inside_dhaka} | বাইরে ${p.delivery_outside_dhaka}`
    )
    .join("\n");

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
      if (orderPlaced) clearHistory(memKey);
      else pushHistory(memKey, { role: "assistant", content: reply });
      return reply;
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
  return "দুঃখিত, এখন অনুরোধটি সম্পন্ন করা যায়নি। একটু পরে আবার চেষ্টা করুন।";
}
