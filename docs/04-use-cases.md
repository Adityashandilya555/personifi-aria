# Use-Case Diagram — Stimulus-Based AI Agent

## Core Concept: Stimulus → Reasoning → Action

The **stimulus-based AI agent** paradigm is the defining innovation. Instead of passively waiting for queries, Aria senses environmental signals, runs them through AI reasoning, and proactively delivers personalized actions.

```mermaid
graph LR
    subgraph Environmental Stimuli
        S1[🌧️ Weather Change]
        S2[🚗 Traffic Surge]
        S3[🎉 Local Festival]
        S4[⏰ Time of Day]
        S5[📍 User Location]
    end

    subgraph AI Reasoning
        CL[Cognitive Classifier]
        SR[Stimulus Router]
        PE[Personality Engine]
        BX[Bedrock Signal Extractor]
    end

    subgraph Personalized Actions
        A1[Proactive Recommendation]
        A2[Price Comparison]
        A3[Route Suggestion]
        A4[Activity Planning]
        A5[Social Cascade — Friend Bridge]
    end

    S1 --> SR
    S2 --> SR
    S3 --> SR
    S4 --> SR
    S5 --> CL
    SR --> CL
    CL --> PE
    PE --> BX
    BX --> A1
    PE --> A2
    PE --> A3
    PE --> A4
    PE --> A5
```

## Travel Use Cases (Primary)

```mermaid
graph TD
    U((Traveler / City Dweller))

    U --> UC1[Search Places Nearby]
    U --> UC2[Compare Ride Prices<br/>Uber vs Ola vs Rapido]
    U --> UC3[Compare Food Delivery<br/>Swiggy vs Zomato]
    U --> UC4[Search Flights + Hotels]
    U --> UC5[Get Directions + Weather]
    U --> UC6[Compare Grocery Prices<br/>Zepto vs Blinkit]
    U --> UC7[Create Squad<br/>Group Trip Planning]
    U --> UC8[Friend Bridge<br/>Ping Inactive Friends]
    U --> UC9[Opinion Gathering<br/>Ask Friends with Affinity]

    subgraph Stimulus-Triggered Proactive
        ST1[☔ Rain → Indoor Suggestions]
        ST2[🎉 Festival → Food Spot Recs]
        ST3[🚗 Traffic → Alt Route + Cab Compare]
        ST4[🌙 Evening → Dinner + Nightlife Picks]
        ST5[👥 Friend Active → Social Bridge Ping]
    end

    U -.->|Proactive| ST1
    U -.->|Proactive| ST2
    U -.->|Proactive| ST3
    U -.->|Proactive| ST4
    U -.->|Proactive| ST5
```

## Cross-Domain Expandability

The stimulus-based agent pattern is inherently **domain-agnostic**. The core pipeline (sense → classify → reason → act → learn) transfers to any domain where environmental signals influence decisions:

```mermaid
graph TB
    subgraph Core Engine — Reusable
        SE[Stimulus Engine]
        CR[Cognitive Classifier]
        PE[Personality + Memory]
        PU[Pulse Engagement]
        SO[Social Graph]
    end

    subgraph 🌾 Agriculture
        AG1[Soil Moisture Sensor] --> SE
        AG2[Weather Forecast] --> SE
        AG3[Market Price Feed] --> SE
        SE --> AGR1[Irrigation Alert]
        SE --> AGR2[Pest Warning + Treatment]
        SE --> AGR3[Optimal Sell Window]
    end

    subgraph 🏥 Healthcare
        HC1[AQI Monitor] --> SE
        HC2[Pollen Index] --> SE
        HC3[Patient Vitals Wearable] --> SE
        SE --> HCR1[Exercise Advisory]
        SE --> HCR2[Medication Reminder]
        SE --> HCR3[Caregiver Alert]
    end

    subgraph 📚 Education
        ED1[Study Duration Tracker] --> SE
        ED2[Exam Schedule] --> SE
        ED3[Performance Analytics] --> SE
        SE --> EDR1[Break Reminder]
        SE --> EDR2[Weak Topic Drill]
        SE --> EDR3[Study Group Bridge]
    end
```

> **Key Takeaway for Evaluators:** The stimulus engine, cognitive classifier, personality composer, pulse engagement, and social graph are **reusable components** (~70% of the codebase). Swapping the tool layer and stimulus sources allows the same architecture to power agents in agriculture (soil + weather + market stimuli), healthcare (AQI + vitals + medication stimuli), and education (study patterns + exam schedule stimuli) — with minimal changes to the core pipeline.
