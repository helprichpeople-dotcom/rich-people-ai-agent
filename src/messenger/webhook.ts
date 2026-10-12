import crypto from "node:crypto";
import type { Request, Response } from "express";
import { grokVisionMatch } from "../ai/grok.js";
import { applyReferral, handleCustomerText } from "../conversation/pipeline.js";
import { extractMessengerReferral, type MessengerEventLike } from "../conversation/referral.js";
import { getCatalog } from "../sheets/catalog.js";
import { config } from "../config.js";
import { deliverProductMedia } from "../media/deliver.js";
import { fetchImageBytes, handleInboundImage, type VisionMatcher } from "../media/match.js";
import type { FetchFn } from "../media/validate.js";
import { isHandedOff, setActiveProduct } from "../memory.js";
import type { Product } from "../types/catalog.js";

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

const seenMids = new Map<string, number>();
/** Meta can redeliver the same message (retries / duplicate entries); handle each mid once. */
export function isDuplicateMid(mid?: string, now = Date.now()): boolean {
  if (!mid) return false;
  if (seenMids.has(mid)) return true;
  seenMids.set(mid, now);
  if (seenMids.size > 5000) for (const [k, v] of seenMids) if (now - v > 3600_000) seenMids.delete(k);
  return false;
}
export function clearSeenMids(): void { seenMids.clear(); }

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
      messaging?: Array<MessengerEventLike & {
        sender?: { id?: string };
        message?: { mid?: string; text?: string; is_echo?: boolean; attachments?: Array<{ type?: string; payload?: { url?: string } }> };
      }>;
    }>;
  };
  if (body.object !== "page") return;

  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      const psid = event.sender?.id;
      const text = event.message?.text;
      if (!psid || event.message?.is_echo) continue;
      const refId = extractMessengerReferral(event);
      if (isDuplicateMid(event.message?.mid)) {
        console.log(`[messenger] duplicate mid ignored ${event.message?.mid}`);
        continue;
      }
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
      if (!text) {
        if (refId) {
          try {
            applyReferral("messenger", psid, refId, await getCatalog());
          } catch (err) {
            console.error("Messenger referral error:", err);
          }
        }
        continue;
      }
      try {
        const reply = await handleCustomerText({ channel: "messenger", customerId: psid, text, referralId: refId });
        if (!reply) continue;
        const products = reply.catalog.products;
        await sendMessengerText(psid, reply.text);
        if (reply.media.length) {
          const results = await deliverProductMedia({
            media: reply.media,
            products,
            enabled: config.mediaSendEnabled,
            recipientKey: `messenger:${psid}`,
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
  deps: { fetchFn?: FetchFn; sendText?: (t: string) => Promise<void>; sendImage?: (u: string) => Promise<void>; products?: Product[]; vision?: VisionMatcher | null } = {}
) {
  const products = deps.products ?? (await getCatalog()).products;
  const bytes = await fetchImageBytes(imageUrl, deps.fetchFn);
  const result = await handleInboundImage({ bytes, sourceUrl: imageUrl, products, fetchFn: deps.fetchFn, vision: deps.vision !== undefined ? deps.vision : config.imageVisionEnabled ? (b, ps) => grokVisionMatch(b, ps) : null });
  console.log(`[image-in] messenger:${psid} matched=${result.product?.product_id || "none"} method=${result.method || "-"} score=${result.score ?? "-"} bytes=${bytes ? "ok" : "none"}`);
  await (deps.sendText ?? ((t) => sendMessengerText(psid, t)))(result.text);
  if (result.product) {
    setActiveProduct(`messenger:${psid}`, result.product.product_id, "image");
    await deliverProductMedia({
      media: [{ type: "product_image", product_id: result.product.product_id }],
      products,
      enabled: config.mediaSendEnabled,
      fetchFn: deps.fetchFn,
      recipientKey: `messenger:${psid}`,
      sendImage: deps.sendImage ?? ((u) => sendMessengerImage(psid, u)),
    });
  }
  return result;
}
