# Wireframe / Mock Diagram

## Conversational Interface Flow

Aria operates as a **chat-native agent** — no separate app or dashboard required. The wireframe below shows the Telegram interface flow.

```mermaid
graph TD
    subgraph Screen 1 — First Contact
        S1A["🤖 Aria: Hey! I'm Aria, your<br/>local travel guide 🌍<br/>What should I call you?"]
        S1B["👤 User: Aditya"]
        S1C["🤖 Aria: Nice to meet you,<br/>Aditya! Share your location<br/>so I can find spots near you"]
        S1D["📍 [Share Location Button]"]
    end

    subgraph Screen 2 — Stimulus Trigger
        S2A["🤖 Aria: It's raining in<br/>Hyderabad right now ☔<br/>Perfect weather for chai!<br/>Want me to find a cozy<br/>café nearby?"]
        S2B["📱 [Yes, find me one]<br/>[No thanks]<br/>[Show indoor activities]"]
    end

    subgraph Screen 3 — Tool Execution
        S3A["🤖 Aria: Found 3 great<br/>spots near Banjara Hills!"]
        S3B["📍 Café Niloufer — ⭐ 4.5<br/>📍 Roastery Coffee — ⭐ 4.3<br/>📍 Autumn Leaf Café — ⭐ 4.6"]
        S3C["📸 [Venue Photo]"]
        S3D["🤖 Want directions to any<br/>of these? Or compare<br/>delivery prices?"]
    end

    subgraph Screen 4 — Price Comparison
        S4A["👤 User: Compare food delivery<br/>prices for biryani near me"]
        S4B["🤖 Aria: Comparing across<br/>Swiggy and Zomato..."]
        S4C["📊 Paradise Biryani<br/>Swiggy: ₹299 + ₹30 delivery<br/>Zomato: ₹285 + ₹25 delivery<br/><br/>💡 Zomato is ₹19 cheaper!"]
    end

    S1D --> S2A
    S2B --> S3A
    S3D --> S4A
```

## System Component Wireframe

```mermaid
graph TB
    subgraph Frontend — Chat Interface
        UI1[Message Input]
        UI2[Location Share Button]
        UI3[Inline Action Buttons]
        UI4[Photo / Media Display]
        UI5[Map Pin / Venue Cards]
    end

    subgraph Backend — Aria Core
        BE1[Fastify Webhook Server]
        BE2[Channel Adapter Layer]
        BE3[Handler Pipeline]
        BE4[Tool Executor]
        BE5[Response Composer]
    end

    subgraph Data Layer
        DL1[PostgreSQL<br/>Sessions, Memory, Preferences]
        DL2[DynamoDB<br/>Engagement Metrics]
        DL3[S3<br/>Training Archives]
    end

    UI1 --> BE1
    UI2 --> BE1
    BE1 --> BE2 --> BE3
    BE3 --> BE4
    BE3 --> BE5
    BE5 --> UI3
    BE5 --> UI4
    BE5 --> UI5

    BE3 --> DL1
    BE4 --> DL2
    BE4 --> DL3
```
