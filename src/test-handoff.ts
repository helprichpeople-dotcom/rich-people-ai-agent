// Mock test: request_human -> Bangla WhatsApp reply + bot pause. No network, no customer messages.
import assert from "node:assert/strict";
process.env.GOOGLE_SERVICE_ACCOUNT_JSON_CONTENT = "";
process.env.GOOGLE_SERVICE_ACCOUNT_JSON = "/nonexistent.json";
const { askGrokWithMedia } = await import("./ai/grok.js");
const { isHandedOff, clearHandoff } = await import("./memory.js");
const { resolveWhatsAppContact, humanSupportReply } = await import("./support/handoff.js");

assert.equal(resolveWhatsAppContact({}).link, "https://wa.me/8801604139500");
assert.equal(resolveWhatsAppContact({ whatsapp_contact: "01604139500" }).number, "+8801604139500");
assert.equal(resolveWhatsAppContact({ business_whatsapp: "+880 1604-139500" }).link, "https://wa.me/8801604139500");
assert.match(humanSupportReply({}), /wa\.me\/8801604139500/);

let systemPrompt = "";
let toolResult = "";
let step = 0;
const client: any = {
  chat: { completions: { create: async (req: any) => {
    step++;
    if (step === 1) {
      systemPrompt = req.messages[0].content;
      return { choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "request_human", arguments: JSON.stringify({ reason: "wants human" }) } }] } }] };
    }
    toolResult = req.messages.at(-1).content;
    return { choices: [{ message: { role: "assistant", content: JSON.parse(toolResult).message.split("Suggested reply: ")[1] } }] };
  } } },
};
const settings = { whatsapp_contact: "+8801604139500" };
const r = await askGrokWithMedia({ userMessage: "আমি মানুষের সাথে কথা বলতে চাই", products: [], settings, channel: "messenger", customerId: "mock-psid", client } as any);
assert.match(systemPrompt, /wa\.me\/8801604139500/);
assert.match(toolResult, /wa\.me\/8801604139500/);
assert.match(r.text, /WhatsApp/);
assert.match(r.text, /wa\.me\/8801604139500/);
assert.ok(isHandedOff("messenger:mock-psid"), "bot should be paused");
clearHandoff("messenger:mock-psid");
console.log("Reply:", r.text);
console.log("PASS test-handoff");
