# Social & Proactive Outbound Subagent

## Overview

The Social subagent manages friend relationships, squad groups, and coordinated group planning. The proactive outbound worker scans squad members for correlated intents and sends group recommendations.

## Architecture

```
User Message → /friend or /squad command ─┬─→ Friend Graph (add/accept/remove)
                                           └─→ Squad System (create/invite/join)

User Message → Intent Detection → Record across all user squads
                                       ↓
Scheduler (*/15 min) → Social Outbound Worker
    ├── Query PROACTIVE/ENGAGED users with squads
    ├── Detect correlated intents (2+ members, same category)
    ├── Format action cards
    └── Send via Telegram (inline keyboard)
```

## Commands

| Command | Description |
|---------|-------------|
| `/friend` | List friends and pending requests |
| `/friend add <user>` | Send friend request |
| `/friend remove <user>` | Remove friend |
| `/friend accept <user>` | Accept pending request |
| `/squad` | List your squads |
| `/squad create <name>` | Create a squad (max 5 per user) |
| `/squad invite <squad> <user>` | Invite member |
| `/squad join <name>` | Accept squad invite |
| `/squad leave <name>` | Leave or delete squad |

## Intent Categories

Messages are scanned for: `trip`, `food`, `nightlife`, `weekend`, `event`

When 2+ squad members mention the same category within 2 hours, a group recommendation is triggered.

## Action Cards

Cards are formatted for Telegram (inline keyboards) and WhatsApp (plain text). Types:
- **Trip Card** — venue details + directions/order/share buttons
- **Booking Card** — confirmation + share/cancel buttons
- **Group Plan Card** — squad intent summary + vote/find/share buttons

## Database Tables

- `user_relationships` — friend edges with status
- `squads` — named groups with creator
- `squad_members` — membership join table
- `squad_intents` — intent signals for aggregation
