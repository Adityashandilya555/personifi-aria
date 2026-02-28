**Aria — Subagent Architecture**

Complete AWS Stack Per Subagent + Build Status

College Student Engagement Agent · Bangalore-first · WhatsApp + Telegram + Slack

# **1. System Overview**
Aria is a multi-subagent system where each subagent owns a distinct responsibility. They communicate via Redis Streams (the event bus). The Coordinator — currently handler.ts — is the thin dispatcher that receives messages and routes events. The goal is to decompose the current synchronous monolith into 6 independent, parallel services.

**Message Flow:**

WhatsApp / Telegram / Slack → Lambda Webhook → Redis Streams (agent:events) → Coordinator → [Pulse + Archivist + Scout + Mimic + Doer + Social] in parallel → Response → Channel

# **2. AWS Foundation (Shared Infrastructure)**
Every subagent uses these shared AWS resources. This is the base layer before any subagent-specific stack.

|**AWS Service**|**Role in Aria**|**Used By**|
| :- | :- | :- |
|Amazon ElastiCache (Redis)|Inter-subagent event bus via Redis Streams. Working memory per user session. Embedding cache (24h TTL). Rate limiting via INCR. Per-user processing locks.|All subagents|
|Amazon RDS (PostgreSQL + pgvector)|Primary persistent store. User profiles, sessions, episodic memory (768-dim vectors), entity relation graph, preferences, goals, social graph.|Archivist, Social, Coordinator|
|Amazon DynamoDB|High-frequency write path. Confidence score per user. Real-time engagement signals. Doer task queue and status.|Pulse, Doer|
|Amazon S3|Instagram scrape storage. Session archives. SOUL.md persona files. Training datasets (versioned by month).|Scout, Archivist, SageMaker|
|AWS Lambda|Webhook handlers for all channels. Subagent trigger functions. Background cron workers (every 5-10 min).|All subagents|
|Amazon Bedrock|LLM calls: Llama 3.3 70B (personality), Llama 3.1 8B (classifier, reflection, summarization), Titan Embeddings v2 (vector search).|Coordinator, Pulse, Archivist, Scout|
|AWS Fargate|Playwright headless browser pool. 3 pre-warmed containers. Persistent, not Lambda (cold start too slow for browser).|Doer only|
|Amazon SageMaker|Monthly fine-tuning of Llama 3.1 8B on accumulated engagement data. Model registry. Batch inference for session summarization.|Training pipeline (Month 5+)|
|Amazon CloudWatch|Live dashboard: confidence scores per user, state transitions, proactive fires, tool latency. This is what you show during the demo.|All subagents|


# **3. Coordinator (handler.ts — The Dispatcher)**
The Coordinator is not a subagent — it is the thin dispatcher that sits between the channel layer and all subagents. Currently it is a God function doing everything sequentially. After the refactor it becomes a router that fires events onto Redis Streams and waits for results.

**AWS Services:**

- AWS Lambda — webhook receiver for Telegram, WhatsApp, Slack (already deployed)
- Amazon API Gateway — routes POST /webhook/\* to the correct Lambda function
- ElastiCache Redis — publishes message to agent:events stream, reads responses
- Amazon Bedrock (8B) — runs the classifier gate (simple vs complex message) before dispatching
- DynamoDB — reads current user state (PASSIVE/CURIOUS/ENGAGED/PROACTIVE) on every turn
- RDS PostgreSQL — fetches user record, session, rate limit check

**✓ Built:**

- Webhook handlers for all 3 channels
- 8B classifier gate (simple vs complex routing)
- Rate limiting
- Session management
- /link cross-channel identity command

**✗ Missing:**

- Redis Streams event bus (Coordinator still calls everything synchronously in-process)
- DynamoDB state read on each turn (Coordinator doesn't know user's PROACTIVE state yet)
- Squad onboarding flow (/squad command for friend graph)
- Callback query handler (inline buttons are dead — critical fix)

# **4. Subagent 1 — Pulse (Engagement Signal Scorer)**
### **Pulse — Knows when the user is ready to act**
**Status:  [DOES NOT EXIST]**   Pulse reads every incoming message and scores it. It maintains a rolling confidence score per user (0-100) in DynamoDB. When score crosses 80, it flips the user to PROACTIVE state and the outbound worker fires. This is the brain of the proactive system. Nothing else works without it.

