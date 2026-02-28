# Aria Travel Guide

AI-powered travel guide character with **proactive features** using Groq Llama 3.3-70B.

## Features
- 🗣️ Character.AI-like conversational personality
- ⏰ **Proactive messaging** (nudges after 1hr inactivity, daily tips)
- 🌐 **Browser automation** (scrape flights, restaurant availability, deals)
- 🔐 Multi-layer prompt injection protection
- 👥 Multi-user session management
- 📍 Google Places integration
- 🧠 **Memory & Personalization** (learns user preferences from conversation)

## Proactive Features

| Feature | Schedule | What it does |
|---------|----------|--------------|
| Inactivity nudge | Every 15min check | Message users after 1hr silence |
| Daily tips | 9 AM daily | Send local travel tip |
| Weekly deals | Sunday 10 AM | Scrape and share travel deals |

## Quick Start

```bash
# 1. Configure
cp .env.example .env
# Edit with your API keys

# 2. Set up database
psql "$DATABASE_URL" < database/schema.sql
psql "$DATABASE_URL" < database/proactive.sql
psql "$DATABASE_URL" < database/memory.sql
psql "$DATABASE_URL" < database/pulse.sql

# 3. Deploy
docker-compose up -d

# 4. Set Telegram webhook
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook?url=https://your-server:3000/webhook/telegram"
```

## Requirements

- **4GB+ Droplet** (browser automation needs memory)
- PostgreSQL database
- API Keys: Groq, Telegram, Google Places

## Files
```
├── src/
│   ├── index.ts              # Fastify + webhook + startup
│   ├── scheduler.ts          # Cron jobs for proactive messages
│   ├── browser.ts            # Playwright scraping
│   ├── memory.ts             # Preference extraction & personalization
│   ├── character/            # Handler, sanitize, sessions
│   ├── types/                # TypeScript type definitions
│   └── examples/             # Demo scripts
├── config/SOUL.md            # Aria persona
├── database/
│   ├── schema.sql            # Core tables
│   ├── proactive.sql         # Proactive messaging tables
│   ├── memory.sql            # Memory & personalization tables
│   └── pulse.sql             # Engagement scoring state (Pulse)
├── docs/
│   └── MEMORY_SYSTEM.md      # Memory system documentation
└── docker-compose.yml
```

## Monthly Costs
- DigitalOcean 4GB Droplet: $24
- PostgreSQL: $15
- Groq API: ~$1-5
- **Total: ~$40-45/mo**
