import { ChatMessage } from '../llm/tierManager.js'

export const MAX_TOKENS = 6500; // Left headroom for Call 2 Tools + Output
export const MAX_TOOL_TOKENS = 800;

export interface AlphaContextBundle {
    soul: string;
    userContext: string;
    proactiveState: string;
    pulseTopics: string;
    history: ChatMessage[];
    toolResults: string;
}

export interface GatheredContext {
    userContext: string;
    pulseTopics: string;
    history: ChatMessage[];
    toolResults?: string;
    activeToolName?: string;
}

export function countTokens(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
}

export function compressToolResults(results: string, maxTokens: number = MAX_TOOL_TOKENS, toolName?: string): string {
    if (!results) return '';
    const currentTokens = countTokens(results);
    if (currentTokens <= maxTokens) return results;

    const maxChars = maxTokens * 4;
    const nameStr = toolName ? ` (${toolName})` : '';
    console.log(`[Alpha/Context] Tool result compressed: ${currentTokens} → ${maxTokens} tokens${nameStr}`);
    
    // Quick JSON array truncation attempt
    try {
        const parsed = JSON.parse(results);
        if (Array.isArray(parsed)) {
            const truncated: any[] = [];
            for (const item of parsed) {
                truncated.push(item);
                if (countTokens(JSON.stringify(truncated)) > maxTokens) {
                    truncated.pop();
                    break;
                }
            }
            if (truncated.length > 0) {
                return JSON.stringify(truncated);
            }
        }
    } catch {
        // Fall back to string slice
    }

    return results.slice(0, maxChars);
}

export function truncateHistory(history: ChatMessage[], targetTokens: number): { truncated: ChatMessage[]; newTokens: number } {
    let currentTokens = history.reduce((acc, msg) => acc + countTokens(msg.content), 0);
    if (currentTokens <= targetTokens) return { truncated: history, newTokens: currentTokens };

    const systemMsgs = history.filter(m => m.role === 'system');
    const nonSystemMsgs = history.filter(m => m.role !== 'system');
    let systemTokens = systemMsgs.reduce((acc, m) => acc + countTokens(m.content), 0);

    const resultNonSystem: ChatMessage[] = [];
    let allocated = systemTokens;

    // newest messages first
    for (let i = nonSystemMsgs.length - 1; i >= 0; i--) {
        const msg = nonSystemMsgs[i];
        const msgTokens = countTokens(msg.content);
        if (allocated + msgTokens <= targetTokens) {
            resultNonSystem.unshift(msg);
            allocated += msgTokens;
        } else {
            break;
        }
    }

    return { truncated: [...systemMsgs, ...resultNonSystem], newTokens: allocated };
}

export function buildContext(
    soul: string,
    gathered: GatheredContext,
    proactiveState: string
): AlphaContextBundle {
    const tsoul = countTokens(soul);
    let tuser = countTokens(gathered.userContext);
    let tproact = countTokens(proactiveState);
    let tpulse = countTokens(gathered.pulseTopics);
    
    let compressedTools = compressToolResults(gathered.toolResults || '', MAX_TOOL_TOKENS, gathered.activeToolName);
    let ttools = countTokens(compressedTools);
    
    let thistory = gathered.history.reduce((acc, msg) => acc + countTokens(msg.content), 0);

    let total = tsoul + tuser + tproact + tpulse + thistory + ttools;
    let finalHistory = gathered.history;

    if (total > MAX_TOKENS) {
        // Trim history
        const allowedHistory = Math.max(0, MAX_TOKENS - (total - thistory));
        if (allowedHistory < thistory) {
            const result = truncateHistory(finalHistory, allowedHistory);
            console.log(`[Alpha/Context] OVERFLOW: ${total}/${MAX_TOKENS} — trimming history (${thistory} → ${result.newTokens} tokens)`);
            finalHistory = result.truncated;
            thistory = result.newTokens;
            total = tsoul + tuser + tproact + tpulse + thistory + ttools;
        }

        // Trim tools
        if (total > MAX_TOKENS) {
            const allowedTools = Math.max(0, MAX_TOKENS - (total - ttools));
            compressedTools = compressToolResults(compressedTools, allowedTools, gathered.activeToolName);
            ttools = countTokens(compressedTools);
            total = tsoul + tuser + tproact + tpulse + thistory + ttools;
        }

        // Trim user context
        if (total > MAX_TOKENS) {
            const allowedUser = Math.max(0, MAX_TOKENS - (total - tuser));
            gathered.userContext = gathered.userContext.slice(0, allowedUser * 4);
            tuser = countTokens(gathered.userContext);
            total = tsoul + tuser + tproact + tpulse + thistory + ttools;
        }
        
        // Trim proactive state
        if (total > MAX_TOKENS) {
            const allowedProact = Math.max(0, MAX_TOKENS - (total - tproact));
            proactiveState = proactiveState.slice(0, allowedProact * 4);
            tproact = countTokens(proactiveState);
            total = tsoul + tuser + tproact + tpulse + thistory + ttools;
        }
    }

    console.log(`[Alpha/Context] Budget: soul=${tsoul} ctx=${tuser} proactive=${tproact} pulse=${tpulse} history=${thistory} tools=${ttools} total=${total}/${MAX_TOKENS}`);

    return {
        soul,
        userContext: gathered.userContext,
        proactiveState,
        pulseTopics: gathered.pulseTopics,
        history: finalHistory,
        toolResults: compressedTools
    };
}
