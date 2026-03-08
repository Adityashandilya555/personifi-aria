# System Architecture

## High-Level Architecture

```mermaid
graph TB
    subgraph User Layer
        TG[Telegram] 
        WA[WhatsApp]
        SL[Slack]
    end

    subgraph Channel Adapters
        CA[Channel Registry<br/>Unified ChannelAdapter Interface]
    end

    subgraph Core Pipeline
        IDX[Fastify Server<br/>Webhook Router]
        SAN[Input Sanitizer<br/>Injection Protection]
        COG[Cognitive Classifier<br/>Groq Llama-3.1-8B]
        TR[Tool Router<br/>24+ Real-Time Tools]
        PE[Personality Engine<br/>SOUL.md Composer]
        LLM[Response Generator<br/>Groq Llama-3.3-70B]
    end

    subgraph Intelligence Layer
        MEM[Memory Store<br/>Episodic + Semantic]
        GM[Graph Memory<br/>Entity Relationships]
        ARCH[Archivist<br/>Long-term Storage]
        STIM[Stimulus Router<br/>Weather / Traffic / Festival]
        PULSE[Pulse Engine<br/>Engagement Scoring]
        INF[Influence Engine<br/>Strategy Selection]
        PI[Proactive Intent<br/>Funnel Orchestrator]
    end

    subgraph AWS Services
        DDB[DynamoDB<br/>User State + Metrics]
        BR[Bedrock / Claude<br/>Fallback LLM]
        S3[S3<br/>Training Data + Archives]
        CW[CloudWatch<br/>Pipeline Metrics]
        SNS[SNS<br/>Notifications]
        EB[EventBridge<br/>Cron Scheduling]
    end

    subgraph External APIs
        GROQ[Groq API<br/>Llama 3.1/3.3]
        GP[Google Places API]
        OWM[OpenWeatherMap]
        GMA[Google Maps / Directions]
        RAP[RapidAPI<br/>Flights / Hotels]
    end

    TG --> CA
    WA --> CA
    SL --> CA
    CA --> IDX
    IDX --> SAN --> COG
    COG -->|tool_call| TR
    COG -->|cognitive_state| PE
    TR --> PE
    PE --> LLM
    LLM --> CA

    COG --> MEM
    COG --> GM
    MEM --> ARCH
    STIM --> PE
    PULSE --> INF --> PE
    PI --> CA

    DDB -.-> PULSE
    BR -.-> LLM
    S3 -.-> ARCH
    CW -.-> PULSE
    SNS -.-> PI
    EB -.-> IDX

    TR --> GP
    TR --> RAP
    STIM --> OWM
    STIM --> GMA
    COG --> GROQ
    LLM --> GROQ
```

## Dual-Model Pipeline

Aria uses a **classifier-gated dual-model pipeline** — the most critical architectural decision:

```mermaid
sequenceDiagram
    participant U as User
    participant S as Sanitizer
    participant C as 8B Classifier
    participant T as Tool Layer
    participant P as Personality Engine
    participant L as 70B Generator

    U->>S: Raw message
    S->>C: Sanitized input + history
    
    alt Tool Required
        C->>T: tool_call(name, args)
        T->>T: Execute tool (API call)
        T->>P: Tool results + cognitive state
    else Conversational
        C->>P: cognitive_state (emotion, goal, complexity)
    end

    P->>P: Compose system prompt<br/>(SOUL.md + memories + stimuli + tone)
    P->>L: System prompt + messages
    L->>U: Response (text + optional media)
```

**Why two models?**
- **8B Classifier (~100ms):** Routes messages to tools or conversation. Extracts tool arguments via native function calling. Zero-cost for simple greetings.
- **70B Generator (~400ms):** Produces the final Aria-voice response using the full composed personality prompt. Only called once — never re-runs for tool routing.

## Request Lifecycle (Detailed)

```mermaid
flowchart TD
    A[Incoming Webhook] --> B{Channel?}
    B -->|Telegram| C[Parse body.message]
    B -->|WhatsApp| D[Parse changes.value.messages]
    B -->|Slack| E[Parse event.text]

    C --> F[Sanitize Input]
    D --> F
    E --> F

    F --> G{Obvious Simple?}
    G -->|Yes — hi, ok, thanks| H[Skip Classifier<br/>Default cognitive state]
    G -->|No| I[8B Classifier<br/>Groq function calling]

    I --> J{Result Type?}
    J -->|tool_call| K[Execute Tool]
    J -->|cognitive| L[Extract emotion + goal]

    H --> M[Parallel Fetch]
    K --> M
    L --> M

    M --> M1[Search Memories]
    M --> M2[Get Preferences]
    M --> M3[Get Stimuli]
    M --> M4[Get Pulse State]
    M --> M5[Get Active Goal]

    M1 --> N[Compose System Prompt]
    M2 --> N
    M3 --> N
    M4 --> N
    M5 --> N

    N --> O[70B Generate Response]
    O --> P[Output Filter]
    P --> Q[Send via Channel Adapter]
    Q --> R[Fire-and-forget: Save memory, update engagement]
```
