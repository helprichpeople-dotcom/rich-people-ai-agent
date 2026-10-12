// Rule-based intent hints (Bangla / Banglish / English, typo tolerant). Probabilistic, never certain.
import { normalizeText } from "../sheets/products.js";

export const INTENTS = [
  "product_question", "price_inquiry", "discount_request", "comparison", "delivery_question",
  "purchase_intent", "order_request", "complaint", "irrelevant_question", "human_support_request",
] as const;
export type Intent = (typeof INTENTS)[number];
export type IntentGuess = { intent: Intent; confidence: number; others: Intent[] };

const RULES: Array<[Intent, RegExp, number]> = [
  ["human_support_request", /(মানুষ|এজেন্ট|প্রতিনিধি|কল দিন|কল করুন|human|agent|manush|real person|representative|call me|call den|kotha bolte chai|কথা বলতে চাই)/, 0.85],
  ["complaint", /(refund|ফেরত|রিফান্ড|ferot|return korbo|complain|অভিযোগ|নষ্ট|খারাপ|kharap|nosto|ভাঙা|bhanga|damaged|broken|fake|নকল|nokol|ঠকা|thoka|পাইনি|paini|pai nai|asheni|আসেনি|late delivery|wrong product|ভুল প্রোডাক্ট|vul product|problem hoise|সমস্যা হয়েছে|scam|প্রতারণা|reaction|allergy|এলার্জি)/, 0.8],
  ["discount_request", /(discount|ডিসকাউন্ট|ছাড়|chhar|char dib|kom (dam|e|koren|hobe)|কম (দাম|হবে|করেন)|shesh dam|sesh dam|last price|শেষ দাম|final price|lowest|কমানো|komano|offer (dibe|den|ache)|অফার আছে)/, 0.75],
  ["comparison", /(\bvs\b|versus|compare|তুলনা|tulona|parthokko|parthoko|পার্থক্য|difference|kon ta (valo|bhalo)|কোনটা ভালো|konta valo|which is better|better)/, 0.75],
  ["order_request", /(order (korbo|dibo|den|confirm|chai|korte)|অর্ডার (করব|দিব|দেব|চাই|করতে|কনফার্ম)|অর্ডার করবো|place order|confirm order|buy now|nibo|নিব|নেব|nebo|pathan|পাঠান|pathiye den|লাগবে|lagbe)/, 0.75],
  ["delivery_question", /(delivery|ডেলিভারি|deliveri|delivary|shipping|courier|কুরিয়ার|কবে পাব|kobe pabo|koto din|কত দিন|ঢাকার বাইরে|dhakar baire|outside dhaka|cash on|ক্যাশ অন|charge koto|চার্জ)/, 0.7],
  ["price_inquiry", /(\bdam\b|daam|dham|দাম|price|prise|koto (taka|tk)|কত টাকা|how much|\bkoto\b|কত|rate|মূল্য)/, 0.7],
  ["purchase_intent", /(kinte chai|কিনতে চাই|kinbo|কিনব|interested|nite chai|নিতে চাই|want to buy|stock|স্টক|available|পাওয়া যাবে|pawa jabe)/, 0.6],
  ["product_question", /(kaj kore|কাজ করে|kivabe|কিভাবে|কীভাবে|use|ব্যবহার|byabohar|benefit|উপকার|upokar|ingredient|উপাদান|size|সাইজ|ml|দেখান|dekhan|chobi|ছবি|picture|photo|details|বিস্তারিত|side effect|পার্শ্বপ্রতিক্রিয়া|original|আসল|ashol)/, 0.6],
];

const IRRELEVANT = /(weather|আবহাওয়া|cricket|ক্রিকেট|football|ফুটবল|politics|রাজনীতি|election|নির্বাচন|joke|কৌতুক|movie|সিনেমা|song|গান|recipe|রেসিপি|bitcoin|crypto|homework|capital of|who is the|tumi ke|তুমি কে|bot naki|ai naki|biye|বিয়ে|love you)/;

export function detectIntent(text: string): IntentGuess {
  const t = ` ${normalizeText(text)} `;
  const hits = RULES.filter(([, re]) => re.test(t)).map(([i, , c]) => ({ i, c }));
  if (!hits.length) {
    if (IRRELEVANT.test(t)) return { intent: "irrelevant_question", confidence: 0.6, others: [] };
    return { intent: "product_question", confidence: 0.3, others: [] };
  }
  const [top, ...rest] = hits;
  return { intent: top.i, confidence: rest.length ? Math.max(0.5, top.c - 0.1) : top.c, others: rest.map((h) => h.i) };
}

export const AFFIRMATIVE = /^(ha|haa|hya|hyan|han|hum|hmm|ji|jee|jii|ok|okay|okk|yes|yeah|yep|sure|confirm|confirmed|done|thik ache|thik ase|ঠিক আছে|হ্যাঁ|হ্যা|হা|জি|জ্বি|জী|কনফার্ম|অবশ্যই|ওকে|করুন|koren|kore din|দিন|din)(\s|$)/;
export function isAffirmative(text: string): boolean {
  const t = normalizeText(text);
  if (/(^|\s)(na|না|no|nah|not|নাহ|পরে|pore|wait|cancel|বাতিল)(\s|$)/.test(t)) return false;
  return AFFIRMATIVE.test(t) || /(কনফার্ম|confirm)/.test(t);
}

/** Extract only order-relevant facts (no free-text PII beyond what order needs). */
export function extractOrderInfo(text: string): { phone?: string; quantity?: number; delivery_area?: "inside_dhaka" | "outside_dhaka" } {
  const t = normalizeText(text);
  const out: ReturnType<typeof extractOrderInfo> = {};
  const ph = t.replace(/[\s-]/g, "").match(/(?:\+?88)?(01[3-9]\d{8})/);
  if (ph) out.phone = ph[1];
  const q = t.match(/(\d{1,2})\s*(ta|টা|টি|pcs|piece|pis|ti|khana|bottle|বোতল)/);
  if (q) out.quantity = Number(q[1]);
  if (/(dhakar baire|ঢাকার বাইরে|outside dhaka|baire)/.test(t)) out.delivery_area = "outside_dhaka";
  else if (/(dhaka|ঢাকা)/.test(t)) out.delivery_area = "inside_dhaka";
  return out;
}

export function maskPhone(s: string): string {
  return String(s || "").replace(/(01\d)\d{5}(\d{3})/g, "$1*****$2");
}
