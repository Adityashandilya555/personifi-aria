import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from './alpha-caller.js';

describe('Alpha Caller', () => {
    it('builds system prompt correctly', () => {
        const prompt = buildSystemPrompt({
            soul: 'I am Aria.',
            userContext: 'Name: Aditya',
            proactiveState: '',
            pulseTopics: 'Pulse: ENGAGED',
            history: [],
            toolResults: 'Prices: ola 100'
        });

        expect(prompt).toContain('I am Aria.');
        expect(prompt).toContain('Name: Aditya');
        expect(prompt).toContain('Pulse: ENGAGED');
        expect(prompt).toContain('Prices: ola 100');
        expect(prompt).not.toContain('## Proactive State');
    });
});
