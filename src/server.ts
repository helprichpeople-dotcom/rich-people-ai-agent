import express from "express";
import { handleMessengerEvent, verifyWebhook } from "./messenger/webhook.js";
import { handleWhatsAppEvent, verifyWhatsAppWebhook } from "./whatsapp/webhook.js";
import { adminRouter } from "./admin.js";
import { dataDeletion, privacyPolicy, terms } from "./legal.js";

const app = express();
app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: string }).rawBody = buf.toString("utf8");
    },
  })
);

app.get("/webhook/messenger", verifyWebhook);
app.post("/webhook/messenger", (req, res) => {
  void handleMessengerEvent(req, res);
});

app.get("/webhook/whatsapp", verifyWhatsAppWebhook);
app.post("/webhook/whatsapp", (req, res) => {
  void handleWhatsAppEvent(req, res);
});

app.get("/privacy", privacyPolicy);
app.get("/privacy-policy", privacyPolicy);
app.get("/data-deletion", dataDeletion);
app.get("/terms", terms);
app.get("/", (_req, res) => res.redirect("/privacy"));

app.use("/admin", adminRouter);

app.get("/health", (_req, res) => res.json({ ok: true }));

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Rich People AI Agent listening on :${port}`);
});
