import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

export const config = {
  sheetsId: process.env.GOOGLE_SHEETS_ID || "",
  googleServiceAccountJson:
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "./secrets/google-service-account.json",
  grokApiKey: process.env.GROK_API_KEY || "",
  grokModel: process.env.GROK_MODEL || "grok-4.20-0309-non-reasoning",
  grokVisionModel: process.env.GROK_VISION_MODEL || process.env.GROK_MODEL || "grok-4.20-0309-non-reasoning",
  /** Inbound image vision fallback (Grok). ON unless "false". */
  imageVisionEnabled: String(process.env.IMAGE_VISION_ENABLED || "true").trim().toLowerCase() !== "false",
  grokBaseUrl: process.env.GROK_BASE_URL || "https://api.x.ai/v1",
  /** Product image sending. OFF unless explicitly "true". */
  mediaSendEnabled: String(process.env.MEDIA_SEND_ENABLED || "").trim().toLowerCase() === "true",
};

export function assertSheetsConfig(): void {
  if (!config.sheetsId) {
    throw new Error("GOOGLE_SHEETS_ID সেট নেই। .env ফাইল দেখুন।");
  }
}

export function assertGrokConfig(): void {
  if (!config.grokApiKey) {
    throw new Error("GROK_API_KEY সেট নেই। .env ফাইল দেখুন।");
  }
}
