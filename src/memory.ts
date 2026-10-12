// Simple in-memory conversation memory + human-handoff flags (reset on restart).
type Msg = { role: "user" | "assistant"; content: string };
const histories = new Map<string, { msgs: Msg[]; at: number }>();
const handoff = new Map<string, number>();
const TTL = 6 * 60 * 60 * 1000;
const HANDOFF_MS = Number(process.env.HANDOFF_PAUSE_MINUTES || 120) * 60 * 1000;

export function getHistory(key: string): Msg[] {
  const h = histories.get(key);
  if (!h || Date.now() - h.at > TTL) return [];
  return h.msgs;
}
export function pushHistory(key: string, msg: Msg): void {
  const h = histories.get(key);
  const msgs = h && Date.now() - h.at < TTL ? h.msgs : [];
  msgs.push(msg);
  while (msgs.length > 20) msgs.shift();
  histories.set(key, { msgs, at: Date.now() });
}
export function clearHistory(key: string): void {
  histories.delete(key);
}
export function setHandoff(key: string): void {
  handoff.set(key, Date.now() + HANDOFF_MS);
}
export function isHandedOff(key: string): boolean {
  const until = handoff.get(key);
  if (!until) return false;
  if (Date.now() > until) {
    handoff.delete(key);
    return false;
  }
  return true;
}
export function clearHandoff(key: string): void {
  handoff.delete(key);
}
export function listHandoffs(): { key: string; until: number }[] {
  const now = Date.now();
  return [...handoff.entries()].filter(([, u]) => u > now).map(([key, until]) => ({ key, until }));
}

// ---- Per-conversation product/conversation state (in-memory, same TTL as history) ----
export type ConvState = {
  active_product_id?: string;
  product_source?: "ad" | "text" | "image" | "ad_ambiguous";
  shown_product_ids: string[];
  updated_at: number;
  [k: string]: unknown;
};
const states = new Map<string, ConvState>();

export function getState(key: string, now = Date.now()): ConvState {
  const s = states.get(key);
  if (!s || now - s.updated_at > TTL) return { shown_product_ids: [], updated_at: now };
  return s;
}
export function setState(key: string, patch: Partial<ConvState>, now = Date.now()): ConvState {
  const next = { ...getState(key, now), ...patch, updated_at: now } as ConvState;
  states.set(key, next);
  if (states.size > 10000) for (const [k, v] of states) if (now - v.updated_at > TTL) states.delete(k);
  return next;
}
export function setActiveProduct(key: string, productId: string, source: ConvState["product_source"], now = Date.now()): ConvState {
  const s = getState(key, now);
  const shown = s.shown_product_ids.includes(productId) ? s.shown_product_ids : [...s.shown_product_ids, productId];
  return setState(key, { active_product_id: productId, product_source: source, shown_product_ids: shown }, now);
}
export function clearState(key: string): void {
  states.delete(key);
}

/** Time-windowed message-id dedupe shared by channels (Meta retries). */
const seenIds = new Map<string, number>();
export function isDuplicateMessageId(id: string | undefined, now = Date.now(), windowMs = 6 * 3600_000): boolean {
  if (!id) return false;
  const at = seenIds.get(id);
  if (at !== undefined && now - at < windowMs) return true;
  seenIds.set(id, now);
  if (seenIds.size > 20000) for (const [k, v] of seenIds) if (now - v > windowMs) seenIds.delete(k);
  return false;
}
export function clearSeenMessageIds(): void {
  seenIds.clear();
}
