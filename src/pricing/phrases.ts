// Natural Bangla shopkeeper phrasing. Numbers always come from the engine.
import type { Decision } from "./engine.js";

const T: Record<Decision, string[]> = {
  accept: [
    "ঠিক আছে ভাই, আপনার জন্য {price} টাকায় দিচ্ছি। অর্ডার কনফার্ম করতে চাইলে বলবেন 😊",
    "আচ্ছা, {price} টাকাতেই নিন। ডেলিভারি চার্জ আলাদা — ঢাকার ভিতরে {inside}, বাইরে {outside} টাকা।",
    "ডিল! {price} টাকা। কোথায় পাঠাবো জানালে অর্ডার রেডি করে দিই।",
  ],
  counter: [
    "ভাই, এত কমে আসলে সম্ভব না 🙏 আপনার জন্য সর্বোচ্চ {price} টাকা করতে পারি।",
    "প্রোডাক্টের কোয়ালিটি অনুযায়ী দামটা আসলেই ন্যায্য। তবুও আপনার জন্য {price} টাকা বলছি।",
    "একটু কমিয়ে {price} টাকা দিতে পারবো, এর চেয়ে কম হলে আমাদের লস হয়ে যায়।",
    "আপনি আমাদের কাস্টমার, তাই {price} টাকায় দিতে পারি।",
  ],
  final: [
    "ভাই, {price} টাকাই একদম শেষ দাম — এর নিচে আর সম্ভব না 🙏",
    "সত্যি বলছি, {price} টাকার নিচে দিলে লস। এটাই ফাইনাল।",
    "{price} টাকা আমাদের লাস্ট প্রাইস। চাইলে এখনই অর্ডার করে রাখতে পারেন।",
  ],
  needs_approval: [
    "ভাই, {price} টাকাই আমাদের শেষ দাম। আপনার প্রস্তাবটা আমি ম্যানেজারকে জানিয়ে রাখলাম, সম্ভব হলে জানানো হবে।",
    "এর নিচে আমি দিতে পারি না, তবে আপনার অফারটা ম্যানেজারের কাছে পাঠালাম। আপাতত {price} টাকায় নিতে পারেন।",
  ],
  no_negotiation: [
    "দুঃখিত ভাই, এই প্রোডাক্টের দাম ফিক্সড — {price} টাকা।",
    "এটার দাম {price} টাকা, এখানে দরদাম করার সুযোগ নেই 🙏",
  ],
  quote: ["দাম {price} টাকা। ডেলিভারি চার্জ ঢাকার ভিতরে {inside}, বাইরে {outside} টাকা।"],
};

export function phrase(decision: Decision, v: { price: number; inside: number; outside: number }, rand = Math.random): string {
  const list = T[decision] || T.quote;
  const s = list[Math.floor(rand() * list.length) % list.length];
  return s.replace("{price}", String(v.price)).replace("{inside}", String(v.inside)).replace("{outside}", String(v.outside));
}
