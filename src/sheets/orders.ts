import crypto from "node:crypto";
import { appendSheetRow, readSheetValues } from "./client.js";
import type { Product } from "../types/catalog.js";

export type OrderInput = {
  channel: string;
  customer_id: string;
  customer_name: string;
  phone: string;
  address: string;
  product_id: string;
  quantity: number;
  delivery_area: "inside_dhaka" | "outside_dhaka";
  note?: string;
};

export type OrderResult = {
  order_id: string;
  duplicate: boolean;
  product_name: string;
  quantity: number;
  unit_price: number;
  delivery_charge: number;
  total: number;
};

const DEFAULT_HEADER = [
  "order_id", "created_at", "channel", "customer_id", "customer_name", "phone", "address",
  "product_id", "product_name", "quantity", "unit_price", "delivery_charge", "total", "status", "note",
];

// Header aliases -> canonical field. Row is built by matching the Orders sheet header row.
const ALIASES: Record<string, string> = {
  order_id: "order_id", orderid: "order_id", id: "order_id",
  created_at: "created_at", date: "created_at", timestamp: "created_at", order_date: "created_at", time: "created_at",
  channel: "channel", source: "channel", platform: "channel",
  customer_id: "customer_id", psid: "customer_id", user_id: "customer_id", sender_id: "customer_id",
  customer_name: "customer_name", name: "customer_name", customer: "customer_name",
  phone: "phone", mobile: "phone", phone_number: "phone", customer_phone: "phone",
  address: "address", delivery_address: "address", customer_address: "address",
  product_id: "product_id", product_name: "product_name", product: "product_name",
  quantity: "quantity", qty: "quantity",
  unit_price: "unit_price", price: "unit_price",
  delivery_charge: "delivery_charge", delivery: "delivery_charge", delivery_fee: "delivery_charge",
  delivery_area: "delivery_area", area: "delivery_area",
  total: "total", total_amount: "total", total_price: "total", amount: "total",
  status: "status", order_status: "status",
  note: "note", notes: "note", remarks: "note",
};

const norm = (s: string) => s.trim().toLowerCase().replace(/[\s-]+/g, "_");
const normPhone = (s: string) => s.replace(/[^\d]/g, "").replace(/^88/, "");

function dhakaDate(): { ymd: string; stamp: string } {
  const d = new Date(Date.now() + 6 * 3600 * 1000);
  const iso = d.toISOString();
  return { ymd: iso.slice(0, 10).replace(/-/g, ""), stamp: iso.slice(0, 19).replace("T", " ") };
}

const recent = new Map<string, { at: number; result: OrderResult }>();
let lock: Promise<unknown> = Promise.resolve();

export function createOrder(input: OrderInput, products: Product[]): Promise<OrderResult> {
  const run = lock.then(() => doCreate(input, products));
  lock = run.catch(() => undefined);
  return run;
}

async function doCreate(input: OrderInput, products: Product[]): Promise<OrderResult> {
  const product = products.find(
    (p) => p.product_id.toLowerCase() === String(input.product_id).trim().toLowerCase()
  );
  if (!product) throw new Error(`Unknown product_id: ${input.product_id}`);
  const qty = Math.max(1, Math.floor(Number(input.quantity) || 1));
  const phone = normPhone(input.phone);
  if (phone.length < 10) throw new Error("Invalid phone number");

  // Duplicate guard 1: same customer + phone + product + qty in last 30 min (in memory)
  const key = [input.channel, input.customer_id, phone, product.product_id, qty].join("|");
  const hit = recent.get(key);
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return { ...hit.result, duplicate: true };

  const rows = await readSheetValues("Orders!A:Z");
  const header = rows[0]?.some((h) => h.trim()) ? rows[0] : DEFAULT_HEADER;
  const fields = header.map((h) => ALIASES[norm(h)] || norm(h));
  const col = (f: string) => fields.indexOf(f);
  const { ymd, stamp } = dhakaDate();

  // Duplicate guard 2: same phone + product + qty already in sheet today (survives restarts)
  for (const r of rows.slice(1)) {
    const oid = r[col("order_id")] || "";
    if (
      oid.includes(ymd) &&
      normPhone(r[col("phone")] || "") === phone &&
      (r[col("product_id")] || "").toLowerCase() === product.product_id.toLowerCase() &&
      Number(r[col("quantity")] || 0) === qty
    ) {
      const charge = Number(r[col("delivery_charge")] || 0);
      return {
        order_id: oid, duplicate: true, product_name: product.product_name, quantity: qty,
        unit_price: product.price, delivery_charge: charge, total: product.price * qty + charge,
      };
    }
  }

  const existing = new Set(rows.slice(1).map((r) => r[col("order_id")]));
  let order_id = "";
  do {
    order_id = `RP-${ymd}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
  } while (existing.has(order_id));

  const delivery_charge =
    input.delivery_area === "inside_dhaka" ? product.delivery_inside_dhaka : product.delivery_outside_dhaka;
  const total = product.price * qty + delivery_charge;
  const values: Record<string, string | number> = {
    order_id, created_at: stamp, channel: input.channel, customer_id: input.customer_id,
    customer_name: input.customer_name, phone: `'${phone}`, address: input.address,
    product_id: product.product_id, product_name: product.product_name, quantity: qty,
    unit_price: product.price, delivery_charge, delivery_area: input.delivery_area, total,
    status: "pending", note: input.note || "",
  };
  await appendSheetRow("Orders!A1", fields.map((f) => values[f] ?? ""));
  const result: OrderResult = {
    order_id, duplicate: false, product_name: product.product_name, quantity: qty,
    unit_price: product.price, delivery_charge, total,
  };
  recent.set(key, { at: Date.now(), result });
  console.log(`[order] created ${order_id} channel=${input.channel} product=${product.product_id} qty=${qty}`);
  return result;
}
