# Security Audit & Deployment Checklist (Step 7)
_Audit date / তারিখ: 2026-10-12 (Asia/Dhaka)_ — Service: https://rich-people-ai-agent.onrender.com

## ✅ Checklist / চেকলিস্ট
| Test | Expected | Result |
|---|---|---|
| `GET /health` | 200 | ✅ 200 |
| `GET /privacy` | 200 | ✅ 200 |
| `GET /admin` | redirect to login | ✅ 302 → /admin/login |
| `GET /webhook/messenger` (no token) | 403 | ✅ 403 |
| Messenger verify, wrong token | 403 | ✅ 403 |
| WhatsApp verify, wrong token | 403 | ✅ 403 |
| Secrets in repo (.env, keys, SA JSON, tokens) — current tree + full git history | none | ✅ none found |
| `.gitignore` covers `.env`, `secrets/`, `node_modules/`, `*.log` | yes | ✅ |
| Render logs last 24h | no repeated errors | ⚠️ see below |

### Logs (24h) / লগ
- ❌ `create_order` → Google Sheets `The caller does not have permission` — Service Account-কে Sheet-এ **Editor** দেওয়া হয়নি। Orders save হচ্ছে না।
- ⚠️ 1× WhatsApp send 400 (test phone-number ID `123456123`) — একবারই, test data থেকে; real WA config লাগবে।
- Secrets logs-এ leak হয়নি (gaxios Authorization redacted)।

## ⚠️ Remaining risks / বাকি ঝুঁকি
1. **ADMIN_TOKEN** — single static token; শক্তিশালী (32+ random chars) রাখুন, নিয়মিত rotate করুন, কখনো share করবেন না।
2. **Service Account Editor** — Sheet-এ SA email কে Editor দিন (শুধু ওই Sheet-এ, Drive-wide নয়)।
3. **WhatsApp Business Verification (BV)** — verify না হলে limited/test numbers only; real phone-number ID ও permanent token সেট করুন।
4. **Render free plan sleep** — ১৫ মিনিট idle হলে sleep; প্রথম webhook ধীর (~30-60s), Meta retry/timeout হতে পারে। Paid plan বা uptime ping বিবেচনা করুন।
5. **Handoff memory** — human-handoff state in-memory; restart/sleep/redeploy হলে হারায়। Persist (Postgres/Key-Value) করুন।

## 🔒 Recommended next hardening / পরবর্তী পদক্ষেপ
- Verify `X-Hub-Signature-256` (Meta app secret) on every webhook POST.
- Rate-limit `/admin/login` & webhooks; secure/HttpOnly/SameSite cookies.
- Move handoff/session state to Render Key-Value or Postgres.
- Upgrade to paid instance (no sleep) before real launch.
- Enable GitHub secret scanning + Dependabot; run `npm audit` in CI.
- Rotate Meta/OpenAI/SA keys periodically; least-privilege SA.
- Add alerting on error-level logs.
