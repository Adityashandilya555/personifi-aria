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
    "RAPIDAPI_KEY|RapidAPI (Hotels/Booking)|optional"
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
PLACEHOLDER_PATTERNS="^$|^gsk_your_|^your_|^AIzaSy\.\.\.$|^postgresql://user:password@|^hf_your_|^jina_your_|^xoxb-\.\.\.$"

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
        # Just check if the key format looks valid (starts with expected prefix)
        if [ ${#rapid_key} -ge 10 ]; then
            echo -e "${WARN} Key set (${#rapid_key} chars) — no free validation endpoint"
            skip_count=$((skip_count + 1))
        else
            echo -e "${CROSS} Key looks too short (${#rapid_key} chars)"
            fail_count=$((fail_count + 1))
        fi
    else
        echo -e "  ${GRAY}⬚  RapidAPI — not configured, skipped${RESET}"
        skip_count=$((skip_count + 1))
    fi

    echo ""
    echo -e "  ${BOLD}━━━ Results ━━━${RESET}"
    echo -e "  ${GREEN}Passed: ${pass_count}${RESET}  ${RED}Failed: ${fail_count}${RESET}  ${GRAY}Skipped: ${skip_count}${RESET}"
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
        echo -e "    ${CYAN}1${RESET})  View key status dashboard"
        echo -e "    ${CYAN}2${RESET})  Set missing keys only"
        echo -e "    ${CYAN}3${RESET})  Set a specific key"
        echo -e "    ${CYAN}4${RESET})  Validate API keys (live tests)"
        echo -e "    ${CYAN}5${RESET})  🐳 Start Docker containers"
        echo -e "    ${CYAN}6${RESET})  🐳 Stop Docker containers"
        echo -e "    ${CYAN}7${RESET})  🐳 Docker container status"
        echo -e "    ${CYAN}0${RESET})  Exit"
        echo ""
        read -p "  Choose [0-7]: " choice

        case $choice in
            1) show_dashboard ;;
            2) prompt_missing_keys ;;
            3) set_specific_key ;;
            4) validate_keys ;;
            5) docker_start ;;
            6) docker_stop ;;
            7) docker_status ;;
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
