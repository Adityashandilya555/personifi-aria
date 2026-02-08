# Aria Travel Guide

AI-powered travel guide character with human-like conversation using Groq Llama 3.3-70B.

## Features
- 🗣️ Character.AI-like conversational personality
- 🔐 Multi-layer prompt injection protection
- 👥 Multi-user session management
- 📍 Google Places integration
- 💬 Telegram bot interface

## Quick Start

```bash
# 1. Clone and configure
cp .env.example .env
# Edit .env with your API keys

# 2. Set up database
psql "$DATABASE_URL" < database/schema.sql

# 3. Deploy
docker-compose up -d

# 4. Set Telegram webhook
curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d "url=https://your-server:3000/webhook/telegram"
```

## Monthly Costs
- DigitalOcean Droplet: $12
- PostgreSQL: $15
- Groq API: ~$1-5 (usage-based)

## Files
```
├── src/
│   ├── index.ts          # Fastify server + Telegram webhook
│   └── character/
│       ├── handler.ts    # Main message orchestrator
│       ├── sanitize.ts   # Input sanitization
│       ├── output-filter.ts
│       └── session-store.ts
├── config/
│   └── SOUL.md           # Aria's personality
├── database/
│   └── schema.sql        # PostgreSQL tables
└── docker-compose.yml
```
