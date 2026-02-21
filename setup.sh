#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════════
# Aria Travel Guide — Interactive Setup & Management Script
# ═══════════════════════════════════════════════════════════════════════════════
#
# Features:
#   • Color-coded key status dashboard (set ✅ / missing ❌)
#   • Set only missing keys (skip already-configured ones)
#   • Set a specific key by name
#   • Validate API keys with live smoke tests
#   • Docker container management (start/stop/status)
#
# Usage:  ./setup.sh
# ═══════════════════════════════════════════════════════════════════════════════

set -euo pipefail

# ─── Colors & Symbols ─────────────────────────────────────────────────────────
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
GRAY='\033[0;90m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'
CHECK="${GREEN}✅${RESET}"
CROSS="${RED}❌${RESET}"
WARN="${YELLOW}⚠️${RESET}"
BULLET="${CYAN}▸${RESET}"

# ─── .env Bootstrap ───────────────────────────────────────────────────────────
ENV_FILE=".env"
ENV_EXAMPLE=".env.example"

if [ ! -f "$ENV_FILE" ]; then
    if [ -f "$ENV_EXAMPLE" ]; then
        cp "$ENV_EXAMPLE" "$ENV_FILE"
        echo -e "${CHECK} Created ${BOLD}.env${RESET} from ${ENV_EXAMPLE}"
    else
        echo -e "${CROSS} No .env or .env.example found! Create one first."
        exit 1
    fi
fi

# ─── Key Definitions ─────────────────────────────────────────────────────────
# Format: "KEY_NAME|Description|required/optional"
# Grouped by category for the dashboard.

CORE_KEYS=(
    "GROQ_API_KEY|Groq LLM (console.groq.com)|required"
    "GEMINI_API_KEY|Google Gemini (LLM fallback)|required"
    "DATABASE_URL|PostgreSQL connection URL|required"
    "GOOGLE_PLACES_API_KEY|Google Places API|required"
)

CHANNEL_KEYS=(
    "TELEGRAM_BOT_TOKEN|Telegram Bot (@BotFather)|optional"
    "WHATSAPP_API_TOKEN|WhatsApp Business API|optional"
    "WHATSAPP_PHONE_ID|WhatsApp Phone Number ID|optional"
    "SLACK_BOT_TOKEN|Slack Bot Token|optional"
    "SLACK_SIGNING_SECRET|Slack Signing Secret|optional"
)

EMBEDDING_KEYS=(
    "JINA_API_KEY|Jina AI Embeddings (primary)|required"
    "HF_API_KEY|HuggingFace Embeddings (fallback)|optional"
)

TRAVEL_KEYS=(
    "AMADEUS_API_KEY|Amadeus Flights API|optional"
    "AMADEUS_API_SECRET|Amadeus API Secret|optional"
    "SERPAPI_KEY|SerpAPI (Google fallback)|optional"
    "RAPIDAPI_KEY|RapidAPI (Hotels/Reels/Scrapers)|required"
    "OPENWEATHERMAP_API_KEY|OpenWeatherMap API|optional"
)

MCP_KEYS=(
    "SWIGGY_MCP_TOKEN|Swiggy MCP Token|optional"
    "SWIGGY_MCP_REFRESH_TOKEN|Swiggy MCP Refresh Token|optional"
    "ZOMATO_MCP_CLIENT_ID|Zomato MCP Client ID|optional"
    "ZOMATO_MCP_CLIENT_SECRET|Zomato MCP Client Secret|optional"
    "ZOMATO_MCP_TOKEN|Zomato MCP Token|optional"
    "ZOMATO_MCP_REFRESH_TOKEN|Zomato MCP Refresh Token|optional"
)

# Known placeholder values (from .env.example defaults that aren't real keys)
PLACEHOLDER_PATTERNS="^$|^gsk_your_|^your_|^AIzaSy\.\.\.$|^postgresql://user:password@|^hf_your_|^jina_your_|^xoxb-\.\.\.$|^AIza$"

# ─── Helper Functions ─────────────────────────────────────────────────────────

get_env_value() {
    local key="$1"
    # Read value from .env, handling = in values correctly
    local val
    val=$(grep "^${key}=" "$ENV_FILE" 2>/dev/null | head -1 | sed "s/^${key}=//")
    echo "$val"
}

is_key_set() {
    local val="$1"
    # Empty or matches a placeholder pattern = not set
    if [ -z "$val" ]; then
        return 1
    fi
    if echo "$val" | grep -qE "$PLACEHOLDER_PATTERNS"; then
        return 1
    fi
    return 0
}

