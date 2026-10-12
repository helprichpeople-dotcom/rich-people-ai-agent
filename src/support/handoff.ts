import { appendSheetRow } from "../sheets/client.js";
import { setHandoff } from "../memory.js";

// Marks the conversation as handed to a human (bot pauses) and records it.
export async function requestHuman(params: {
  channel: string;
  customer_id: string;
  reason: string;
}): Promise<void> {
  setHandoff(`${params.channel}:${params.customer_id}`);
  const stamp = new Date(Date.now() + 6 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " ");
  console.log(`[HUMAN HANDOFF] ${stamp} channel=${params.channel} customer=${params.customer_id} reason=${params.reason}`);
  // Optional: if a "Support" sheet exists (columns: created_at, channel, customer_id, reason, status), record it.
  try {
    await appendSheetRow("Support!A1", [stamp, params.channel, params.customer_id, params.reason, "open"]);
  } catch {
    console.log("[HUMAN HANDOFF] Support sheet not found; logged only.");
  }
}

export const DEFAULT_WHATSAPP_CONTACT = "+8801604139500";

/** Resolves Rich People's real WhatsApp number from Settings (whatsapp_contact / business_whatsapp), else default. */
export function resolveWhatsAppContact(settings: Record<string, string> = {}): { number: string; link: string } {
  const candidates = [settings.whatsapp_contact, settings.business_whatsapp];
  let digits = "";
  for (const c of candidates) {
    const d = String(c || "").replace(/\D/g, "");
    if (d.length >= 10) { digits = d; break; }
  }
  if (!digits) digits = DEFAULT_WHATSAPP_CONTACT.replace(/\D/g, "");
  if (digits.startsWith("01") && digits.length === 11) digits = "88" + digits;
  return { number: `+${digits}`, link: `https://wa.me/${digits}` };
}

/** Bangla handoff reply pointing the customer to Rich People's WhatsApp. */
export function humanSupportReply(settings: Record<string, string> = {}): string {
  const { number, link } = resolveWhatsAppContact(settings);
  return `অবশ্যই! Rich People-এর একজন প্রতিনিধির সাথে সরাসরি কথা বলতে আমাদের WhatsApp-এ কল বা মেসেজ করুন: ${link} (${number})। আমাদের টিম শীঘ্রই আপনাকে সাহায্য করবে।`;
}
