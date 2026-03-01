# Social Subagent

> **Directory:** `src/social/`  
> **Files:** `friend-graph.ts`, `squad.ts`, `squad-intent.ts`, `outbound-worker.ts`, `action-cards.ts`, `types.ts`, `index.ts`

## Overview

The Social subagent adds friend relationships and group coordination ("squads") to Aria. Users can add friends, create squads, and Aria detects when multiple squad members express similar intents, triggering group recommendations.

## Components

### 1. Friend Graph (`friend-graph.ts`)

Manages 1-to-1 relationships between users.

```
/friend add <username>   → addFriend(userId, friendId)     → status: 'pending'
/friend accept <id>      → acceptFriend(userId, friendId)   → status: 'accepted'
/friend remove <id>      → removeFriend(userId, friendId)   → deleted
/friend list             → getFriends(userId)               → FriendInfo[]
/friend                  → getFriends + getPendingRequests
```

**Database:** `user_relationships` table with `status: 'pending' | 'accepted' | 'blocked'`

### 2. Squads (`squad.ts`)

Group coordination — small groups of friends who plan together.

```
/squad create <name>     → createSquad(userId, name)              → max 10 members
/squad invite <user>     → inviteToSquad(squadId, inviterId, id)  → status: 'pending'
/squad accept            → acceptSquadInvite(userId)              → joins squad
/squad leave             → leaveSquad(userId, squadId)
/squad list              → getSquadsForUser(userId)               → SquadWithMembers[]
```

**Roles:** `admin` (creator) and `member`  
**Max:** 10 members per squad (configurable)  
**Database:** `squads` + `squad_members` tables

### 3. Squad Intent Aggregation (`squad-intent.ts`)

Detects when multiple squad members are talking about the same topic.

**Intent Detection (regex-based):**

| Category | Keywords |
|----------|----------|
| `trip` | trip, travel, vacation, getaway, explore |
| `food` | food, eat, lunch, dinner, biryani, dosa, restaurant |
| `nightlife` | bar, pub, brewery, club, drinks |
| `weekend` | weekend, saturday, sunday, plan, chill |
| `event` | event, concert, show, festival, movie |

**Flow:**
```
User sends message
    │
    ▼
detectIntentCategory(message)  → 'food' (or null)
    │
    ▼ (if category detected)
recordIntentForUserSquads()
    → finds all squads user belongs to
    → INSERT INTO squad_intents for each squad
```

**Correlation Detection:**
```
detectCorrelatedIntents(squadId, windowMinutes=120)
    → finds categories where 2+ unique members have matching intents
    → returns CorrelatedIntent[] sorted by strength
```

### 4. Outbound Worker (`outbound-worker.ts`)

Scheduled worker (every 15 minutes) that sends group recommendations.

**Pipeline:**
1. Find authenticated Telegram users who belong to squads (limit 10)
2. For each user, check pulse state — only send to `ENGAGED` or `PROACTIVE`
3. Check 30-minute cooldown
4. Detect correlated intents across the user's squads
5. If found → generate action card and send via Telegram

### 5. Action Cards (`action-cards.ts`)

Formatted Telegram messages with inline buttons.

```typescript
{
  title: string           // "🍽️ Squad Food Plan"
  body: string            // Formatted recommendation
  emoji: string
  ctaButtons: [           // Rendered as Telegram inline keyboard
    { label: "Let's plan it!", action: "squad_plan", url?: string },
  ]
  mediaUrl?: string
  shareText: string       // For WhatsApp/copy sharing
  category: string
}
```

## Integration Points

| Handler Step | What Happens |
|-------------|--------------|
| Step 0 | `/friend` and `/squad` commands parsed and routed |
| Step 17b (fire-and-forget) | `detectIntentCategory()` + `recordIntentForUserSquads()` |
| Scheduler (every 15m) | `runSocialOutbound()` checks for correlated intents |

## Database Tables

| Table | Purpose |
|-------|---------|
| `user_relationships` | Friend graph with status |
| `squads` | Squad metadata |
| `squad_members` | Squad membership with role/status |
| `squad_intents` | Intent signals per squad member |

## Known Issues

1. **Intent detection is purely regex** — no LLM involvement, misses nuanced intents
2. **In-memory cooldown map** — lost on restart
3. **No group conversation** — Aria talks to each user individually, not in a group chat
4. **Action card buttons** — callback handling for squad actions is minimal
5. **24-hour intent cleanup** — intents expire quickly, may miss slow-forming patterns
