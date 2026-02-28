/**
 * Inline Media Selector — Issue #65
 *
 * Glue layer between the Influence Strategy Engine's `mediaHint` signal
 * and the existing ReelPipeline. Called concurrently with the 70B LLM
 * during the conversation pipeline so there is zero extra latency.
 *
 * Flow:
 *   influenceStrategy.mediaHint = true
 *     → deriveHashtagFromContext(message, pulseState)   — context-aware
 *     → fetchReels(hashtag, userId, 3)                 — DB-first pipeline
 *     → pickBestReel(results, userId)                  — validate + dedup
 *     → map ReelResult → MediaItem                     — for channel delivery
 *
 * Failure at any step returns null — Aria gracefully falls back to text-only.
 */

import type { MediaItem } from './channels.js'
import type { EngagementState } from './influence-engine.js'
import { fetchReels, pickBestReel } from './media/reelPipeline.js'
import {
    scoreUserInterests,
    enrichScoresFromPreferences,
    selectContentForUser,
    recordContentSent,
    CATEGORY_HASHTAGS,
} from './media/contentIntelligence.js'

// ─── Context → Hashtag Mapping ───────────────────────────────────────────────

/**
 * Hashtag rules ordered by specificity. First match wins.
 * Designed for Bengaluru-centric food and lifestyle content.
 */
const CONTEXT_RULES: Array<{ pattern: RegExp; hashtags: string[] }> = [
    {
        pattern: /biryani|dum|hyderabadi|lucknowi/i,
        hashtags: ['bangalorebiryani', 'bangalorefood', 'nammabengalurufood'],
    },
    {
        pattern: /darshini|idli|dosa|vada|filter\s?coffee|kaapi|udupi|breakfast/i,
        hashtags: ['bangaloreidli', 'bangaloredosa', 'filterkaapi', 'bengalurubreakfast'],
    },
    {
        pattern: /street\s?food|pani\s?puri|chaat|vvpuram|snack|chaatwalah/i,
        hashtags: ['bangalorestreetfood', 'vvpuramfoodstreet', 'bangaloresnacks'],
    },
    {
        pattern: /cafe|coffee|third\s?wave|pour.?over|specialty|latte|cappuccino/i,
        hashtags: ['bangalorecafe', 'bangalorecoffee', 'specialtycoffeebangalore'],
    },
    {
        pattern: /beer|brewery|craft|pub|bar|nightlife|indiranagar|koramangala/i,
        hashtags: ['bangalorebrew', 'craftbeerbangalore', 'bangalorebar'],
    },
    {
        pattern: /restaurant|food|eat|hungry|dinner|lunch|meal|dish|order/i,
        hashtags: ['bangalorefood', 'bangalorefoodie', 'bangalorehiddengems'],
    },
    {
        pattern: /place|spot|area|neighbourhood|go|visit|explore|weekend|hangout/i,
        hashtags: ['bangalorehidden', 'bangalorethingstodo', 'bangaloreweekend'],
    },
    {
        pattern: /event|market|pop.?up|workshop|live|show|concert|fest/i,
        hashtags: ['bangaloreevent', 'bengaluruevent', 'bangaloreweekend'],
    },
    {
        pattern: /budget|cheap|under|affordable|deal|offer/i,
        hashtags: ['bangalorefoodunder200', 'budgetbangalore', 'bangalorethali'],
    },
]

/**
 * Derive the most context-appropriate hashtag from the user's message.
 * Falls back to content intelligence scoring when no keyword matches.
 *
 * @param message  The user's latest message text
 * @param userId   Used for content intelligence fallback (preference-aware)
 */
export async function deriveHashtagFromContext(
    message: string,
    userId: string,
): Promise<string> {
    // 1. Keyword-based match (fast path, no DB)
    for (const rule of CONTEXT_RULES) {
        if (rule.pattern.test(message)) {
            const idx = Math.floor(Math.random() * rule.hashtags.length)
            return rule.hashtags[idx]
        }
    }

    // 2. Content intelligence fallback — preference-aware, time-aware
    try {
        const baseScores = scoreUserInterests(userId)
        const enriched = await enrichScoresFromPreferences(userId, baseScores)
        const selection = selectContentForUser(userId, enriched)
        if (selection) return selection.hashtag
    } catch {
        // Non-fatal — fall through to hardcoded default
    }

    // 3. Safe default
    return 'bangalorefood'
}

// ─── Main Public API ──────────────────────────────────────────────────────────

/**
 * Select a single inline media item for this conversation turn.
 *
 * Returns null when:
 *   - mediaHint is false (no media requested by influence strategy)
 *   - The reel pipeline returns no results for the derived hashtag
 *   - Any error occurs (always degrades gracefully to text-only)
 *
 * @param userId          Internal user ID (for dedup tracking)
 * @param message         User's latest message (for context-aware hashtag)
 * @param mediaHint       Whether the influence strategy requests media
 * @param pulseState      Current engagement state (informational, for future use)
 */
export async function selectInlineMedia(
    userId: string,
    message: string,
    mediaHint: boolean,
    _pulseState?: EngagementState,
): Promise<MediaItem | null> {
    // Fast path — influence engine didn't request media this turn
    if (!mediaHint) return null

    try {
        // 1. Derive a content-appropriate hashtag from conversation context
        const hashtag = await deriveHashtagFromContext(message, userId)

        // 2. Fetch candidates from DB-first pipeline (cached 30min, free)
        const results = await fetchReels(hashtag, userId, 3)
        if (results.length === 0) {
            console.log(`[InlineMedia] No reels for #${hashtag} — falling back to text`)
            return null
        }

        // 3. Pick best validated reel (validates URL, marks sent for dedup)
        const reel = await pickBestReel(results, userId)
        if (!reel) {
            console.log(`[InlineMedia] All reels invalid for #${hashtag}`)
            return null
        }

        // 4. Record for content intelligence state (avoids repeat categories)
        for (const [cat, hashtags] of Object.entries(CATEGORY_HASHTAGS)) {
            if ((hashtags as string[]).includes(hashtag)) {
                recordContentSent(userId, cat as any, hashtag)
                break
            }
        }

        // 5. Map ReelResult → MediaItem for channel delivery
        // Derive type from the URL that was actually selected — not reel.type —
        // so a thumbnail fallback (when videoUrl is null) is never labelled 'video'.
        const url = reel.videoUrl || reel.thumbnailUrl
        if (!url) return null

        const mediaType: 'video' | 'photo' = reel.videoUrl ? 'video' : 'photo'

        const captionParts: string[] = []
        if (reel.caption) captionParts.push(reel.caption.slice(0, 200))
        if (reel.author && reel.author !== 'unknown') captionParts.push(`📸 @${reel.author}`)

        const mediaItem: MediaItem = {
            type: mediaType,
            url,
            caption: captionParts.length > 0 ? captionParts.join('\n') : undefined,
        }

        console.log(`[InlineMedia] Serving ${mediaType} from #${hashtag} (${reel.source}) to user ${userId}`)
        return mediaItem

    } catch (err: any) {
        // Never crash the main pipeline — media is always optional
        console.warn('[InlineMedia] Selection failed (non-fatal):', err?.message)
        return null
    }
}
