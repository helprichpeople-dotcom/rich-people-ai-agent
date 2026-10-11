import express from "express";
import { handleMessengerEvent, verifyWebhook } from "./messenger/webhook.js";

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

app.get("/health", (_req, res) => res.json({ ok: true }));

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Rich People AI Agent listening on :${port}`);
});
