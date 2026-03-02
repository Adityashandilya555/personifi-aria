# Telegram + Proactive Agent Audit

## Scope
- Telegram webhook/message delivery path (`src/index.ts`, `src/channels.ts`, `src/proactive-intent/orchestrator.ts`).
- Proactive behavior orchestration and gating (`src/media/proactiveRunner.ts`, `src/scheduler.ts`).

## Key findings

### Fixed in this patch
1. **Telegram send failures could be silent after parse-mode fallback**
   - `telegramAdapter.sendMessage()` retried as plain text on HTML parse errors, but did not log if the retry also failed.
   - Added missing-token guard and explicit error logging for non-parse failures and failed retries.

2. **Proactive send accounting could increment even when no fallback text was delivered**
   - In media fallback, state was updated even if text fallback send failed.
   - Added a success check before calling `updateStateAfterSend()`.

3. **Companion media could be marked as sent even when upload failed**
   - Companion image path marked media as sent unconditionally.
   - Changed to mark only when `sendMediaViaPipeline()` returns success.

4. **Inconsistent daily proactive cap in topic follow-up mode**
   - Topic follow-ups used `>= 5` while the main smart gate enforces a lower global daily cap.
   - Aligned topic follow-ups to `DAILY_SEND_LIMIT` for consistent behavior.

5. **Proactive batch fairness issue**
   - `runProactiveForAllUsers()` always took `activeUsers.slice(0, 5)`, so users after the first five could starve.
   - Added a rotating cursor to cycle users across runs.

### Still-open risk to track
1. **Activity memory is process-local and resets on restart**
   - `userLastActivity` is in-memory only. After restart, inactivity for known users is treated as infinite, which can make retention logic behave like users have been idle for very long.
   - This is partially mitigated by daily caps/time windows, but still affects timing quality and personalization.

## Suggested next hardening steps
1. Persist last user activity to DB (or read from recent message timestamps) and hydrate on startup.
2. Add integration tests around proactive fairness (batch rotation) and send-accounting on delivery failures.
3. Normalize all Telegram send paths through one helper with uniform retry/error handling.
