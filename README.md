# Rich People AI Agent (ধাপ ৩)

Google Sheets + Grok ইন্টিগ্রেশন স্ক্যাফোল্ড।

## কোন সফটওয়্যার
- Terminal (Mac)
- এই ফোল্ডার: `Desktop/RichPeopleAI/agent`

## এখন যা করা হয়েছে
- Node.js প্রজেক্ট
- Sheets থেকে Products/Settings পড়ার কোড
- Grok উত্তর তৈরির কোড (key লাগবে পরে)
- `.env.example`

## আপনার পরবর্তী কাজ (key চাইব না এখন)
1. Terminal খুলুন
2. চালান:

```bash
cd ~/Desktop/RichPeopleAI/agent
export PATH="$HOME/.local/bin:$PATH"
cp .env.example .env
npm install
npm run build
```

`npm run test:sheets` এখন ব্যর্থ হবে যতক্ষণ না Google Service Account JSON বসানো হয় — সেটা পরবর্তী ছোট ধাপে করব।

## WhatsApp (Cloud API)

Webhook: `GET/POST /webhook/whatsapp` (Meta callback: `https://rich-people-ai-agent.onrender.com/webhook/whatsapp`, field `messages`).

Env (set in `.env` locally and in Render; never commit):
- `WHATSAPP_ACCESS_TOKEN` – Cloud API token
- `WHATSAPP_PHONE_NUMBER_ID` – sender phone number ID
- `WHATSAPP_BUSINESS_ACCOUNT_ID` – WABA ID (reference)
- `WHATSAPP_VERIFY_TOKEN` – optional; falls back to `MESSENGER_VERIFY_TOKEN`
- `WHATSAPP_APP_SECRET` – optional; falls back to `MESSENGER_APP_SECRET` (same Meta app)
