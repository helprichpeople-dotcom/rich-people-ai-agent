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
