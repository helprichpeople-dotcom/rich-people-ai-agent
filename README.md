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
