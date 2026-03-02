# Proactive Agent Gap Analysis

## Goal reviewed
Target behavior: an always-on proactive companion that consumes external stimuli (weather/traffic/festivals), uses friend-graph context for group planning, and can both act autonomously and stay engaging (including constructive pushback) during active conversations.

## Current blockers in the codebase

1. **Stimulus engines are city-locked and not user-personalized.**
   - Weather stimulus always calls `getWeather({ location: 'Bengaluru' })`.
   - Traffic stimulus uses fixed Bengaluru corridors + fixed test routes.
   - Festival suggestions are Bengaluru-centric and hardcoded by date.
   - Result: users outside Bengaluru (or with different home city/travel context) get irrelevant triggers.

2. **Stimulus-to-action is delayed and coarse-grained.**
   - Scheduler refreshes weather/traffic every 30 minutes and festivals every 6 hours.
   - This cadence is too slow for "rain just started", sudden congestion, or short-lived event opportunities.

3. **Proactive sends are explicitly blocked while user is active.**
   - Smart gate exits when recent user activity < 30 minutes.
   - Each stimulus sender also skips when inactivity < 60 minutes.
   - Result: the system does not do in-conversation proactive assistance; it mostly runs as re-engagement after silence.

4. **Group planning pipeline detects intent correlation, but does not execute planning tools.**
   - Squad intent detection is regex-category based.
   - Social outbound builds/sends action cards from correlated categories.
   - It does not chain `search_places`/`compare_*`/`directions` to produce concrete multi-option plans and deal-aware recommendations for the full group.

5. **Friend/squad graph usage is mostly command-driven, not conversationally autonomous.**
   - Friend/squad operations are triggered via `/friend` and `/squad` command parsing in the main handler.
   - There is no natural-language friend-graph orchestration pass (e.g., "plan this for my squad") that auto-invokes graph-aware planning workflows.

6. **Critical proactive state remains in-memory with restart sensitivity.**
   - Proactive user registry and cooldown maps are process-local maps.
   - Architecture docs also call out in-process cache/state constraints.
   - Result: behavior consistency drops on restart and across multi-instance deployments, weakening "always-on" proactive behavior.

7. **Constructive contradiction is incidental, not policy-driven.**
   - Mood engine includes a "devil" mode but only as a weighted tone blend.
   - No explicit disagreement policy (when to challenge, evidence threshold, safety bounds, or user preference controls) is wired into planning/execution.

## Practical impact on your requested behavior

- The agent is currently better at **periodic nudges** than **continuous proactive co-pilot behavior**.
- It can surface social signals, but not yet convert them into **end-to-end autonomous group trip planning** with dynamic options/deals.
- It does not yet robustly support **real-time multi-stimulus orchestration during active chat**.

## High-priority fix order

1. Personalize stimuli by user home city/current location and squad context.
2. Introduce an in-conversation proactive lane (non-intrusive helper actions while user is chatting).
3. Upgrade squad pipeline from "correlated intent card" to "tool-chained group planner".
4. Move proactive orchestration state to durable/shared storage (or Redis).
5. Add explicit contradiction policy (when/how to push back with evidence).
