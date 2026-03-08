# Process Flow Diagram

## Stimulus-Driven Proactive Flow

The defining feature of Aria is the **stimulus loop** — a background process that continuously monitors environmental signals and proactively engages users when relevant.

```mermaid
flowchart TD
    subgraph Stimulus Sources
        W[OpenWeatherMap API]
        T[Google Maps Traffic API]
        F[Festival Calendar DB]
    end

    subgraph Stimulus Router
        SR[Stimulus Aggregator<br/>Per-user, ranked by priority]
        WS[Weather Stimulus<br/>Rain / Heatwave / Storm]
        TS[Traffic Stimulus<br/>Surge / Jam / Clearance]
        FS[Festival Stimulus<br/>Today / Eve / Lead-up]
    end

    subgraph Decision Layer
        PE[Pulse Engine<br/>Engagement State]
        IE[Influence Engine<br/>Strategy Selector]
        PI[Proactive Intent<br/>Funnel Orchestrator]
    end

    subgraph User Interaction
        MSG[Proactive Message<br/>via Telegram / WhatsApp]
        BTN[Inline Buttons<br/>Accept / Dismiss / More]
        FU[Funnel Flow<br/>Multi-step guided journey]
    end

    W --> WS
    T --> TS
    F --> FS
    WS --> SR
    TS --> SR
    FS --> SR

    SR --> PE
    PE --> IE
    IE -->|PROACTIVE state| PI
    IE -->|ENGAGED state| PI
    IE -->|PASSIVE state| X[No action — wait]

    PI --> MSG
    MSG --> BTN
    BTN -->|Accept| FU
    BTN -->|Dismiss| Y[Record rejection<br/>Update weights]
    FU --> Z[Tool Execution<br/>Book / Compare / Navigate]
```

## Conversational Message Flow

```mermaid
flowchart LR
    A[User Message] --> B[Sanitize]
    B --> C{Injection Attack?}
    C -->|Yes| D[Log + Block]
    C -->|No| E[8B Classify]
    E --> F{Tool Needed?}
    F -->|Yes| G[Extract Args<br/>Execute Tool]
    F -->|No| H[Cognitive State<br/>Emotion + Goal]
    G --> I[Compose Prompt]
    H --> I
    I --> J[70B Generate]
    J --> K[Filter Output]
    K --> L[Send Reply]
    L --> M[Save to Memory<br/>Update Engagement]
```

## Engagement State Machine

```mermaid
stateDiagram-v2
    [*] --> PASSIVE: New user / low activity

    PASSIVE --> CURIOUS: User asks a question
    CURIOUS --> ENGAGED: Tool interaction or follow-up
    ENGAGED --> PROACTIVE: Score >= 80 + sustained activity
    PROACTIVE --> ENGAGED: Score dips below 80
    ENGAGED --> CURIOUS: Session gap > 2 hours
    CURIOUS --> PASSIVE: No interaction for 24h

    PASSIVE: Score 0-24<br/>No proactive outreach
    CURIOUS: Score 25-49<br/>Soft nudges only
    ENGAGED: Score 50-79<br/>Active suggestions
    PROACTIVE: Score 80-100<br/>Full proactive mode
```