**AWS Services Used:**

- Amazon Bedrock (8B, JSON mode) — extracts behavioral signals from each message turn
- Amazon DynamoDB — writes score:{userId} and current\_state after every turn (hot path, fast write)
- ElastiCache Redis — reads working memory (last 5 turns, active topic, reply latency) to score accurately
- AWS Lambda — Pulse runs as a parallel Lambda invocation alongside the main pipeline, non-blocking
- Amazon CloudWatch — emits score metrics per user for the live demo dashboard

**✗ Needs to be Built:**

- PulseService class: takes (message, previousTurnMetadata) → returns scoreDelta
- Scoring signals: topic persistence +12, urgency words +15, desire words +10, fast reply +5, rejection -30, topic shift -20
- score:{userId} stored in DynamoDB with TTL
- user\_proactive\_state table in RDS (current\_state, score, last\_updated)
- 4-state machine: PASSIVE → CURIOUS → ENGAGED → PROACTIVE → RECOVERY
- Wire score logging into existing handler.ts as a non-blocking side call first
- CloudWatch dashboard showing live score per user during demo


# **5. Subagent 2 — Archivist (Memory Manager)**
### **Archivist — Remembers everything reliably**
**Status:  [PARTIALLY BUILT]**   Archivist owns all memory writes. Currently memory writes are fire-and-forget after handler.ts responds — silent failures mean permanent memory loss. Archivist adds a reliable write queue, retry logic, and session summarization on 30-min inactivity.

**AWS Services Used:**

- Amazon RDS (PostgreSQL + pgvector) — primary store for episodic memories, entity graph, preferences, trip plans, social graph
- ElastiCache Redis — working memory per session (hash: wm:{userId}:{sessionId}), embedding LRU cache
- Amazon Bedrock (8B) — fact extraction from conversation turns, session summarization on inactivity
- Amazon Bedrock (Titan Embeddings v2) — 768-dim vectors for all memory writes, semantic search on read
- Amazon S3 — archives all session interaction data for SageMaker training pipeline
- AWS Lambda — Archivist worker processes memory\_write\_queue table with FOR UPDATE SKIP LOCKED pattern

**✓ Already Built:**

- Memory write path exists (fire-and-forget, unreliable)
- pgvector store with HNSW indexes
- Entity relation graph (graph-memory.ts)
- Preference extraction with confidence scoring
- Cross-channel fan-out search via person\_id linkage
- Embedding pipeline (Jina primary, HuggingFace fallback)

**✗ Needs to be Built:**

- Reliable write queue: memory\_write\_queue table + background Lambda worker with retry
- Session summarization: when user inactive >30 min, 8B generates compressed summary, stored as episodic memory with embedding
- Working memory in Redis (currently in-memory Map — dies on restart)
- Embedding cache moved to Redis (currently in-process LRU — not shared across instances)
- Social graph tables: user\_relationships, squad\_members for friend connections
- S3 archiving of every session for training pipeline


# **6. Subagent 3 — Scout (Data Fetcher)**
### **Scout — Gets real-world data, verifies it, normalizes it**
**Status:  [TOOLS EXIST, SCOUT WRAPPER MISSING]**   Scout wraps all 15 tools and adds a reflection pass before any data touches the prompt. Currently raw tool JSON goes directly into the prompt — this causes hallucination. Scout adds: (1) post-fetch 8B reflection pass to verify data quality, (2) normalization layer, (3) structured output schema per tool.

**AWS Services Used:**

- AWS Lambda — Scout runs as a sandboxed Lambda function per tool invocation, max 30s timeout
- Amazon Bedrock (8B, JSON mode) — post-fetch reflection pass: does this result actually answer the user's question?
- ElastiCache Redis — caches tool results with TTL (ride estimates: 10min, hotel prices: 1hr, weather: 30min)
- Amazon S3 — stores raw Scout results for training data labeling pipeline
- Google Places API — called via Lambda for real venue data (configured, zero code calls it currently)
- Amazon CloudWatch — logs tool latency, cache hit rate, reflection pass outcomes

