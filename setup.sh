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

# Google Places
read -p "📍 Google Places API Key: " PLACES_KEY
if [ -n "$PLACES_KEY" ]; then
    sed -i.bak "s|GOOGLE_PLACES_API_KEY=.*|GOOGLE_PLACES_API_KEY=$PLACES_KEY|" .env
    echo "   ✅ Google Places configured"
fi

# Cleanup backup files
rm -f .env.bak

echo ""
echo "✨ Configuration complete!"
echo ""
echo "Next steps:"
echo "  1. Run database migrations:"
echo "     psql \"\$DATABASE_URL\" < database/schema.sql"
echo "     psql \"\$DATABASE_URL\" < database/proactive.sql"
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
