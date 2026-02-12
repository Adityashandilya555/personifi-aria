#!/bin/bash
# Aria Travel Guide - Interactive Setup Script
# Run after SSH into server: ./setup.sh

echo "🌍 Aria Travel Guide - Setup"
echo "============================"
echo ""

# Create .env if doesn't exist
if [ ! -f .env ]; then
    cp .env.example .env
    echo "Created .env from template"
fi

echo "Configure your API keys (press Enter to skip):"
echo ""

# ─── Core Services ─────────────────────────────────────────────────────────

# Groq API Key
read -p "📦 Groq API Key (console.groq.com): " GROQ_KEY
if [ -n "$GROQ_KEY" ]; then
    sed -i.bak "s|GROQ_API_KEY=.*|GROQ_API_KEY=$GROQ_KEY|" .env
    echo "   ✅ Groq configured"
fi

# Database URL
read -p "🗄️  PostgreSQL URL: " DB_URL
if [ -n "$DB_URL" ]; then
    sed -i.bak "s|DATABASE_URL=.*|DATABASE_URL=$DB_URL|" .env
    echo "   ✅ Database configured"
fi

# Google Places
read -p "📍 Google Places API Key: " PLACES_KEY
if [ -n "$PLACES_KEY" ]; then
    sed -i.bak "s|GOOGLE_PLACES_API_KEY=.*|GOOGLE_PLACES_API_KEY=$PLACES_KEY|" .env
    echo "   ✅ Google Places configured"
fi

# ─── Embedding Services ───────────────────────────────────────────────────

echo ""
echo "🧠 Embedding Services (for memory & graph):"
echo ""

# Jina AI
read -p "🔗 Jina AI API Key (jina.ai, 1M tokens free): " JINA_KEY
if [ -n "$JINA_KEY" ]; then
    sed -i.bak "s|JINA_API_KEY=.*|JINA_API_KEY=$JINA_KEY|" .env
    echo "   ✅ Jina AI configured (primary embeddings)"
fi

# HuggingFace
read -p "🤗 HuggingFace API Key (huggingface.co, fallback): " HF_KEY
if [ -n "$HF_KEY" ]; then
    sed -i.bak "s|HF_API_KEY=.*|HF_API_KEY=$HF_KEY|" .env
    echo "   ✅ HuggingFace configured (fallback embeddings)"
fi

# ─── Channel Configuration ────────────────────────────────────────────────

echo ""
echo "📱 Channel Configuration:"
echo ""

# Telegram
read -p "🤖 Telegram Bot Token (@BotFather): " TG_TOKEN
if [ -n "$TG_TOKEN" ]; then
    sed -i.bak "s|TELEGRAM_BOT_TOKEN=.*|TELEGRAM_BOT_TOKEN=$TG_TOKEN|" .env
    sed -i.bak "s|TELEGRAM_ENABLED=.*|TELEGRAM_ENABLED=true|" .env
    echo "   ✅ Telegram configured"
fi

# WhatsApp
read -p "💬 WhatsApp API Token (optional): " WA_TOKEN
if [ -n "$WA_TOKEN" ]; then
    sed -i.bak "s|WHATSAPP_API_TOKEN=.*|WHATSAPP_API_TOKEN=$WA_TOKEN|" .env
    sed -i.bak "s|WHATSAPP_ENABLED=.*|WHATSAPP_ENABLED=true|" .env
    echo "   ✅ WhatsApp configured"
fi

read -p "💬 WhatsApp Phone Number ID (optional): " WA_PHONE_ID
if [ -n "$WA_PHONE_ID" ]; then
    sed -i.bak "s|WHATSAPP_PHONE_ID=.*|WHATSAPP_PHONE_ID=$WA_PHONE_ID|" .env
fi

# Slack
read -p "💼 Slack Bot Token (optional): " SLACK_TOKEN
if [ -n "$SLACK_TOKEN" ]; then
    sed -i.bak "s|SLACK_BOT_TOKEN=.*|SLACK_BOT_TOKEN=$SLACK_TOKEN|" .env
    sed -i.bak "s|SLACK_ENABLED=.*|SLACK_ENABLED=true|" .env
    echo "   ✅ Slack configured"
fi

read -p "💼 Slack Signing Secret (optional): " SLACK_SECRET
if [ -n "$SLACK_SECRET" ]; then
    sed -i.bak "s|SLACK_SIGNING_SECRET=.*|SLACK_SIGNING_SECRET=$SLACK_SECRET|" .env
fi

# ─── Feature Toggles ──────────────────────────────────────────────────────

echo ""
echo "⚙️  Feature Toggles (defaults are fine for most setups):"
echo ""
echo "  PROACTIVE_NUDGES_ENABLED=true    (daily travel nudges)"
echo "  DAILY_TIPS_ENABLED=true          (daily travel tips)"
echo "  BROWSER_SCRAPING_ENABLED=true    (Playwright for web scraping)"
echo "  LINK_CODE_EXPIRY_MINUTES=10      (cross-channel link code TTL)"
echo ""
echo "  Edit .env to change these."

# Cleanup backup files
rm -f .env.bak

echo ""
echo "✨ Configuration complete!"
echo ""
echo "Next steps:"
echo "  1. Run database migrations (in order):"
echo "     psql \"\$DATABASE_URL\" < database/schema.sql"
echo "     psql \"\$DATABASE_URL\" < database/memory.sql"
echo "     psql \"\$DATABASE_URL\" < database/vector.sql"
echo "     psql \"\$DATABASE_URL\" < database/conversation-goals.sql"
echo "     psql \"\$DATABASE_URL\" < database/memory-blocks.sql"
echo "     psql \"\$DATABASE_URL\" < database/proactive.sql"
echo "     psql \"\$DATABASE_URL\" < database/identity.sql"
echo ""
echo "  2. Start the server:"
echo "     docker-compose up -d"
echo ""
echo "  3. Set up webhooks:"

# Show webhook setup commands based on what was configured
if [ -n "$TG_TOKEN" ]; then
    echo ""
    echo "  Telegram:"
    echo "    curl \"https://api.telegram.org/bot$TG_TOKEN/setWebhook?url=https://YOUR_SERVER:3000/webhook/telegram\""
fi

echo ""
echo "🌍 Aria is ready to explore the world with you!"
