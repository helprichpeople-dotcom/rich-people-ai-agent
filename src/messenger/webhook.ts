import crypto from "node:crypto";
import type { Request, Response } from "express";
import { askGrokWithMedia } from "../ai/grok.js";
import { config } from "../config.js";
import { deliverProductMedia } from "../media/deliver.js";
import { fetchImageBytes, handleInboundImage } from "../media/match.js";
import type { FetchFn } from "../media/validate.js";
import { isHandedOff } from "../memory.js";
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

export function buildMessengerImagePayload(psid: string, imageUrl: string) {
  return {
    recipient: { id: psid },
    messaging_type: "RESPONSE",
    message: { attachment: { type: "image", payload: { url: imageUrl, is_reusable: true } } },
  };
}

export async function sendMessengerImage(psid: string, imageUrl: string, fetchFn: FetchFn = fetch as FetchFn): Promise<void> {
  if (!PAGE_ACCESS_TOKEN) throw new Error("MESSENGER_PAGE_ACCESS_TOKEN নেই");
  const url = `https://graph.facebook.com/v21.0/me/messages?access_token=${encodeURIComponent(PAGE_ACCESS_TOKEN)}`;
  const r = await fetchFn(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildMessengerImagePayload(psid, imageUrl)),
  });
  if (!r.ok) throw new Error(`Messenger image send failed: ${r.status} ${await r.text()}`);
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
        message?: { text?: string; is_echo?: boolean; attachments?: Array<{ type?: string; payload?: { url?: string } }> };
      }>;
    }>;
  };
  if (body.object !== "page") return;

  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      const psid = event.sender?.id;
      const text = event.message?.text;
      if (!psid || event.message?.is_echo) continue;
      const img = (event.message?.attachments || []).find((a) => a.type === "image" && a.payload?.url);
      if (img && !text) {
        try {
          if (isHandedOff(`messenger:${psid}`)) continue;
          await handleMessengerImage(psid, img.payload!.url!);
        } catch (err) {
          console.error("Messenger image handle error:", err);
        }
        continue;
      }
      if (!text) continue;
      try {
        const [products, settings] = await Promise.all([loadProducts(), loadSettings()]);
        if (isHandedOff(`messenger:${psid}`)) {
          console.log(`[handoff] bot paused for messenger:${psid}; message left for human`);
          continue;
        }
        const reply = await askGrokWithMedia({ userMessage: text, products, settings, channel: "messenger", customerId: psid });
        await sendMessengerText(psid, reply.text);
        if (reply.media.length) {
          const results = await deliverProductMedia({
            media: reply.media,
            products,
            enabled: config.mediaSendEnabled,
            sendImage: (imageUrl) => sendMessengerImage(psid, imageUrl),
          });
          console.log(`[media] messenger:${psid}`, JSON.stringify(results));
        }
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

/** Inbound image: match against Products and reply (and send product image if enabled). */
export async function handleMessengerImage(
  psid: string,
  imageUrl: string,
  deps: { fetchFn?: FetchFn; sendText?: (t: string) => Promise<void>; sendImage?: (u: string) => Promise<void>; products?: Awaited<ReturnType<typeof loadProducts>> } = {}
) {
  const products = deps.products ?? (await loadProducts());
  const bytes = await fetchImageBytes(imageUrl, deps.fetchFn);
  const result = await handleInboundImage({ bytes, sourceUrl: imageUrl, products, fetchFn: deps.fetchFn });
  console.log(`[image-in] messenger:${psid} matched=${result.product?.product_id || "none"}`);
  await (deps.sendText ?? ((t) => sendMessengerText(psid, t)))(result.text);
  if (result.product) {
    await deliverProductMedia({
      media: [{ type: "product_image", product_id: result.product.product_id }],
      products,
      enabled: config.mediaSendEnabled,
      fetchFn: deps.fetchFn,
      sendImage: deps.sendImage ?? ((u) => sendMessengerImage(psid, u)),
    });
  }
  return result;
}
