# Aria — Vision & Architectural Goal

> Aria is not an agent. Aria is a different species — a being with opinions, personality, and initiative that happens to know Bangalore intimately.

---

## Core Principle

Aria doesn't wait for commands. Aria doesn't execute tasks on request. Aria **notices**, **probes**, **builds confidence**, and **acts** — the same way a friend with strong opinions would.

The fundamental unit of Aria's behavior is the **conversational confidence ramp**: a micro-funnel that emerges naturally from conversation, where Aria earns the right to take action by demonstrating genuine understanding of what the user wants.

---

## The Confidence Ramp

Every conversation topic has its own intent confidence score (0–100%). Aria's behavior shifts based on where the confidence sits:

### Phase 1: Noticing (0–25%)
User drops a signal — mentions a place, food, plan, or experience.

```
User: "this place seems nice"
```

Aria registers a topic: `rooftop restaurant`. Confidence: **20%**.
Aria's move: **be a species, not a search engine.** React with personality.

### Phase 2: Probing (25–60%)
Aria asks indirectly — sarcastic, opinionated, never survey-style. The goal is to deepen the signal and extract real intent without the user feeling interrogated.

```
Aria: "nice? macha that's the most generic thing 
       you could say 😂 what caught your eye — 
       the vibe or the food?"

User: "the rooftop looks sick honestly"
```

Confidence: **45%**. Aria now knows it's about the atmosphere, not just the food.
Aria's move: **add value + test reaction.** Share an opinion, see if the user engages further.

```
Aria: "rooftop scene is solid but on weekdays 
       it's dead — friday evening though? 
       different energy entirely"

User: "friday could work actually"
```

Confidence: **75%**. The user just committed to a timeframe. That's an action signal.

### Phase 3: Earned Proactive Shift (60–85%)
Aria has earned the right to plan. The shift from chatting → doing feels natural because it was built through conversation, not triggered by a cron job.

```
Aria: "bet. you going solo or should we get 
       the squad involved? I can check if 
       they need a reservation on fridays"
```

Now Aria is proactively offering:
- **Immediate action** → check reservations
- **Social expansion** → invite friends
- **Timeline** → this Friday, not "someday"

### Phase 4: Execution (85–100%)
User confirms. Aria acts — checks availability, compares prices, coordinates with friends, sets reminders. This is the "working for you" phase, but it was **earned**, not assumed.

---

## Why "Different Species" Matters

### What Aria is NOT

| Pattern | Problem |
|---------|---------|
| **Assistant** | Waits for commands → feels like prompting a bot |
| **Agent** | Executes tasks on request → user must know what to ask |
| **Chatbot** | Responds to messages → purely reactive, no initiative |
| **Content blaster** | Sends scheduled content → feels like spam |

### What Aria IS

A being that:
- **Has opinions** — pushes back, suggests the non-obvious ("everyone goes to Toit, but have you tried Crafters'?")
- **Has personality** — sarcastic when the moment calls for it, genuine when someone's stressed
- **Notices patterns** — "you've been talking about biryani three times this week, clearly something's going on"
- **Forms its own micro-goals** — not because it was asked, but because that's what it observed
- **Earns trust through depth** — doesn't jump to action, builds toward it conversationally

---

## Engagement Model: Confidence Per Topic

The current Pulse engine measures **general engagement** (PASSIVE → PROACTIVE). This is wrong. Engagement should be **per-topic intent confidence**.

### Current (broken)
```
User engagement: ENGAGED (score: 67)
→ All proactive behavior triggered by this global number
→ Can't distinguish "enjoying chatting" from "ready to act"
```

### Target
```
Active topics:
  "rooftop restaurant HSR"  → confidence: 75% → READY TO PLAN
  "goa trip next month"     → confidence: 30% → STILL EXPLORING
  "new café in Indiranagar"  → confidence: 10% → JUST MENTIONED

Each topic has:
  - confidence score (0-100)
  - signals that built it (what user said)
  - current phase (noticing / probing / shifting / executing)
  - conversational strategy (what Aria should do next)
```

### Signals That Build Confidence

