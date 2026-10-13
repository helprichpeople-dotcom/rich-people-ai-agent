// Parse a customer's price offer from Bangla / Banglish / English text. Unclear -> null (ask).
import { normalizeText } from "../sheets/products.js";

const WORD_NUM: Record<string, number> = {
  ek: 1, ak: 1, dui: 2, tin: 3, char: 4, pach: 5, panch: 5, choy: 6, sat: 7, aat: 8, at: 8, noy: 9, dosh: 10, dos: 10,
  egaro: 11, baro: 12, tero: 13, choddo: 14, ponero: 15, sholo: 16, solo: 16,
  এক: 1, দুই: 2, তিন: 3, চার: 4, পাঁচ: 5, ছয়: 6, সাত: 7, আট: 8, নয়: 9, দশ: 10, এগারো: 11, বারো: 12, তেরো: 13, চৌদ্দ: 14, পনেরো: 15, ষোল: 16,
};

export type ParsedOffer = { amount: number | null; ambiguous: boolean };

export function parseOffer(text: string, opts: { min?: number; max?: number } = {}): ParsedOffer {
  const lo = opts.min ?? 50, hi = opts.max ?? 200000;
  let raw = String(text || "").replace(/[০-৯]/g, (d) => String("০১২৩৪৫৬৭৮৯".indexOf(d)));
  raw = raw.replace(/(\d),(?=\d{3}\b)/g, "$1");
  raw = raw.replace(/(\d+(?:\.\d+)?)\s*k\b/gi, (_, n) => ` ${Math.round(Number(n) * 1000)} `);
  let t = normalizeText(raw);
  t = t.replace(/(?:\+?88)?01[3-9]\d{8}/g, " "); // phone numbers
  t = t.replace(/\b\d{1,2}\s*(ta|টা|টি|ti|pcs|piece|pis)\b/g, " "); // quantities
  t = t.replace(/(\d{1,2})\s*(টা|টি)/g, " ");
  const found: number[] = [];
  // "12 sho", "১২ শ", "baro sho", "12 hundred"
  for (const m of t.matchAll(/(\d{1,2}|[a-z\u0980-\u09ff]+)\s*(sho|so|shoto|শ|শো|শত|hundred)(?=\s|$)/g)) {
    const base = /^\d+$/.test(m[1]) ? Number(m[1]) : WORD_NUM[m[1]];
    if (base) found.push(base * 100);
  }
  t = t.replace(/(\d{1,2}|[a-z\u0980-\u09ff]+)\s*(sho|so|shoto|শ|শো|শত|hundred)(?=\s|$)/g, " ");
  for (const m of t.matchAll(/\d[\d,]*/g)) found.push(Number(m[0].replace(/,/g, "")));
  const vals = [...new Set(found.filter((n) => Number.isFinite(n) && n >= lo && n <= hi))];
  if (vals.length === 1) return { amount: vals[0], ambiguous: false };
  return { amount: null, ambiguous: vals.length > 1 };
}
