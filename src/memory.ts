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