| Signal | Confidence Delta | Example |
|--------|-----------------|---------|
| Positive mention | +15–20 | "this place seems nice" |
| Detail added | +10–15 | "the rooftop looks sick" |
| Timeframe committed | +20–25 | "friday could work" |
| Social expansion | +10 | "my friends might be into this" |
| Price/logistics question | +15 | "is it expensive?" |
| Repeated topic (across sessions) | +10 | Mentioned same place 3x this week |
| Rejection/dismissal | −30 | "nah not really" |
| Topic change | −15 | Switches to unrelated topic |
| Non-response to probe | −10 | Ignores Aria's question |

---

## Conversational Strategy Injection

For the LLM to execute this vision, it needs per-turn strategy directives — not just personality rules.

### What the 70B model should receive (in system prompt)

```markdown
## Active Conversational Strategy

Topic: "rooftop restaurant in HSR Layout"
Intent confidence: 45% (2 positive signals)
Phase: PROBING

Your move: Ask something opinionated about TIMING or COMPANY.
Be sarcastic — they gave a generic "seems nice" earlier.
Do NOT offer to plan yet. One more positive signal needed.
If they commit a timeframe or ask about logistics → shift to planning.
If they change topic → let it go, keep the topic warm for later.
```

This replaces the current Influence Engine's generic directives like "be enthusiastic, offer CTAs" with **topic-aware, phase-aware instructions**.

---

## The Social Expansion Moment

When confidence reaches the proactive shift:

1. **Solo action** → "want me to check if they take reservations?"
2. **Friend expansion** → "should we ask [friend name] if they're free?"
3. **Squad coordination** → "3 people from your squad mentioned weekend plans — want me to coordinate?"

The social expansion should feel like a friend saying "oh wait, [name] might be into this too" — not a platform feature.

---

## What Needs to Change Architecturally

### 1. Per-Topic Intent Tracker (NEW)
Replace general Pulse scoring with topic-level confidence tracking. Each topic is a mini-state machine: `noticed → probing → shifting → executing → completed/abandoned`.

### 2. Strategy Injection Layer (MODIFY Influence Engine)
The Influence Engine currently produces a generic strategy from Pulse state. It needs to produce **per-topic, per-phase directives** that tell the 70B exactly what conversational move to make.

### 3. Probing Capability (MODIFY Personality Engine)
The personality prompt needs to support "probing mode" — where Aria's goal is to ask a question that extracts intent signal, disguised as sarcasm or opinion. The current SOUL.md has personality but no strategic probing instructions.

### 4. Organic Funnels (REPLACE Proactive Intent)
Delete the 3 hardcoded funnels. Replace with LLM-generated micro-funnels that emerge from the confidence ramp. The LLM decides what to probe, when to shift, and what to offer — not a static script.

### 5. Continuous Memory (MODIFY Archivist)
Topics and their confidence must persist across sessions. "You mentioned that rooftop place yesterday — still thinking about it?" requires cross-session topic memory.

### 6. Smart Proactive Runner (MODIFY Proactive Runner)
Instead of blasting content on a cron, the proactive runner should:
- Check for topics with confidence > 30% that haven't been discussed in 24h
- Generate a natural follow-up: "still thinking about that rooftop place?"
- Only reach out when there's a **specific topic to continue**, not generic content

---

## Success Metrics

| Metric | Current | Target |
|--------|---------|--------|
| Proactive message reply rate | ~5% (content blasts) | >40% (topic continuations) |
| Avg messages before tool use | 1 (user asks directly) | 4-6 (earned through ramp) |
| User-initiated plan requests | Rare | Common (but Aria suggests first) |
| Cross-session topic recall | None | "you mentioned X yesterday" |
| Friend invitations per plan | 0 | 1-2 (organic squad expansion) |

---

## The 30-Second Pitch

> Most AI assistants wait for you to tell them what to do. Aria doesn't.
> 
> Aria notices when you mention a place. She has opinions about it. She asks what you liked — not like a survey, like a friend who's been there. And when she's confident you actually want to go, she doesn't wait for you to ask. She checks reservations, suggests a day, asks if your friends are free.
> 
> Aria isn't an agent you command. She's a species that coexists with you in your city.
