# Features

## Feature Overview

| # | Feature | Description | Status |
|---|---------|-------------|--------|
| 1 | **Stimulus Engine** | Real-time weather, traffic, and festival sensing with priority-ranked actions | ✅ Live |
| 2 | **Cognitive Classifier** | 8B LLM classifies intent and routes to tools in ~100ms | ✅ Live |
| 3 | **24+ Real-Time Tools** | Flights, hotels, places, rides, food, grocery — all with live data | ✅ Live |
| 4 | **Dynamic Personality** | SOUL.md-based persona that adapts tone to user emotion | ✅ Live |
| 5 | **Memory System** | Episodic + semantic + graph memory across conversations | ✅ Live |
| 6 | **Pulse Engagement** | 4-state engagement scoring (Passive → Curious → Engaged → Proactive) | ✅ Live |
| 7 | **Proactive Intent Funnels** | Multi-step guided journeys triggered by stimuli or engagement state | ✅ Live |
| 8 | **Influence Engine** | Context-aware CTA strategy based on engagement state + active topics | ✅ Live |
| 9 | **Social — Squads** | Named friend groups for coordinated recommendations and group planning | ✅ Live |
| 10 | **Social — Friend Graph** | Directional friendships with affinity scoring for opinion gathering | ✅ Live |
| 11 | **Social — Cascade Bridge** | Active-inactive friend bridge: re-engages passive friends via active ones | ✅ Live |
| 12 | **Scout Subagent** | Data fetcher with Redis caching, 8B reflection pass, and normalization | ✅ Live |
| 13 | **Bedrock Signal Extraction** | Claude Haiku extracts urgency, desire, rejection, preferences per turn | ✅ Live |
| 14 | **Archivist** | Long-term memory archival with Bedrock summarization and S3 storage | ✅ Live |
| 15 | **Price Comparison** | Cross-platform comparison: Uber/Ola/Rapido, Swiggy/Zomato, Zepto/Blinkit | ✅ Live |
| 16 | **Multi-Channel** | Telegram, WhatsApp, Slack via unified adapter interface | ✅ Live |
| 17 | **AWS Integration** | DynamoDB, Bedrock, S3, CloudWatch, SNS, EventBridge | ✅ Live |
| 18 | **Security** | Multi-layer prompt injection protection + output filtering | ✅ Live |

## Social Features Architecture

```mermaid
graph TB
    subgraph Social Layer
        FG[Friend Graph<br/>Directional Relationships<br/>Add / Accept / Block]
        SQ[Squad System<br/>Named Groups<br/>Create / Invite / Leave]
        OW[Outbound Worker<br/>Scheduled every 15 min]
    end

    subgraph Social Intelligence
        CI[Correlated Intent Detection<br/>Multiple squad members<br/>mentioning same topic]
        FB[Friend Bridge<br/>Active user → Passive friend<br/>Re-engagement via ping]
        OG[Opinion Gathering<br/>Ask friend with high affinity<br/>for current category]
        AC[Action Cards<br/>Inline keyboard with<br/>Accept / Dismiss / More]
    end

    subgraph Engagement Integration
        PE[Pulse Engine<br/>Engagement State]
        CW[CloudWatch<br/>Cascade Metrics]
        SNS[SNS<br/>Squad Notifications]
    end

    FG --> CI
    SQ --> CI
    CI --> OW
    OW --> FB
    OW --> OG
    OW --> AC
    PE --> OW
    OW --> CW
    SQ --> SNS
```

**How Social Cascade Works:**
1. User B (ENGAGED) is browsing restaurants in Jubilee Hills
2. Aria checks friend graph — User A (PASSIVE) has high affinity for food in that area
3. Aria sends User B: *"Your friend Priya loves South Indian food here — want to ping her?"*
4. User B taps "Ping Priya" → Aria sends User A: *"Aditya is exploring dinner spots near you — want to join the plan?"*
5. Both users re-engage → CloudWatch records a `CascadeTriggerCount` metric

## Scout Subagent Pipeline

```mermaid
flowchart LR
    A[Tool Request] --> B{Redis Cache?}
    B -->|Hit| C[Return Cached]
    B -->|Miss| D[Execute Tool API]
    D --> E[Normalize Output<br/>Prices, IATA codes, IST times]
    E --> F[8B Reflection Pass<br/>Verify quality, extract key facts]
    F --> G[Cache Result<br/>Per-tool TTL]
    G --> H[Inject into 70B Prompt]
```

## Feature Architecture Diagram

```mermaid
graph LR
    subgraph Input
        CH[Multi-Channel<br/>Telegram / WhatsApp / Slack]
    end

    subgraph Intelligence
        COG[Cognitive Classifier<br/>Groq 8B — 100ms]
        MEM[Memory System<br/>Episodic + Graph]
        STIM[Stimulus Engine<br/>Weather + Traffic + Festival]
        PULSE[Pulse Engine<br/>Engagement Scoring]
        INF[Influence Engine<br/>CTA Strategy]
        BEX[Bedrock Extractor<br/>Signal Extraction]
    end

    subgraph Tools
        SC[Scout Subagent<br/>Cache + Reflect + Normalize]
        PL[Places Search]
        FL[Flights]
        HT[Hotels]
        RC[Ride Compare]
        FC[Food Compare]
        GC[Grocery Compare]
    end

    subgraph Social
        SQ[Squads]
        FG[Friend Graph]
        OW[Outbound Worker]
    end

    subgraph Output
        PE[Personality Engine<br/>SOUL.md + Tone]
        LLM[70B Generator<br/>Groq Llama-3.3]
    end

    CH --> COG
    COG --> SC --> Tools
    MEM --> PE
    STIM --> PE
    PULSE --> INF --> PE
    BEX --> MEM
    SQ --> OW --> CH
    FG --> OW
    Tools --> PE --> LLM --> CH
```

## Tool Capabilities

| Tool | Data Source | Capability |
|------|-----------|------------|
| `search_places` | Google Places API | Nearby restaurants, cafes, attractions with photos and ratings |
| `search_flights` | RapidAPI / Travel MCP | Real-time flight prices with dates and airlines |
| `search_hotels` | RapidAPI / Travel MCP | Hotel availability, pricing, and ratings |
| `compare_ride_prices` | Web Scrapers | Side-by-side Uber vs Ola vs Rapido pricing |
| `compare_food_prices` | Swiggy/Zomato MCP | Restaurant menu comparison across delivery platforms |
| `compare_grocery_prices` | Zepto/Blinkit MCP | Grocery item price comparison across platforms |
| `get_directions` | Google Maps API | Turn-by-turn directions with traffic-aware ETA |
| `get_weather` | OpenWeatherMap | Current conditions + multi-day forecast |
| `get_air_quality` | Air quality API | AQI, pollutants, health recommendations |
| `get_pollen` | Pollen API | Pollen count and allergy advisories |
| `convert_currency` | Exchange rate API | Real-time currency conversion |
| `get_timezone` | Timezone API | Time zone differences for travel planning |
