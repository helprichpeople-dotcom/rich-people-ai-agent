import crypto from "node:crypto";
import express, { type Request, type Response, type NextFunction } from "express";
import { readSheetValues, updateSheetCell } from "./sheets/client.js";
import { clearHandoff, listHandoffs } from "./memory.js";

const STATUSES = ["pending", "confirmed", "shipped", "cancelled"];
const COOKIE = "rp_admin";
const norm = (s: string) => s.trim().toLowerCase().replace(/[\s-]+/g, "_");
const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function sessionValue(): string {
  return crypto.createHmac("sha256", process.env.ADMIN_TOKEN || "").update("rp-admin-session").digest("hex");
}
function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function getCookie(req: Request, name: string): string {
  const m = (req.headers.cookie || "").split(";").map((c) => c.trim()).find((c) => c.startsWith(name + "="));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : "";
}
function authed(req: Request): boolean {
  return !!process.env.ADMIN_TOKEN && safeEq(getCookie(req, COOKIE), sessionValue());
}
function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (authed(req)) return next();
  res.redirect("/admin/login");
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="bn"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
body{font-family:system-ui,'Noto Sans Bengali',sans-serif;margin:0;background:#f5f5f7;color:#222}
header{background:#1a1a2e;color:#fff;padding:12px 16px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px}
header a{color:#ffd166;text-decoration:none;margin-left:12px}
main{padding:12px;max-width:1100px;margin:auto}
.card{background:#fff;border-radius:10px;padding:12px;margin-bottom:10px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.row{display:flex;flex-wrap:wrap;gap:6px 14px;font-size:14px}
.badge{display:inline-block;padding:2px 8px;border-radius:12px;font-size:12px;background:#eee}
.pending{background:#fff3cd}.confirmed{background:#d1ecf1}.shipped{background:#d4edda}.cancelled{background:#f8d7da}
input,select,button{font-size:15px;padding:8px;border-radius:6px;border:1px solid #ccc}
button{background:#1a1a2e;color:#fff;border:0;cursor:pointer}
form.inline{display:inline-flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.msg{padding:10px;border-radius:6px;background:#d4edda;margin-bottom:10px}.err{background:#f8d7da}
</style></head><body>${body}</body></html>`;
}
function nav(): string {
  return `<header><b>Rich People Admin · অ্যাডমিন</b><nav><a href="/admin">Orders / অর্ডার</a><a href="/admin/support">Support / সাপোর্ট</a><a href="/admin/logout">Logout</a></nav></header>`;
}

async function loadSheet(name: string): Promise<{ header: string[]; fields: string[]; rows: string[][] }> {
  const all = await readSheetValues(`${name}!A:Z`);
  const header = all[0] || [];
  return { header, fields: header.map(norm), rows: all.slice(1) };
}
function colLetter(i: number): string {
  let s = "";
  for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}
const statusIdx = (fields: string[]) => fields.findIndex((f) => f === "status" || f === "order_status");

export const adminRouter = express.Router();
adminRouter.use(express.urlencoded({ extended: false }));
adminRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Robots-Tag", "noindex");
  next();
});

adminRouter.get("/login", (req, res) => {
  const bad = req.query.e ? `<div class="msg err">ভুল টোকেন / Invalid token</div>` : "";
  const off = process.env.ADMIN_TOKEN ? "" : `<div class="msg err">ADMIN_TOKEN not configured on server.</div>`;
  res.send(page("Admin Login", `<main style="max-width:380px;margin-top:10vh"><div class="card"><h2>অ্যাডমিন লগইন<br><small>Admin Login</small></h2>${bad}${off}
<form method="post" action="/admin/login"><input type="password" name="token" placeholder="Admin token / টোকেন" style="width:100%;box-sizing:border-box" autofocus required><br><br><button style="width:100%">Login / প্রবেশ</button></form></div></main>`));
});
adminRouter.post("/login", (req, res) => {
  const t = String(req.body?.token || "");
  const real = process.env.ADMIN_TOKEN || "";
  if (!real || !safeEq(t, real)) return res.redirect("/admin/login?e=1");
  res.setHeader("Set-Cookie", `${COOKIE}=${sessionValue()}; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=${7 * 86400}`);
  res.redirect("/admin");
});
adminRouter.get("/logout", (_req, res) => {
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
  res.redirect("/admin/login");
});

adminRouter.get("/", requireAuth, async (req, res) => {
  const fStatus = String(req.query.status || "");
  const fChannel = String(req.query.channel || "");
  const q = String(req.query.q || "").toLowerCase();
  const flash = req.query.ok ? `<div class="msg">✅ ${esc(req.query.ok)}</div>` : req.query.err ? `<div class="msg err">${esc(req.query.err)}</div>` : "";
  try {
    const { header, fields, rows } = await loadSheet("Orders");
    const si = statusIdx(fields), ci = fields.indexOf("channel"), oi = fields.findIndex((f) => f === "order_id" || f === "id");
    const channels = [...new Set(rows.map((r) => r[ci] || "").filter(Boolean))];
    const list = rows
      .map((r, i) => ({ r, sheetRow: i + 2 }))
      .filter(({ r }) => r.some((c) => c))
      .filter(({ r }) => !fStatus || (r[si] || "pending").toLowerCase() === fStatus)
      .filter(({ r }) => !fChannel || (r[ci] || "") === fChannel)
      .filter(({ r }) => !q || r.join(" ").toLowerCase().includes(q))
      .reverse();
    const opt = (v: string, cur: string, label = v) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(label)}</option>`;
    const filters = `<form class="card row" method="get">
<select name="status">${opt("", fStatus, "All status / সব")}${STATUSES.map((s) => opt(s, fStatus)).join("")}</select>
<select name="channel">${opt("", fChannel, "All channels / সব চ্যানেল")}${channels.map((c) => opt(c, fChannel)).join("")}</select>
<input name="q" value="${esc(q)}" placeholder="Search phone/name/ID"><button>Filter / ফিল্টার</button></form>`;
    const cards = list.map(({ r, sheetRow }) => {
      const st = (r[si] || "pending").toLowerCase();
      const details = header.map((h, i) => (i === si || !r[i] ? "" : `<span><b>${esc(h)}:</b> ${esc(r[i])}</span>`)).join("");
      return `<div class="card"><div><b>${esc(r[oi] || `Row ${sheetRow}`)}</b> <span class="badge ${esc(st)}">${esc(st)}</span></div>
<div class="row" style="margin-top:6px">${details}</div>
<form class="inline" method="post" action="/admin/orders/status"><input type="hidden" name="row" value="${sheetRow}"><input type="hidden" name="order_id" value="${esc(r[oi] || "")}">
<select name="status">${STATUSES.map((s) => opt(s, st)).join("")}</select><button>Update / আপডেট</button></form></div>`;
    }).join("");
    res.send(page("Orders", `${nav()}<main>${flash}<h2>অর্ডার / Orders (${list.length})</h2>${filters}${si < 0 ? `<div class="msg err">No status column in Orders sheet header.</div>` : ""}${cards || `<div class="card">কোনো অর্ডার নেই / No orders</div>`}</main>`));
  } catch (e) {
    res.status(500).send(page("Error", `${nav()}<main><div class="msg err">Sheets error: ${esc((e as Error).message)}</div></main>`));
  }
});

adminRouter.post("/orders/status", requireAuth, async (req, res) => {
  const status = String(req.body?.status || "");
  const row = Number(req.body?.row);
  const orderId = String(req.body?.order_id || "");
  if (!STATUSES.includes(status) || !Number.isInteger(row) || row < 2) return res.redirect("/admin?err=Invalid+request");
  try {
    const { fields, rows } = await loadSheet("Orders");
    const si = statusIdx(fields), oi = fields.findIndex((f) => f === "order_id" || f === "id");
    if (si < 0) return res.redirect("/admin?err=No+status+column");
    // Safety: verify row still holds the same order (sheet may have shifted)
    let target = row;
    if (orderId && oi >= 0 && (rows[row - 2]?.[oi] || "") !== orderId) {
      const idx = rows.findIndex((r) => r[oi] === orderId);
      if (idx < 0) return res.redirect("/admin?err=Order+not+found");
      target = idx + 2;
    }
    await updateSheetCell(`Orders!${colLetter(si)}${target}`, status);
    console.log(`[admin] order ${orderId || "row " + target} -> ${status}`);
    res.redirect(`/admin?ok=${encodeURIComponent(`${orderId || "Row " + target} → ${status}`)}`);
  } catch (e) {
    res.redirect(`/admin?err=${encodeURIComponent((e as Error).message)}`);
  }
});

adminRouter.get("/support", requireAuth, async (req, res) => {
  const flash = req.query.ok ? `<div class="msg">✅ ${esc(req.query.ok)}</div>` : "";
  const paused = listHandoffs();
  const pausedHtml = paused.length
    ? paused.map((p) => `<div class="card row"><span><b>${esc(p.key)}</b> — until ${esc(new Date(p.until + 6 * 3600e3).toISOString().slice(0, 16).replace("T", " "))} (Dhaka)</span>
<form class="inline" method="post" action="/admin/handoff/clear" style="margin:0"><input type="hidden" name="key" value="${esc(p.key)}"><button>Resume bot / বট চালু</button></form></div>`).join("")
    : `<div class="card">কোনো পজ নেই / No paused conversations</div>`;
  let sheetHtml = "";
  try {
    const { header, rows } = await loadSheet("Support");
    sheetHtml = rows.slice(-50).reverse().map((r) => `<div class="card row">${header.map((h, i) => `<span><b>${esc(h)}:</b> ${esc(r[i])}</span>`).join("")}</div>`).join("") || `<div class="card">Empty</div>`;
  } catch {
    sheetHtml = `<div class="card">Support sheet not found (optional).</div>`;
  }
  res.send(page("Support", `${nav()}<main>${flash}<h2>হিউম্যান সাপোর্ট / Human handoff</h2>
<p style="font-size:13px">বট পজ মেমরিতে থাকে; সার্ভার রিস্টার্ট হলে সব পজ মুছে যায়। Pauses are in-memory and also clear on server restart/redeploy.</p>
${pausedHtml}
<form class="card inline" method="post" action="/admin/handoff/clear"><select name="channel"><option>messenger</option><option>whatsapp</option></select><input name="id" placeholder="PSID / phone" required><button>Clear pause / পজ মুছুন</button></form>
<h3>Support sheet (latest 50)</h3>${sheetHtml}</main>`));
});

adminRouter.post("/handoff/clear", requireAuth, (req, res) => {
  const key = String(req.body?.key || "") || `${String(req.body?.channel || "messenger")}:${String(req.body?.id || "").trim()}`;
  clearHandoff(key);
  console.log(`[admin] handoff cleared ${key}`);
  res.redirect(`/admin/support?ok=${encodeURIComponent("Cleared " + key)}`);
});
