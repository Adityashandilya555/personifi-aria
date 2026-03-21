import {
    handleMessage as handleMessageLegacy,
    resetUserSession as resetUserSessionLegacy,
    saveUserLocation as saveUserLocationLegacy,
    type MessageResponse
} from './handler-legacy.js';

import { handleMessageAlpha } from './handler-alpha.js';

import type { HandleMessageOptions } from './handler-legacy.js';

// Feature flag: set in .env
// ALPHA_HANDLER_ENABLED=true  → use new 5-step pipeline
// ALPHA_AB_MODE=true          → run BOTH, log comparison, return Alpha result
export async function handleMessage(
    channel: string,
    channelUserId: string,
    rawMessage: string,
    options: HandleMessageOptions = {}
): Promise<MessageResponse> {
    const useAlpha = process.env.ALPHA_HANDLER_ENABLED === 'true';
    const abMode = process.env.ALPHA_AB_MODE === 'true';

    // A/B comparison mode: run BOTH handlers, log both, return Alpha
    if (abMode) {
        console.log(`[Handler] A/B mode: running BOTH handlers`);
        const startLegacy = Date.now();
        const legacyResult = await handleMessageLegacy(channel, channelUserId, rawMessage, options)
            .catch(err => ({ text: `[LEGACY_ERROR] ${err.message}` } as MessageResponse));
        const legacyMs = Date.now() - startLegacy;

        const startAlpha = Date.now();
        const alphaResult = await handleMessageAlpha(channel, channelUserId, rawMessage, options)
            .catch(err => ({ text: `[ALPHA_ERROR] ${err.message}` } as MessageResponse));
        const alphaMs = Date.now() - startAlpha;

        console.log(`[Handler/AB] Legacy: ${legacyMs}ms | Alpha: ${alphaMs}ms`);
        console.log(`[Handler/AB] Legacy response: ${legacyResult.text.slice(0, 120)}`);
        console.log(`[Handler/AB] Alpha  response: ${alphaResult.text.slice(0, 120)}`);

        // Return the Alpha result (new pipeline), but log both for comparison
        return alphaResult;
    }

    if (useAlpha) {
        console.log(`[Handler] Using alpha handler (ALPHA_HANDLER_ENABLED=true)`);
        return handleMessageAlpha(channel, channelUserId, rawMessage, options);
    }
    console.log(`[Handler] Using legacy handler (ALPHA_HANDLER_ENABLED=false)`);
    return handleMessageLegacy(channel, channelUserId, rawMessage, options);
}

// Pass-through exports
export function resetUserSession(channel: string, channelUserId: string) {
    return resetUserSessionLegacy(channel, channelUserId);
}

export function saveUserLocation(userId: string, location: string) {
    return saveUserLocationLegacy(userId, location);
}

export type { MessageResponse };
