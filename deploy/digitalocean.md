# Aria Travel Guide - DigitalOcean Deployment Guide

Complete step-by-step guide to deploy Aria for beta testing.

## Prerequisites

- [ ] DigitalOcean account with billing configured
- [ ] Domain name (optional, but recommended for webhooks)
- [ ] API keys ready:
  - Groq API key (`console.groq.com`)
  - Telegram Bot Token (`@BotFather` on Telegram)
  - Google Places API key (Google Cloud Console)

## Step 1: Install doctl CLI

```bash
# macOS
brew install doctl

# Authenticate
doctl auth init
# Paste your DigitalOcean API token when prompted
# Get token from: https://cloud.digitalocean.com/account/api/tokens
```

## Step 2: Create Managed PostgreSQL

```bash
# Create database (~2 min to provision)
doctl databases create aria-db \
  --engine pg \
  --version 16 \
  --size db-s-1vcpu-1gb \
  --region blr1 \
  --num-nodes 1

# Wait for it to be ready
doctl databases list

# Get connection string (save this!)
doctl databases connection aria-db --format URI
# Example: postgresql://doadmin:PASSWORD@aria-db-do-user-xxx.db.ondigitalocean.com:25060/defaultdb?sslmode=require
```

## Step 3: Create Droplet

```bash
# Create 4GB Droplet with Docker pre-installed
doctl compute droplet create aria-beta \
  --image docker-20-04 \
  --size s-2vcpu-4gb \
  --region blr1 \
  --ssh-keys $(doctl compute ssh-key list --format ID --no-header | head -1)

# Get Droplet IP
doctl compute droplet list --format Name,PublicIPv4
```

If you don't have SSH keys configured:
```bash
# Add your SSH key first
doctl compute ssh-key create my-key --public-key "$(cat ~/.ssh/id_rsa.pub)"
```

## Step 4: Point Domain (Optional but Recommended)

In your DNS provider, add an A record:
```
Type: A
Name: aria (or @ for root)
Value: YOUR_DROPLET_IP
TTL: 300
```

## Step 5: SSH to Droplet and Deploy

```bash
# SSH into server
ssh root@YOUR_DROPLET_IP

# Clone your repo
git clone https://github.com/Adityashandilya555/personifi-aria.git
cd personifi-aria

# Create .env file
cp .env.example .env
nano .env
```

Edit `.env` with your values:
```env
# Core (REQUIRED)
GROQ_API_KEY=gsk_your_actual_key
DATABASE_URL=postgresql://doadmin:PASSWORD@your-db-host:25060/defaultdb?sslmode=require
GOOGLE_PLACES_API_KEY=AIzaSy...

# Telegram (REQUIRED for beta)
TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=123456789:ABCdefGHI...

# Server
PORT=3000
NODE_ENV=production
```

## Step 6: Setup Database

```bash
# Run migrations
psql "$DATABASE_URL" < database/schema.sql
psql "$DATABASE_URL" < database/proactive.sql
```

If psql is not installed:
```bash
apt update && apt install -y postgresql-client
```

## Step 7: Deploy with Docker

Option A - Without custom domain (HTTP only):
```bash
docker-compose up -d --build
```

Option B - With custom domain (HTTPS):
```bash
docker-compose -f deploy/docker-compose.prod.yml up -d --build
```

## Step 8: Set Telegram Webhook

```bash
# Replace with your bot token and domain/IP
curl "https://api.telegram.org/botYOUR_BOT_TOKEN/setWebhook?url=https://your-domain.com/webhook/telegram"

# For IP-based (no HTTPS - not recommended):
curl "https://api.telegram.org/botYOUR_BOT_TOKEN/setWebhook?url=http://YOUR_DROPLET_IP:3000/webhook/telegram"
```

> **Note:** Telegram requires HTTPS for webhooks unless you're testing locally. For IP-based testing, use polling instead or set up Caddy for automatic HTTPS.

## Step 9: Verify Deployment

```bash
# Check health
curl http://YOUR_DROPLET_IP:3000/health

# Expected response:
# {"status":"ok","character":"aria","proactive":true,"channels":["telegram"]}

# Check logs
docker logs -f aria-travel-guide
```

## Step 10: Test the Bot

1. Open Telegram
2. Search for your bot name (the one you created with @BotFather)
3. Send `/start`
4. You should receive Aria's welcome message!

---

## Quick Reference

| Command | Purpose |
|---------|---------|
| `docker-compose up -d` | Start Aria |
| `docker-compose down` | Stop Aria |
| `docker-compose logs -f` | View live logs |
| `docker-compose restart` | Restart after .env changes |
| `docker-compose pull && docker-compose up -d` | Update to latest |

## Troubleshooting

### "Connection refused" to database
- Check DATABASE_URL format includes `?sslmode=require`
- Verify database is in same region as droplet
- Add droplet IP to database trusted sources in DO console

### Bot not responding
```bash
# Check if container is running
docker ps

# Check logs for errors
docker logs aria-travel-guide --tail 100
```

### Webhook not working
```bash
# Verify webhook is set
curl "https://api.telegram.org/botYOUR_TOKEN/getWebhookInfo"

# Should show your URL, no errors
```

---

## Monthly Costs

| Resource | Cost |
|----------|------|
| 4GB Droplet | $24 |
| PostgreSQL | $15 |
| Groq API | ~$1-5 |
| **Total** | **~$40-45** |
