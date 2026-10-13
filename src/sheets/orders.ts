import crypto from "node:crypto";
import { appendSheetRow, readSheetValues } from "./client.js";
import type { Product } from "../types/catalog.js";
import { getPricingConfig } from "../pricing/config.js";

export type OrderInput = {
  channel: string;
  customer_id: string;
  customer_name: string;
  phone: string;
  address: string;
  /** Single-item (legacy) form. */
  product_id?: string;
  quantity?: number;
  /** Multi-item form. Delivery charge is applied ONCE per order. */
  items?: { product_id: string; quantity: number }[];
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
  /** true when the appended row(s) were read back from the Orders sheet. */
  verified?: boolean;
  items?: { product_id: string; product_name: string; quantity: number; unit_price: number; regular_price: number; line_total: number }[];
};

type SheetIO = { read: typeof readSheetValues; append: typeof appendSheetRow };
let io: SheetIO = { read: readSheetValues, append: appendSheetRow };
export function setOrderSheetIO(x: SheetIO | null): void { io = x || { read: readSheetValues, append: appendSheetRow }; }

export type UnitPriceFn = (p: Product) => number;

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
export function clearRecentOrders(): void { recent.clear(); }

export function createOrder(input: OrderInput, products: Product[], unitPrice?: UnitPriceFn): Promise<OrderResult> {
  const run = lock.then(() => doCreate(input, products, unitPrice));
  lock = run.catch(() => undefined);
  return run;
}

async function doCreate(input: OrderInput, products: Product[], unitPrice?: UnitPriceFn): Promise<OrderResult> {
  const rawItems = input.items?.length ? input.items : [{ product_id: String(input.product_id || ""), quantity: Number(input.quantity) || 1 }];
  const merged = new Map<string, number>();
  for (const it of rawItems) {
    const product = products.find((p) => p.product_id.toLowerCase() === String(it.product_id).trim().toLowerCase());
    if (!product) throw new Error(`Unknown product_id: ${it.product_id}`);
    merged.set(product.product_id, (merged.get(product.product_id) || 0) + Math.max(1, Math.floor(Number(it.quantity) || 1)));
  }
  const phone = normPhone(input.phone);
  if (phone.length < 10) throw new Error("Invalid phone number");
  const lines = [...merged.entries()].map(([pid, qty]) => {
    const product = products.find((p) => p.product_id === pid)!;
    const pc = getPricingConfig(product);
    const regular = pc.ok ? pc.cfg.regular : pc.regular;
    const unit = unitPrice ? unitPrice(product) : regular;
    if (!(unit > 0)) throw new Error(`Invalid unit price for ${pid}`);
    return { product, qty, unit, regular };
  });

  // Duplicate guard 1: same customer + phone + items in last 30 min (in memory)
  const key = [input.channel, input.customer_id, phone, ...lines.map((l) => `${l.product.product_id}x${l.qty}`).sort()].join("|");
  const hit = recent.get(key);
  if (hit && Date.now() - hit.at < 30 * 60 * 1000) return { ...hit.result, duplicate: true };

  const rows = await io.read("Orders!A:Z");
  const header = rows[0]?.some((h) => h.trim()) ? rows[0] : DEFAULT_HEADER;
  const fields = header.map((h) => ALIASES[norm(h)] || norm(h));
  const col = (f: string) => fields.indexOf(f);
  const { ymd, stamp } = dhakaDate();
  const delivery_charge =
    input.delivery_area === "inside_dhaka" ? lines[0].product.delivery_inside_dhaka : lines[0].product.delivery_outside_dhaka;
  // Delivery once per order: highest single-product charge for the chosen area.
  const charge = Math.max(...lines.map((l) => (input.delivery_area === "inside_dhaka" ? l.product.delivery_inside_dhaka : l.product.delivery_outside_dhaka)), delivery_charge);
  const subtotal = lines.reduce((a, l) => a + l.unit * l.qty, 0);
  const total = subtotal + charge;
  const summaryItems = lines.map((l) => ({ product_id: l.product.product_id, product_name: l.product.product_name, quantity: l.qty, unit_price: l.unit, regular_price: l.regular, line_total: l.unit * l.qty }));

  // Duplicate guard 2: same phone + same item set already in sheet today (survives restarts)
  const today = new Map<string, string[][]>();
  for (const r of rows.slice(1)) {
    const oid = r[col("order_id")] || "";
    if (!oid.includes(ymd) || normPhone(r[col("phone")] || "") !== phone) continue;
    today.set(oid, [...(today.get(oid) || []), r]);
  }
  const want = lines.map((l) => `${l.product.product_id.toLowerCase()}x${l.qty}`).sort().join(",");
  for (const [oid, rs] of today) {
    const got = rs.map((r) => `${(r[col("product_id")] || "").toLowerCase()}x${Number(r[col("quantity")] || 0)}`).sort().join(",");
    if (got === want) {
      return {
        order_id: oid, duplicate: true, product_name: lines.map((l) => l.product.product_name).join(", "), quantity: lines.reduce((a, l) => a + l.qty, 0),
        unit_price: lines[0].unit, delivery_charge: charge, total, items: summaryItems,
      };
    }
  }

  const existing = new Set(rows.slice(1).map((r) => r[col("order_id")]));
  let order_id = "";
  do {
    order_id = `RP-${ymd}-${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
  } while (existing.has(order_id));

  for (const [i, l] of lines.entries()) {
    const discount = (l.regular - l.unit) * l.qty;
    const values: Record<string, string | number> = {
      order_id, created_at: stamp, channel: input.channel, customer_id: input.customer_id,
      customer_name: input.customer_name, phone: `'${phone}`, address: input.address,
      product_id: l.product.product_id, product_name: l.product.product_name, quantity: l.qty,
      unit_price: l.unit, regular_price: l.regular, discount: discount || 0,
      delivery_charge: i === 0 ? charge : 0, delivery_area: input.delivery_area,
      total: i === 0 ? total : 0,
      status: "pending",
      note: [input.note || "", discount ? `negotiated ${l.unit} (regular ${l.regular})` : "", lines.length > 1 ? `item ${i + 1}/${lines.length}; order total on first row` : ""].filter(Boolean).join("; "),
    };
    await io.append("Orders!A1", fields.map((f) => values[f] ?? ""));
  }
  let verified = false;
  try {
    const after = await io.read("Orders!A:Z");
    verified = after.slice(1).filter((r) => (r[col("order_id")] || "") === order_id).length === lines.length;
  } catch (err) {
    console.error(`[order] verify read failed for ${order_id}:`, err instanceof Error ? err.message : err);
  }
  if (!verified) console.warn(`[order] ${order_id} could not be verified after write`);
  const result: OrderResult = {
    order_id, duplicate: false, product_name: lines.map((l) => l.product.product_name).join(", "), quantity: lines.reduce((a, l) => a + l.qty, 0),
    unit_price: lines[0].unit, delivery_charge: charge, total, verified, items: summaryItems,
  };
  recent.set(key, { at: Date.now(), result });
  console.log(`[order] created ${order_id} channel=${input.channel} items=${lines.map((l) => `${l.product.product_id}x${l.qty}@${l.unit}`).join(",")}`);
  return result;
}
