import { describe, it, expect } from 'vitest';
import { buildContext, compressToolResults, countTokens, MAX_TOKENS } from './context-manager.js';

describe('Context Manager', () => {
    it('empty context stays within budget', () => {
        const result = buildContext('', { userContext: '', pulseTopics: '', history: [] }, '');
        expect(countTokens(result.soul)).toBe(0);
    });

    it('max history + large tool result gets truncated to fit', () => {
        const longHistory = Array(50).fill({ role: 'user', content: 'A'.repeat(800) }); // 50 * 200 = 10000 tokens
        const largeToolResult = 'B'.repeat(10000); // 2500 tokens
        
        const result = buildContext('soul', {
            userContext: 'ctx',
            pulseTopics: 'pulse',
            history: longHistory,
            toolResults: largeToolResult
        }, 'proactive');

        // Total should be exactly or very close to MAX_TOKENS (8192)
        const total = countTokens(result.soul) 
                    + countTokens(result.userContext) 
                    + countTokens(result.proactiveState) 
                    + countTokens(result.pulseTopics) 
                    + result.history.reduce((a, m) => a + countTokens(m.content), 0) 
                    + countTokens(result.toolResults);
        
        expect(total).toBeLessThanOrEqual(MAX_TOKENS);
    });

    it('ProactiveState injection is counted in budget', () => {
         const proactive = 'P'.repeat(1200); // 300 tokens
         const result = buildContext('soul', { userContext: '', pulseTopics: '', history: [] }, proactive);
         expect(countTokens(result.proactiveState)).toBe(300);
    });

    it('compression reduces tool output by >= 50%', () => {
         const largeJson = JSON.stringify(Array(400).fill({ prop: "very long property value that takes up space" }));
         const originalTokens = countTokens(largeJson);
         const compressed = compressToolResults(largeJson, 800);
         const newTokens = countTokens(compressed);
         
         expect(newTokens).toBeLessThanOrEqual(800);
         expect(newTokens).toBeLessThan(originalTokens / 2);
    });
});
