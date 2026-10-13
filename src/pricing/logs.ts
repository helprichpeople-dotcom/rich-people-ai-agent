// Negotiation_Logs tab: no PII, no message text, hashed conversation id.
import crypto from "node:crypto";
import { appendSheetRow } from "../sheets/client.js";

export type NegLogRow = {
  conversation: string; product_id: string; regular: number; offer: number | null; counter: number | null;
  final: number | null; status: string; human_needed: boolean;
};
type Appender = (range: string, row: (string | number)[]) => Promise<void>;
let appender: Appender = appendSheetRow;
export function setNegotiationLogAppender(a: Appender | null): void { appender = a || appendSheetRow; }

export const convHash = (key: string) => crypto.createHash("sha256").update(key).digest("hex").slice(0, 12);

export function negotiationLogValues(r: NegLogRow, now = Date.now()): (string | number)[] {
  const stamp = new Date(now + 6 * 3600_000).toISOString().slice(0, 19).replace("T", " ");
  const final = r.final ?? "";
  const discount = r.final ? r.regular - r.final : "";
  return [stamp, convHash(r.conversation), r.product_id, r.regular, r.offer ?? "", r.counter ?? "", final, discount, r.status, r.human_needed ? "TRUE" : "FALSE"];
}

export function logNegotiation(r: NegLogRow): void {
  void appender("Negotiation_Logs!A1", negotiationLogValues(r)).catch((err) =>
    console.warn("[negotiation] log write failed:", err instanceof Error ? err.message : err)
  );
}