mask_value() {
    local val="$1"
    local len=${#val}
    if [ "$len" -le 8 ]; then
        echo "${val:0:2}***"
    elif [ "$len" -le 20 ]; then
        echo "${val:0:4}...${val: -3}"
    else
        echo "${val:0:6}...${val: -4}"
    fi
}

set_env_key() {
    local key="$1"
    local value="$2"
    # If key exists in .env, replace it; otherwise append
    if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
        # macOS-compatible sed (requires '' after -i)
        sed -i '' "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
    else
        echo "${key}=${value}" >> "$ENV_FILE"
    fi
}

print_header() {
    echo ""
    echo -e "${BOLD}${CYAN}═══════════════════════════════════════════════════════════════${RESET}"
    echo -e "${BOLD}${CYAN}  🌍 Aria Travel Guide — Setup & Management${RESET}"
    echo -e "${BOLD}${CYAN}═══════════════════════════════════════════════════════════════${RESET}"
    echo ""
}

# ─── Dashboard ────────────────────────────────────────────────────────────────

print_category() {
    local title="$1"
    shift
    local keys=("$@")
    local set_count=0
    local total=${#keys[@]}

    echo -e "  ${BOLD}${title}${RESET}"
    echo -e "  ${DIM}$(printf '─%.0s' {1..55})${RESET}"

    for entry in "${keys[@]}"; do
        IFS='|' read -r key desc importance <<< "$entry"
        local val
        val=$(get_env_value "$key")

        if is_key_set "$val"; then
            local masked
            masked=$(mask_value "$val")
            echo -e "    ${CHECK}  ${BOLD}${key}${RESET}"
            echo -e "       ${DIM}${desc} → ${GREEN}${masked}${RESET}"
            set_count=$((set_count + 1))
        else
            if [ "$importance" = "required" ]; then
                echo -e "    ${CROSS}  ${BOLD}${key}${RESET}  ${RED}(REQUIRED)${RESET}"
                echo -e "       ${DIM}${desc}${RESET}"
            else
                echo -e "    ${GRAY}⬚   ${key}${RESET}  ${GRAY}(optional)${RESET}"
                echo -e "       ${DIM}${desc}${RESET}"
            fi
        fi
    done
    echo -e "  ${DIM}${set_count}/${total} configured${RESET}"
    echo ""
}

show_dashboard() {
    echo ""
    echo -e "${BOLD}  📊 API Key Status Dashboard${RESET}"
    echo -e "  ${DIM}Keys are read from .env — set values are masked for security${RESET}"
    echo ""

    print_category "🔑 Core Services" "${CORE_KEYS[@]}"
    print_category "📱 Channels (enable at least one)" "${CHANNEL_KEYS[@]}"
    print_category "🧠 Embedding Services" "${EMBEDDING_KEYS[@]}"
    print_category "✈️  Travel Tools" "${TRAVEL_KEYS[@]}"
    print_category "🍽️  Food & Grocery MCP" "${MCP_KEYS[@]}"

    # Summary
    local total_set=0
    local total_required=0
    local required_set=0
    local all_keys=("${CORE_KEYS[@]}" "${CHANNEL_KEYS[@]}" "${EMBEDDING_KEYS[@]}" "${TRAVEL_KEYS[@]}" "${MCP_KEYS[@]}")

    for entry in "${all_keys[@]}"; do
        IFS='|' read -r key desc importance <<< "$entry"
        local val
        val=$(get_env_value "$key")
        if is_key_set "$val"; then
            total_set=$((total_set + 1))
        fi
        if [ "$importance" = "required" ]; then
            total_required=$((total_required + 1))
            if is_key_set "$val"; then
                required_set=$((required_set + 1))
            fi
        fi
    done

    echo -e "  ${BOLD}━━━ Summary ━━━${RESET}"
    echo -e "  Total keys configured: ${BOLD}${total_set}/${#all_keys[@]}${RESET}"
    if [ "$required_set" -eq "$total_required" ]; then
        echo -e "  Required keys:        ${CHECK} ${BOLD}${required_set}/${total_required}${RESET} — all set!"
    else
        echo -e "  Required keys:        ${CROSS} ${BOLD}${required_set}/${total_required}${RESET} — ${RED}some missing!${RESET}"
    fi
    echo ""
}

# ─── Set Missing Keys ────────────────────────────────────────────────────────

prompt_missing_keys() {
    local all_keys=("${CORE_KEYS[@]}" "${CHANNEL_KEYS[@]}" "${EMBEDDING_KEYS[@]}" "${TRAVEL_KEYS[@]}" "${MCP_KEYS[@]}")
    local missing_count=0

    # Count missing
    for entry in "${all_keys[@]}"; do
        IFS='|' read -r key desc importance <<< "$entry"
        local val
        val=$(get_env_value "$key")
        if ! is_key_set "$val"; then
            missing_count=$((missing_count + 1))
        fi
    done

    if [ "$missing_count" -eq 0 ]; then
        echo -e "  ${CHECK} All keys are already configured!"
        return
    fi

    echo ""
    echo -e "  ${BOLD}Setting missing keys${RESET} (${missing_count} missing — press Enter to skip any)"
    echo ""

    for entry in "${all_keys[@]}"; do
        IFS='|' read -r key desc importance <<< "$entry"
        local val
        val=$(get_env_value "$key")
        if ! is_key_set "$val"; then
            local label=""
            if [ "$importance" = "required" ]; then
                label="${RED}[REQUIRED]${RESET}"
            else
                label="${GRAY}[optional]${RESET}"
            fi
            echo -e "  ${BULLET} ${BOLD}${key}${RESET} ${label}"
            echo -e "    ${DIM}${desc}${RESET}"
            read -p "    Value: " new_val
            if [ -n "$new_val" ]; then
                set_env_key "$key" "$new_val"
                echo -e "    ${CHECK} Set!"
            else
                echo -e "    ${GRAY}   Skipped${RESET}"
            fi
            echo ""
        fi
    done
}

# ─── Set Specific Key ────────────────────────────────────────────────────────

set_specific_key() {
    local all_keys=("${CORE_KEYS[@]}" "${CHANNEL_KEYS[@]}" "${EMBEDDING_KEYS[@]}" "${TRAVEL_KEYS[@]}" "${MCP_KEYS[@]}")

    echo ""
    echo -e "  ${BOLD}Available keys:${RESET}"
    echo ""

    local i=1
    local key_names=()
    for entry in "${all_keys[@]}"; do
        IFS='|' read -r key desc importance <<< "$entry"
        local val
        val=$(get_env_value "$key")
        local status=""
        if is_key_set "$val"; then
            status="${CHECK}"
        else
            status="${CROSS}"
        fi
        printf "  ${status}  %2d) %-30s ${DIM}%s${RESET}\n" "$i" "$key" "$desc"
        key_names+=("$entry")
        i=$((i + 1))
    done

    echo ""
    read -p "  Enter number (or 0 to cancel): " choice
    if [ -z "$choice" ] || [ "$choice" = "0" ]; then
        return
    fi

    local idx=$((choice - 1))
    if [ "$idx" -lt 0 ] || [ "$idx" -ge "${#key_names[@]}" ]; then
        echo -e "  ${CROSS} Invalid selection"
        return
    fi

    IFS='|' read -r key desc importance <<< "${key_names[$idx]}"
    local current
    current=$(get_env_value "$key")
    if is_key_set "$current"; then
        local masked
        masked=$(mask_value "$current")
        echo -e "  Current value: ${GREEN}${masked}${RESET}"
    else
        echo -e "  Current value: ${RED}(not set)${RESET}"
    fi

    read -p "  New value for ${key}: " new_val
    if [ -n "$new_val" ]; then
        set_env_key "$key" "$new_val"
        echo -e "  ${CHECK} ${key} updated!"
    else
        echo -e "  ${GRAY}   Cancelled${RESET}"
    fi
}

# ─── Key Validation ───────────────────────────────────────────────────────────

validate_keys() {
    echo ""
    echo -e "  ${BOLD}🔬 Validating API Keys${RESET}"
    echo -e "  ${DIM}Testing configured keys with live API calls...${RESET}"
    echo ""

    local pass_count=0
    local fail_count=0
    local skip_count=0

    # --- Groq ---
    local groq_key
    groq_key=$(get_env_value "GROQ_API_KEY")
    if is_key_set "$groq_key"; then
        echo -ne "  ${BULLET} Groq API ... "
        local groq_resp
        groq_resp=$(curl -s -o /dev/null -w "%{http_code}" \
            -H "Authorization: Bearer ${groq_key}" \
            "https://api.groq.com/openai/v1/models" 2>/dev/null)
        if [ "$groq_resp" = "200" ]; then
            echo -e "${CHECK} Working (HTTP ${groq_resp})"
            pass_count=$((pass_count + 1))
        else
            echo -e "${CROSS} Failed (HTTP ${groq_resp})"
            fail_count=$((fail_count + 1))
        fi
    else
        echo -e "  ${GRAY}⬚  Groq API — not configured, skipped${RESET}"
        skip_count=$((skip_count + 1))
    fi

    # --- Gemini ---
    local gemini_key
    gemini_key=$(get_env_value "GEMINI_API_KEY")
    if is_key_set "$gemini_key"; then
        echo -ne "  ${BULLET} Gemini API ... "
        local gemini_resp
        gemini_resp=$(curl -s -o /dev/null -w "%{http_code}" \
            "https://generativelanguage.googleapis.com/v1beta/models?key=${gemini_key}" 2>/dev/null)
        if [ "$gemini_resp" = "200" ]; then
            echo -e "${CHECK} Working (HTTP ${gemini_resp})"
            pass_count=$((pass_count + 1))
        else
            echo -e "${CROSS} Failed (HTTP ${gemini_resp})"
            fail_count=$((fail_count + 1))
        fi
    else
        echo -e "  ${GRAY}⬚  Gemini API — not configured, skipped${RESET}"
        skip_count=$((skip_count + 1))
    fi

    # --- Database ---
    local db_url
    db_url=$(get_env_value "DATABASE_URL")
    if is_key_set "$db_url"; then
        echo -ne "  ${BULLET} PostgreSQL ... "
        if command -v pg_isready &>/dev/null; then
            # Extract host and port from URL
            local db_host db_port
            db_host=$(echo "$db_url" | sed -n 's|.*@\([^:]*\):.*|\1|p')
            db_port=$(echo "$db_url" | sed -n 's|.*:\([0-9]*\)/.*|\1|p')
            if pg_isready -h "$db_host" -p "${db_port:-5432}" -t 5 &>/dev/null; then
                echo -e "${CHECK} Reachable"
                pass_count=$((pass_count + 1))
            else
                echo -e "${CROSS} Unreachable (host: ${db_host}:${db_port:-5432})"
                fail_count=$((fail_count + 1))
            fi
        else
            # Fallback: try a simple connection via node if available
            if command -v node &>/dev/null; then
                local db_test
                db_test=$(node -e "
                    const { Client } = require('pg');
                    const c = new Client({ connectionString: '${db_url}' });
                    c.connect().then(() => { console.log('ok'); c.end(); }).catch(e => { console.log('fail:' + e.message); });
                " 2>/dev/null || echo "fail:node error")
                if echo "$db_test" | grep -q "^ok"; then
                    echo -e "${CHECK} Connected"
                    pass_count=$((pass_count + 1))
                else
                    echo -e "${CROSS} Connection failed"
                    fail_count=$((fail_count + 1))
                fi
            else
                echo -e "${WARN} Cannot test (no pg_isready or node available)"
                skip_count=$((skip_count + 1))
            fi
        fi
    else
        echo -e "  ${GRAY}⬚  PostgreSQL — not configured, skipped${RESET}"
        skip_count=$((skip_count + 1))
    fi

    # --- Google Places ---
    local gp_key
    gp_key=$(get_env_value "GOOGLE_PLACES_API_KEY")
    if is_key_set "$gp_key"; then
        echo -ne "  ${BULLET} Google Places ... "
        local gp_resp
        gp_resp=$(curl -s -o /dev/null -w "%{http_code}" \
            "https://places.googleapis.com/v1/places:searchText" \
            -H "Content-Type: application/json" \
            -H "X-Goog-Api-Key: ${gp_key}" \
            -H "X-Goog-FieldMask: places.displayName" \
            -d '{"textQuery":"coffee","maxResultCount":1}' 2>/dev/null)
        if [ "$gp_resp" = "200" ]; then
            echo -e "${CHECK} Working (HTTP ${gp_resp})"
            pass_count=$((pass_count + 1))
        else
            echo -e "${CROSS} Failed (HTTP ${gp_resp})"
            fail_count=$((fail_count + 1))
        fi
    else
        echo -e "  ${GRAY}⬚  Google Places — not configured, skipped${RESET}"
        skip_count=$((skip_count + 1))
    fi

    # --- OpenWeatherMap ---
    local owm_key
    owm_key=$(get_env_value "OPENWEATHERMAP_API_KEY")
    if is_key_set "$owm_key"; then
        echo -ne "  ${BULLET} OpenWeatherMap ... "
        local owm_resp
        owm_resp=$(curl -s -o /dev/null -w "%{http_code}" \
            "https://api.openweathermap.org/data/2.5/weather?q=London&units=metric&appid=${owm_key}" 2>/dev/null)
        if [ "$owm_resp" = "200" ]; then
            echo -e "${CHECK} Working (HTTP ${owm_resp})"
            pass_count=$((pass_count + 1))
        else
            echo -e "${CROSS} Failed (HTTP ${owm_resp})"
            fail_count=$((fail_count + 1))
        fi
    else
        echo -e "  ${GRAY}⬚  OpenWeatherMap — not configured, skipped${RESET}"
        skip_count=$((skip_count + 1))
    fi

    # --- Jina Embeddings ---
    local jina_key
    jina_key=$(get_env_value "JINA_API_KEY")
    if is_key_set "$jina_key"; then
        echo -ne "  ${BULLET} Jina Embeddings ... "
        local jina_resp
        jina_resp=$(curl -s -o /dev/null -w "%{http_code}" \
            "https://api.jina.ai/v1/embeddings" \
            -H "Content-Type: application/json" \
            -H "Authorization: Bearer ${jina_key}" \
            -d '{"model":"jina-embeddings-v3","input":["test"],"dimensions":768}' 2>/dev/null)
        if [ "$jina_resp" = "200" ]; then
            echo -e "${CHECK} Working (HTTP ${jina_resp})"
            pass_count=$((pass_count + 1))
        else
            echo -e "${CROSS} Failed (HTTP ${jina_resp})"
            fail_count=$((fail_count + 1))
        fi
    else
        echo -e "  ${GRAY}⬚  Jina Embeddings — not configured, skipped${RESET}"
        skip_count=$((skip_count + 1))
    fi

    # --- Amadeus ---
    local amadeus_key amadeus_secret
    amadeus_key=$(get_env_value "AMADEUS_API_KEY")
    amadeus_secret=$(get_env_value "AMADEUS_API_SECRET")
    if is_key_set "$amadeus_key" && is_key_set "$amadeus_secret"; then
        echo -ne "  ${BULLET} Amadeus Flights ... "
        local amadeus_resp
        amadeus_resp=$(curl -s -o /dev/null -w "%{http_code}" \
            -X POST "https://test.api.amadeus.com/v1/security/oauth2/token" \
            -d "grant_type=client_credentials&client_id=${amadeus_key}&client_secret=${amadeus_secret}" 2>/dev/null)
        if [ "$amadeus_resp" = "200" ]; then
            echo -e "${CHECK} Working (HTTP ${amadeus_resp})"
            pass_count=$((pass_count + 1))
        else
            echo -e "${CROSS} Failed (HTTP ${amadeus_resp})"
            fail_count=$((fail_count + 1))
        fi
    else
        echo -e "  ${GRAY}⬚  Amadeus Flights — not configured, skipped${RESET}"
        skip_count=$((skip_count + 1))
    fi

    # --- SerpAPI ---
    local serp_key
    serp_key=$(get_env_value "SERPAPI_KEY")
    if is_key_set "$serp_key"; then
        echo -ne "  ${BULLET} SerpAPI ... "
        local serp_resp
        serp_resp=$(curl -s -o /dev/null -w "%{http_code}" \
            "https://serpapi.com/account.json?api_key=${serp_key}" 2>/dev/null)
        if [ "$serp_resp" = "200" ]; then
            echo -e "${CHECK} Working (HTTP ${serp_resp})"
            pass_count=$((pass_count + 1))
        else
            echo -e "${CROSS} Failed (HTTP ${serp_resp})"
            fail_count=$((fail_count + 1))
        fi
    else
        echo -e "  ${GRAY}⬚  SerpAPI — not configured, skipped${RESET}"
        skip_count=$((skip_count + 1))
    fi

    # --- RapidAPI ---
    local rapid_key
    rapid_key=$(get_env_value "RAPIDAPI_KEY")
    if is_key_set "$rapid_key"; then
        echo -ne "  ${BULLET} RapidAPI ... "
        local rapid_resp
        rapid_resp=$(curl -s -o /dev/null -w "%{http_code}" \
            -H "X-RapidAPI-Key: ${rapid_key}" \
            -H "X-RapidAPI-Host: instagram-scraper-api2.p.rapidapi.com" \
            "https://instagram-scraper-api2.p.rapidapi.com/v1/info?username_or_id_or_url=instagram" 2>/dev/null)
        if [ "$rapid_resp" = "200" ]; then
            echo -e "${CHECK} Working (HTTP ${rapid_resp})"
            pass_count=$((pass_count + 1))
        elif [ "$rapid_resp" = "429" ]; then
            echo -e "${WARN} Key valid but rate limited (HTTP 429)"
            pass_count=$((pass_count + 1))
        elif [ "$rapid_resp" = "403" ] || [ "$rapid_resp" = "401" ]; then
            echo -e "${CROSS} Invalid key (HTTP ${rapid_resp})"
            fail_count=$((fail_count + 1))
        else
            echo -e "${WARN} Key set (${#rapid_key} chars) — HTTP ${rapid_resp}"
            skip_count=$((skip_count + 1))
        fi
    else
        echo -e "  ${GRAY}⬚  RapidAPI — not configured, skipped${RESET}"
        skip_count=$((skip_count + 1))
    fi

    # --- Telegram Bot ---
    local tg_token
    tg_token=$(get_env_value "TELEGRAM_BOT_TOKEN")
    if is_key_set "$tg_token"; then
        echo -ne "  ${BULLET} Telegram Bot ... "
        local tg_resp
        tg_resp=$(curl -s "https://api.telegram.org/bot${tg_token}/getMe" 2>/dev/null)
        if echo "$tg_resp" | grep -q '"ok":true'; then
            local bot_name
            bot_name=$(echo "$tg_resp" | grep -o '"username":"[^"]*"' | head -1 | sed 's/"username":"//;s/"//')
            echo -e "${CHECK} Working (@${bot_name})"
            pass_count=$((pass_count + 1))
        else
            echo -e "${CROSS} Invalid token"
            fail_count=$((fail_count + 1))
        fi
    else
        echo -e "  ${GRAY}⬚  Telegram Bot — not configured, skipped${RESET}"
        skip_count=$((skip_count + 1))
    fi

    echo ""
    echo -e "  ${BOLD}━━━ Results ━━━${RESET}"
    echo -e "  ${GREEN}Passed: ${pass_count}${RESET}  ${RED}Failed: ${fail_count}${RESET}  ${GRAY}Skipped: ${skip_count}${RESET}"
    echo ""
}

# ─── Project Setup ─────────────────────────────────────────────────────────────

install_deps() {
    echo ""
    echo -e "  ${BOLD}📦 Installing Dependencies${RESET}"
    echo ""

    # Check Node.js version
    if ! command -v node &>/dev/null; then
        echo -e "  ${CROSS} Node.js not found! Install v20+ from https://nodejs.org"
        return 1
    fi
    local node_ver
    node_ver=$(node -v | sed 's/v//' | cut -d. -f1)
    if [ "$node_ver" -lt 20 ]; then
        echo -e "  ${CROSS} Node.js v${node_ver} detected — need v20+ (for Blob/FormData)"
        echo -e "  ${DIM}The media pipeline requires Node 20+ for native FormData/Blob support${RESET}"
        return 1
    fi
    echo -e "  ${CHECK} Node.js v$(node -v | sed 's/v//') detected"

    # npm install
    echo -e "  ${BULLET} Running ${BOLD}npm install${RESET} ..."
    npm install 2>&1 | tail -3 | sed 's/^/    /'
    echo -e "  ${CHECK} Dependencies installed"

    # TypeScript build
    echo -e "  ${BULLET} Running ${BOLD}npm run build${RESET} ..."
    if npm run build 2>&1 | tail -3 | sed 's/^/    /'; then
        echo -e "  ${CHECK} TypeScript build successful"
    else
        echo -e "  ${CROSS} Build failed — check errors above"
        return 1
    fi
    echo ""
}

run_migrations() {
    echo ""
    echo -e "  ${BOLD}🗄️  Running Database Migrations${RESET}"
    echo ""

    local db_url
    db_url=$(get_env_value "DATABASE_URL")
    if ! is_key_set "$db_url"; then
        echo -e "  ${CROSS} DATABASE_URL not set — configure it first (menu option 2 or 3)"
        return 1
    fi

    # Check if migration file exists
    if [ -f "src/db/migrate.ts" ]; then
        echo -e "  ${BULLET} Running ${BOLD}npx tsx src/db/migrate.ts${RESET} ..."
        npx tsx src/db/migrate.ts 2>&1 | sed 's/^/    /'
        echo -e "  ${CHECK} Migrations complete"
    elif [ -f "src/migrate.ts" ]; then
        echo -e "  ${BULLET} Running ${BOLD}npx tsx src/migrate.ts${RESET} ..."
        npx tsx src/migrate.ts 2>&1 | sed 's/^/    /'
        echo -e "  ${CHECK} Migrations complete"
    else
        echo -e "  ${WARN} No migration file found (checked src/db/migrate.ts, src/migrate.ts)"
        echo -e "  ${DIM}If you have a custom migration path, run it manually${RESET}"
    fi
    echo ""
}

start_dev() {
    echo ""
    echo -e "  ${BOLD}🚀 Starting Dev Server${RESET}"
    echo ""

    # Pre-flight checks
    local groq_key db_url
    groq_key=$(get_env_value "GROQ_API_KEY")
    db_url=$(get_env_value "DATABASE_URL")
    local missing=0

    if ! is_key_set "$groq_key"; then
        echo -e "  ${CROSS} GROQ_API_KEY not set"
        missing=1
    fi
    if ! is_key_set "$db_url"; then
        echo -e "  ${CROSS} DATABASE_URL not set"
        missing=1
    fi
    if [ "$missing" -eq 1 ]; then
        echo -e "  ${DIM}Set required keys first (menu option 2)${RESET}"
        return 1
    fi

    echo -e "  ${CHECK} Required env vars present"
    echo -e "  ${BULLET} Running ${BOLD}npm run dev${RESET} (tsx watch)"
    echo -e "  ${DIM}Press Ctrl+C to stop${RESET}"
    echo ""
    npm run dev
}

smoke_test_pipeline() {
    echo ""
    echo -e "  ${BOLD}🧪 Proactive Pipeline Smoke Test${RESET}"
    echo -e "  ${DIM}Tests: reel scraping → download → Telegram upload${RESET}"
    echo ""

    local rapid_key tg_token
    rapid_key=$(get_env_value "RAPIDAPI_KEY")
    tg_token=$(get_env_value "TELEGRAM_BOT_TOKEN")

    if ! is_key_set "$rapid_key"; then
        echo -e "  ${CROSS} RAPIDAPI_KEY not set — needed for reel scraping"
        return 1
    fi

    # Step 1: Test reel pipeline
    echo -e "  ${BULLET} Testing reel pipeline (fetching #bangalorefood) ..."
    local reel_output
    reel_output=$(npx tsx -e "
        import { fetchReels } from './src/media/reelPipeline.js';
        const reels = await fetchReels('bangalorefood', 'smoke-test', 2);
        console.log(JSON.stringify({ count: reels.length, sources: reels.map(r => r.source), types: reels.map(r => r.type) }));
    " 2>/dev/null || echo '{"count":0}')

    local reel_count
    reel_count=$(echo "$reel_output" | tail -1 | grep -o '"count":[0-9]*' | cut -d: -f2)
    if [ -n "$reel_count" ] && [ "$reel_count" -gt 0 ]; then
        echo -e "  ${CHECK} Reel pipeline: ${reel_count} reels found"
    else
        echo -e "  ${CROSS} Reel pipeline: no reels found (API may be rate limited)"
        echo -e "  ${DIM}Output: ${reel_output}${RESET}"
    fi

    # Step 2: Test media download (public test file)
    echo -e "  ${BULLET} Testing media download pipeline ..."
    local dl_output
    dl_output=$(npx tsx -e "
        import { downloadMedia } from './src/media/mediaDownloader.js';
        const m = await downloadMedia('https://www.w3schools.com/html/mov_bbb.mp4', 'instagram');
        console.log(JSON.stringify({ ok: !!m, size: m?.sizeBytes || 0, mime: m?.mimeType || 'none' }));
    " 2>/dev/null || echo '{"ok":false}')

    if echo "$dl_output" | tail -1 | grep -q '"ok":true'; then
        local dl_size
        dl_size=$(echo "$dl_output" | tail -1 | grep -o '"size":[0-9]*' | cut -d: -f2)
        echo -e "  ${CHECK} Media download: ${dl_size} bytes downloaded"
    else
        echo -e "  ${CROSS} Media download failed"
    fi

    # Step 3: Test Telegram upload (only if token is set)
    if is_key_set "$tg_token"; then
        echo -e "  ${BULLET} Testing Telegram bot connection ..."
        local tg_resp
        tg_resp=$(curl -s "https://api.telegram.org/bot${tg_token}/getMe" 2>/dev/null)
        if echo "$tg_resp" | grep -q '"ok":true'; then
            local bot_name
            bot_name=$(echo "$tg_resp" | grep -o '"username":"[^"]*"' | head -1 | sed 's/"username":"//;s/"//')
            echo -e "  ${CHECK} Telegram bot: @${bot_name} connected"
            echo -e "  ${DIM}To test full upload, send /start to your bot, note the chat_id, then run:${RESET}"
            echo -e "  ${DIM}  npx tsx -e \"import {sendMediaViaPipeline} from './src/media/mediaDownloader.js'; ...\"${RESET}"
        else
            echo -e "  ${CROSS} Telegram bot: invalid token"
        fi
    else
        echo -e "  ${GRAY}⬚  Telegram upload — TELEGRAM_BOT_TOKEN not set, skipped${RESET}"
    fi

    # Step 4: Test LLM tier manager
    local groq_key
    groq_key=$(get_env_value "GROQ_API_KEY")
    if is_key_set "$groq_key"; then
        echo -e "  ${BULLET} Testing LLM tier manager (Groq 70B) ..."
        local llm_output
        llm_output=$(npx tsx -e "
            import { generateResponse } from './src/llm/tierManager.js';
            const r = await generateResponse([{role:'system',content:'Reply with exactly: OK'},{role:'user',content:'status check'}]);
            console.log(JSON.stringify({ ok: !!r.text, provider: r.provider, len: r.text.length }));
        " 2>/dev/null || echo '{"ok":false}')

        if echo "$llm_output" | tail -1 | grep -q '"ok":true'; then
            local llm_provider
            llm_provider=$(echo "$llm_output" | tail -1 | grep -o '"provider":"[^"]*"' | sed 's/"provider":"//;s/"//')
            echo -e "  ${CHECK} LLM tier manager: working (provider: ${llm_provider})"
        else
            echo -e "  ${CROSS} LLM tier manager: failed"
        fi
    else
        echo -e "  ${GRAY}⬚  LLM tier manager — GROQ_API_KEY not set, skipped${RESET}"
    fi

    echo ""
    echo -e "  ${BOLD}━━━ Smoke Test Complete ━━━${RESET}"
    echo ""
}

# ─── Docker Management ────────────────────────────────────────────────────────

check_docker() {
    if ! command -v docker &>/dev/null; then
        echo -e "  ${CROSS} Docker is not installed!"
        echo -e "  ${DIM}Install from https://docs.docker.com/get-docker/${RESET}"
        return 1
    fi
    if ! docker info &>/dev/null; then
        echo -e "  ${CROSS} Docker daemon is not running!"
        echo -e "  ${DIM}Start Docker Desktop or run: sudo systemctl start docker${RESET}"
        return 1
    fi
    return 0
}

docker_start() {
    echo ""
    echo -e "  ${BOLD}🐳 Starting Docker Containers${RESET}"
    echo ""
    if ! check_docker; then
        return
    fi
    echo -e "  ${BULLET} Running ${BOLD}docker compose up -d --build${RESET} ..."
    echo ""
    docker compose up -d --build 2>&1 | sed 's/^/    /'
    echo ""
    echo -e "  ${CHECK} Containers started!"
    echo ""
    docker compose ps 2>&1 | sed 's/^/    /'
    echo ""
}

docker_stop() {
    echo ""
    echo -e "  ${BOLD}🐳 Stopping Docker Containers${RESET}"
    echo ""
    if ! check_docker; then
        return
    fi
    docker compose down 2>&1 | sed 's/^/    /'
    echo -e "  ${CHECK} Containers stopped"
    echo ""
}

docker_status() {
    echo ""
    echo -e "  ${BOLD}🐳 Docker Container Status${RESET}"
    echo ""
    if ! check_docker; then
        return
    fi
    docker compose ps 2>&1 | sed 's/^/    /'
    echo ""
}

# ─── Main Menu ────────────────────────────────────────────────────────────────

main_menu() {
    while true; do
        echo -e "  ${BOLD}📋 Menu${RESET}"
        echo ""
        echo -e "  ${DIM}── Keys ──${RESET}"
        echo -e "    ${CYAN}1${RESET})  View key status dashboard"
        echo -e "    ${CYAN}2${RESET})  Set missing keys only"
        echo -e "    ${CYAN}3${RESET})  Set a specific key"
        echo -e "    ${CYAN}4${RESET})  Validate API keys (live tests)"
        echo -e "  ${DIM}── Project ──${RESET}"
        echo -e "    ${CYAN}5${RESET})  📦 Install deps + build TypeScript"
        echo -e "    ${CYAN}6${RESET})  🗄️  Run database migrations"
        echo -e "    ${CYAN}7${RESET})  🚀 Start dev server (tsx watch)"
        echo -e "    ${CYAN}8${RESET})  🧪 Smoke test pipeline (reels + download + LLM)"
        echo -e "  ${DIM}── Docker ──${RESET}"
        echo -e "    ${CYAN}9${RESET})  🐳 Start Docker containers"
        echo -e "    ${CYAN}10${RESET}) 🐳 Stop Docker containers"
        echo -e "    ${CYAN}11${RESET}) 🐳 Docker container status"
        echo -e "    ${CYAN}0${RESET})  Exit"
        echo ""
        read -p "  Choose [0-11]: " choice

        case $choice in
            1) show_dashboard ;;
            2) prompt_missing_keys ;;
            3) set_specific_key ;;
            4) validate_keys ;;
            5) install_deps ;;
            6) run_migrations ;;
            7) start_dev ;;
            8) smoke_test_pipeline ;;
            9) docker_start ;;
            10) docker_stop ;;
            11) docker_status ;;
            0)
                echo ""
                echo -e "  ${BOLD}🌍 Happy travels with Aria!${RESET}"
                echo ""
                exit 0
                ;;
            *)
                echo -e "  ${CROSS} Invalid choice"
                ;;
        esac
        echo ""
    done
}

# ─── Entry Point ──────────────────────────────────────────────────────────────

print_header
show_dashboard
main_menu
