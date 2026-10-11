import crypto from "node:crypto";
import type { Request, Response } from "express";
import { askGrok } from "../ai/grok.js";
import { loadProducts } from "../sheets/products.js";
import { loadSettings } from "../sheets/settings.js";

const VERIFY_TOKEN = process.env.MESSENGER_VERIFY_TOKEN || "";
const APP_SECRET = process.env.MESSENGER_APP_SECRET || "";
const PAGE_ACCESS_TOKEN = process.env.MESSENGER_PAGE_ACCESS_TOKEN || "";

export function verifyWebhook(req: Request, res: Response): void {
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

async function sendMessengerText(psid: string, text: string): Promise<void> {
  if (!PAGE_ACCESS_TOKEN) throw new Error("MESSENGER_PAGE_ACCESS_TOKEN নেই");
  const url = `https://graph.facebook.com/v21.0/me/messages?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { id: psid },
      messaging_type: "RESPONSE",
      message: { text: text.slice(0, 2000) },
    }),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Messenger send failed: ${r.status} ${body}`);
  }
}

export async function handleMessengerEvent(req: Request, res: Response): Promise<void> {
  if (!validSignature(req)) {
    res.sendStatus(403);
    return;
  }
  res.sendStatus(200);

  const body = req.body as {
    object?: string;
    entry?: Array<{
      messaging?: Array<{
        sender?: { id?: string };
        message?: { text?: string; is_echo?: boolean };
      }>;
    }>;
  };
  if (body.object !== "page") return;

  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      const psid = event.sender?.id;
      const text = event.message?.text;
      if (!psid || !text || event.message?.is_echo) continue;
      try {
        const [products, settings] = await Promise.all([loadProducts(), loadSettings()]);
        const reply = await askGrok({ userMessage: text, products, settings });
        await sendMessengerText(psid, reply);
      } catch (err) {
        console.error("Messenger handle error:", err);
        try {
          await sendMessengerText(psid, "এখন উত্তর দিতে সমস্যা হচ্ছে। একটু পরে আবার চেষ্টা করুন।");
        } catch {
          /* ignore */
        }
      }
    }
  }
}
