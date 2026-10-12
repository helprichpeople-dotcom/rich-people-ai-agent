// Extract Facebook/Instagram ad referral ids from Messenger and WhatsApp webhook payloads.
export type MessengerEventLike = {
  referral?: { ad_id?: string; ref?: string; source?: string };
  postback?: { referral?: { ad_id?: string; ref?: string; source?: string } };
  message?: { referral?: { ad_id?: string; ref?: string; source?: string } };
};

/** Messenger: referral (messaging_referrals), message.referral, postback.referral. Returns ad_id (or ref). */
export function extractMessengerReferral(e: MessengerEventLike): string | undefined {
  const r = e.referral || e.message?.referral || e.postback?.referral;
  const id = r?.ad_id || r?.ref;
  return id ? String(id).trim() : undefined;
}

export type WaReferralLike = { referral?: { source_id?: string; source_type?: string; source_url?: string } };

/** WhatsApp Click-to-WhatsApp ad: messages[].referral.source_id (source_type "ad"). */
export function extractWhatsAppReferral(m: WaReferralLike): string | undefined {
  const r = m.referral;
  if (!r?.source_id) return undefined;
  if (r.source_type && r.source_type !== "ad" && r.source_type !== "post") return undefined;
  return String(r.source_id).trim();
}
