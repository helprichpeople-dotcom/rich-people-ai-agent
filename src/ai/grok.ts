import OpenAI from "openai";
import { assertGrokConfig, config } from "../config.js";
import type { Product, SettingMap } from "../types/catalog.js";

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
}): Promise<string> {
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
5) মানুষের সাথে কথা বলতে চাইলে Human Support-এ পাঠাও।

Settings:
${settingsText}

Products:
${catalog || "(কোনো অ্যাকটিভ প্রোডাক্ট নেই)"}`;

  const completion = await client.chat.completions.create({
    model: config.grokModel,
    messages: [
      { role: "system", content: system },
      { role: "user", content: params.userMessage },
    ],
    temperature: 0.3,
  });

  return completion.choices[0]?.message?.content?.trim() || "উত্তর তৈরি হয়নি।";
}