**✓ Already Built:**

- compareRides: Ola, Uber, Rapido, Namma Yatri fare estimation with surge detection
- compareFoodPrices: Zomato vs Swiggy price comparison
- compareGroceryPrices: Blinkit vs Zepto vs Instamart
- searchFlights, searchHotels, getWeather, searchPlaces, convertCurrency
- searchSwiggyFood, searchZomato, searchDineout (MCP-based)
- compareProactive: proactive price comparison trigger
- Instagram media scraper (runs every 6 hours, stores to DB)

**✗ Needs to be Built:**

- Scout wrapper class: unified interface over all 15 tools
- Post-fetch reflection pass: 8B checks if result answers the query, extracts 3 key facts
- Data normalization layer: IATA codes → city names, prices → ₹ formatted, timestamps → IST
- Structured output schema registry: each tool defines its output contract
- Google Places API wiring (key exists, zero implementation)
- Tool result caching in Redis (currently no caching)
- Live Playwright scraping for Zomato/Dineout (currently using rate card estimates)


# **7. Subagent 4 — Mimic (Engagement Recovery)**
### **Mimic — Recovers disengaging users with language mirroring**
**Status:  [DOES NOT EXIST]**   When Pulse detects 2 consecutive negative signals (rejection, topic shift, non-response), Mimic takes over. It mirrors the user's slang and language patterns, generates a HOLD message (light roast or callback), and manages the 2-strike rule before hard reset. This is the retention mechanism.

**AWS Services Used:**

- Amazon Bedrock (70B) — generates HOLD and RECOVERY messages with persona consistency
- ElastiCache Redis — reads user's slang patterns and message style from working memory
- Amazon RDS — reads persona\_opinions table (what Aria has said to this user before) to avoid contradiction
- DynamoDB — reads/writes RECOVERY state, strike count per user
- AWS Lambda — Mimic fires as a Lambda when Pulse emits a negative signal event on Redis Streams
- Amazon CloudWatch — tracks recovery attempt outcomes (did user re-engage after HOLD?)

**✗ Needs to be Built:**

- RECOVERY state in the 4-state machine (Pulse dependency)
- Strike counter in DynamoDB: first negative → HOLD attempt, second consecutive → hard reset
- Slang pattern tracker: extract and store user's vocabulary (bro, swalpa, etc.) in working memory
- HOLD message template: mirrors their language + one light roast relevant to last topic
- Hard reset: score → 0, state → PASSIVE, cooldown gate blocks re-escalation for 3 turns
- Outcome tracking: did the HOLD message work? Log to S3 for training data


# **8. Subagent 5 — Doer (Browser Automation)**
### **Doer — Takes real actions in the world**
**Status:  [DOES NOT EXIST]**   Doer is the only subagent that runs as a persistent container, not a Lambda. It manages a pool of 3 pre-warmed Playwright browser instances. It executes real-world tasks — live Zomato availability, real Uber prices, BookMyShow scraping — when Pulse score hits 80. Tasks die if user goes negative.

**AWS Services Used:**

- AWS Fargate — persistent containerized Playwright pool (3 instances pre-warmed). Lambda cold start is 3-5s, too slow for browser automation
- Amazon ElastiCache Redis — task queue (LPUSH/BRPOP pattern). Doer worker polls queue. Task status updates written back to Redis
- Amazon DynamoDB — task status per userId: QUEUED → RUNNING → COMPLETE → DISCARDED
- Amazon S3 — stores Playwright screenshots for debugging, raw scraped data for training pipeline
- AWS Lambda — task dispatcher: when Pulse score hits 80, Lambda pushes task to Redis queue for Doer to pick up
- Amazon CloudWatch — task completion rate, scrape success rate, browser pool utilization

**✗ Needs to be Built:**

- AWS Fargate task definition with Playwright + Node.js container
- Redis task queue: LPUSH doer:tasks {userId, taskType, params} / BRPOP on worker
- Task types to start: check\_zomato\_availability, get\_live\_uber\_price, scrape\_bookmyshow
- Task lifecycle: QUEUED → RUNNING → COMPLETE (success) or DISCARDED (user went negative)
- Result delivery back to Coordinator via Redis Streams
- 3 pre-warmed browser instances: rotate between tasks, restart on crash
- Anti-detection: random delays, realistic headers, user agent rotation


