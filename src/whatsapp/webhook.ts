import crypto from "node:crypto";
import type { Request, Response } from "express";
import { askGrok } from "../ai/grok.js";
import { loadProducts } from "../sheets/products.js";
import { loadSettings } from "../sheets/settings.js";

const VERIFY_TOKEN =
  process.env.WHATSAPP_VERIFY_TOKEN || process.env.MESSENGER_VERIFY_TOKEN || "";
const APP_SECRET =
  process.env.WHATSAPP_APP_SECRET || process.env.MESSENGER_APP_SECRET || "";
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || "";
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || "";
const GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION || "v21.0";

export function verifyWhatsAppWebhook(req: Request, res: Response): void {
  const mode = String(req.query["hub.mode"] || "");
  const token = String(req.query["hub.verify_token"] || "");
  const challenge = String(req.query["hub.challenge"] || "");
  if (mode === "subscribe" && VERIFY_TOKEN && token === VERIFY_TOKEN) {
    res.status(200).send(challenge);
    return;
  }
  res.sendStatus(403);
}

function validSignature(req: Request): boolean {
  if (!APP_SECRET) return false;
  const header = String(req.header("x-hub-signature-256") || "");
  const expected =
    "sha256=" +
    crypto.createHmac("sha256", APP_SECRET).update(req.rawBody || "").digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected));
  } catch {
    return false;
  }
}

async function graphPost(phoneNumberId: string, payload: unknown): Promise<void> {
  if (!ACCESS_TOKEN) throw new Error("WHATSAPP_ACCESS_TOKEN নেই");
  const r = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${ACCESS_TOKEN}`,
    },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`WhatsApp send failed: ${r.status} ${body}`);
  }
}

async function sendWhatsAppText(phoneNumberId: string, to: string, text: string): Promise<void> {
  await graphPost(phoneNumberId, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to,
    type: "text",
    text: { preview_url: false, body: text.slice(0, 4096) },
  });
}

async function markRead(phoneNumberId: string, messageId: string): Promise<void> {
  try {
    await graphPost(phoneNumberId, {
      messaging_product: "whatsapp",
      status: "read",
      message_id: messageId,
    });
  } catch {
    /* non-fatal */
  }
}

type WaMessage = {
  from?: string;
  id?: string;
  type?: string;
  text?: { body?: string };
  button?: { text?: string };
  interactive?: {
    button_reply?: { title?: string };
    list_reply?: { title?: string };
  };
};

function extractText(m: WaMessage): string | undefined {
  if (m.type === "text") return m.text?.body;
  if (m.type === "button") return m.button?.text;
  if (m.type === "interactive")
    return m.interactive?.button_reply?.title || m.interactive?.list_reply?.title;
  return undefined;
}

const seen = new Set<string>();

export async function handleWhatsAppEvent(req: Request, res: Response): Promise<void> {
  if (!validSignature(req)) {
    res.sendStatus(403);
    return;
  }
  res.sendStatus(200);

  const body = req.body as {
    object?: string;
    entry?: Array<{
      changes?: Array<{
        field?: string;
        value?: {
          metadata?: { phone_number_id?: string };
          messages?: WaMessage[];
        };
      }>;
    }>;
  };
  if (body.object !== "whatsapp_business_account") return;

  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      if (change.field !== "messages") continue;
      const value = change.value || {};
      const phoneNumberId = value.metadata?.phone_number_id || PHONE_NUMBER_ID;
      for (const m of value.messages || []) {
        const from = m.from;
        if (!from || !phoneNumberId) continue;
        if (m.id) {
          if (seen.has(m.id)) continue;
          seen.add(m.id);
          if (seen.size > 1000) seen.clear();
          void markRead(phoneNumberId, m.id);
        }
        const text = extractText(m);
        try {
          if (!text) {
            await sendWhatsAppText(
              phoneNumberId,
              from,
              "দুঃখিত, এখন শুধু লেখা (text) মেসেজ বুঝতে পারি। অনুগ্রহ করে লিখে জানান।"
            );
            continue;
          }
          const [products, settings] = await Promise.all([loadProducts(), loadSettings()]);
          const reply = await askGrok({ userMessage: text, products, settings });
          await sendWhatsAppText(phoneNumberId, from, reply);
        } catch (err) {
          console.error("WhatsApp handle error:", err);
          try {
            await sendWhatsAppText(
              phoneNumberId,
              from,
              "এখন উত্তর দিতে সমস্যা হচ্ছে। একটু পরে আবার চেষ্টা করুন।"
            );
          } catch {
            /* ignore */
          }
        }
      }
    }
  }
}