# **9. Subagent 6 — Social (Friend Graph + Squad Planner)**
### **Social — Connects users and plans group experiences**
**Status:  [SCHEMA MISSING, NEW BUILD]**   Social is the new subagent you add for the squad feature. It manages friend connections between different users (not cross-channel identity — that is Archivist's /link). It aggregates intent signals across connected users to detect group planning moments and triggers the squad trip flow.

**AWS Services Used:**

- Amazon RDS PostgreSQL — user\_relationships table (person\_id\_a, person\_id\_b, relationship\_type, created\_at). Squad intent signals table
- ElastiCache Redis — caches active squad member signals (who from this squad has mentioned 'weekend' in last 24h)
- Amazon Bedrock (8B) — group intent detection: when a user says 'me and friends', extract friend count and activity type
- AWS Lambda — squad signal aggregator: cron every 15 min, scans for users in ENGAGED state whose squad members are also active
- Amazon CloudWatch — tracks squad formation rate, group trip conversions
- Amazon SNS — fan-out notifications when squad event is detected (notifies all squad members simultaneously)

**✓ Already Built:**

- persons table with person\_id linkage (cross-channel identity infrastructure reused)
- link\_codes mechanism (reused for /squad invite flow)
- getLinkedUserIds() function (extended for friend lookup)

**✗ Needs to be Built:**

- user\_relationships table: person\_id\_a, person\_id\_b, relationship\_type='friend', campus, created\_at
- squad\_members table: squad\_id, person\_id, joined\_at (for named groups)
- /squad command: generates 6-digit invite code, friend redeems → connected as friends
- Invite message flow: 'Aditya wants to plan this weekend with you. Reply YES to connect' (leads with name, not product)
- Onboarding hook: first-time users asked to add 3 friends before anything else
- Group intent detector: when user says 'me and 3 friends', Social subagent queries their friend graph
- Squad signal aggregator Lambda: detects when 2+ squad members both mention 'weekend/trip/go out' within 24h
- Trip card generator: formatted summary of destination + ride split + food options, designed to be forwarded in WhatsApp
- Amazon SNS fan-out: when squad event detected, notify all squad members simultaneously


# **10. Proactive Outbound Worker**
This is the feature that makes Aria fundamentally different from every other chatbot. It is a background Lambda that runs every 5 minutes. It scans DynamoDB for users in PROACTIVE state, checks gate conditions, and sends an unsolicited message before the user says anything.

**AWS Services:**

- AWS Lambda (EventBridge cron) — fires every 5 minutes, scans for PROACTIVE users
- Amazon DynamoDB — source of truth for user state. Query: current\_state = PROACTIVE AND last\_outbound > 2h ago
- ElastiCache Redis — reads user's active intent from working memory to compose the message
- Amazon Bedrock (70B) — composes the proactive message with full SOUL.md personality
- Amazon RDS — reads social graph to check if squad members are also active (group trigger)
- WhatsApp Business API / Telegram Bot API — sends the outbound message
- Amazon CloudWatch — logs every proactive fire: did user respond? Within how many minutes?

**Gate Conditions (all must pass):**

- User state = PROACTIVE (score ≥ 80)
- Time since last outbound message > 2 hours (no spam)
- Current time between 8am–10pm IST
- User has not sent a message in last 30 minutes (if they're actively chatting, don't interrupt)
- Active intent has enough context to say something specific (not a generic nudge)

**Current Status:**

- Proactive cron worker exists and runs every 10 minutes
- Fires blindly for all users regardless of engagement state — NO Pulse integration
- Gate conditions missing — no time window, no cooldown, no state check
- Fix: wire Pulse state check as first condition. One day of work.

# **11. Data Pipeline (Training Flywheel)**
Every interaction generates training data automatically. No manual labeling required. The outcome signal is automatic — Archivist tracks whether the user acted on a suggestion within 2 turns.

|**Stage**|**AWS Service**|**What Happens**|
| :- | :- | :- |
|1\. Turn capture|AWS Lambda|Every conversational turn written to S3 with full metadata (userId, timestamp, message, score, state)|
|2\. Signal extraction|Amazon Bedrock 8B|Pulse extracts behavioral signals. Written to DynamoDB hot path (<50ms)|
|3\. Outcome labeling|Amazon RDS|Archivist checks 2 turns later: did user act? Automatic label written back to S3 record|
|4\. Archive|Amazon S3|All labeled turns stored in versioned partitions: /training/YYYY-MM/userId/|
|5\. Fine-tuning|Amazon SageMaker|Monthly job. Llama 3.1 8B fine-tuned on labeled engagement data. Model registered in SageMaker registry|
|6\. Deployment|Amazon Bedrock|Fine-tuned model deployed to Bedrock endpoint. Replaces 8B classifier for engagement-specific decisions|


# **12. Demo Dashboard (What Judges See)**
The live dashboard is as important as the product for a hackathon. You show this on a second screen during the demo. It reads from CloudWatch + DynamoDB in real time.

**What the dashboard shows:**

- 3 user tiles: name, current state (PASSIVE/CURIOUS/ENGAGED/PROACTIVE), score (0-100) updating live
- Score graph per user — watch it climb turn by turn as conversation deepens
- State transition events: timestamp when PASSIVE → CURIOUS, CURIOUS → ENGAGED, etc.
- Proactive fires: timestamp + message sent when score hits 80
- Squad graph: visual nodes showing friend connections and which squad members are active
- Tool calls: which Scout tools fired, latency, cache hit or miss

**AWS Services:**

- Amazon CloudWatch — source of all metrics. Custom namespace: Aria/Engagement
- AWS Lambda — dashboard API endpoint that reads CloudWatch + DynamoDB and returns JSON
- Simple HTML/JS frontend hosted on S3 — polls the API every 3 seconds
- Amazon DynamoDB — real-time state reads for live user tiles

# **13. Build Order for Demo**
Do not try to build all 6 subagents before the demo. Build in this order. Each step is independently demo-able.

|**Priority**|**What to Build**|**Days**|**Why**|
| :- | :- | :- | :- |
|P0|Callback query handler fix|1|Buttons are dead. Every proactive message has broken buttons. Fix this before anything else|
|P0|Pulse confidence score + DynamoDB|3|Everything depends on this. Build PulseService, wire as side call, watch score on real conversations|
|P0|4-state machine + prompt personality shift|2|PASSIVE → PROACTIVE. Prompt changes based on state. Demo-able immediately after|
|P1|Fix proactive outbound (add state gate)|1|One condition: only fire for PROACTIVE users. Existing cron + one DynamoDB check|
|P1|CloudWatch dashboard|2|Makes the intelligence visible. Judges need to see the score climbing in real time|
|P1|Social graph schema + /squad command|3|user\_relationships table + invite flow. Reuses /link infrastructure|
|P2|Squad signal aggregator|2|When 2+ squad members both mention weekend → Aria proactively suggests group plan|
|P2|Trip card formatter|1|Shareable WhatsApp-ready summary. Viral mechanic|
|P2|Scout reflection pass|2|Post-tool 8B check. Makes comparisons more accurate and trustworthy|
|P3|Mimic recovery state|3|2-strike rule + HOLD messages. Important for retention, not critical for demo|
|P3|Doer / Playwright on Fargate|7|Live scraping. Impressive but estimates work fine for demo. Build after launch|

**The 90-Second Demo Sequence**

1. Open dashboard: 3 user tiles, all in PASSIVE state, scores at 0
1. User 1 (your phone) starts talking about food near campus. Dashboard shows score climbing: 0 → 22 → 41 → 68
1. User 2 (squad member) also mentions weekend plans. Social subagent detects correlated intent
1. User 1 score hits 85. State flips to PROACTIVE on dashboard. Everyone in the room sees it happen
1. Aria sends unprompted WhatsApp to User 1: 'Rohit's also free this weekend — Swiggy has 30% off near campus, Rapido isn't surging. Want me to plan something?'
1. User says yes. Aria generates trip card: 3 destination options, ride split for 2, food deals. Card is designed to forward to the group.

***Nobody asked. Aria just knew. That is the demo.***
