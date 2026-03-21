import { describe, it, expect, beforeEach } from 'vitest';
import { ToolSandbox, ToolSchema } from './tool-sandbox.js';

describe('Tool Sandbox', () => {
    const mockSchema: ToolSchema[] = [
        {
            type: 'function',
            function: {
                name: 'compare_rides',
                description: 'Compare ride prices',
                parameters: {
                    type: 'object',
                    properties: {
                        from: { type: 'string' },
                        to: { type: 'string' },
                        passengers: { type: 'number' }
                    },
                    required: ['from', 'to']
                }
            }
        }
    ];

    let sandbox: ToolSandbox;

    beforeEach(() => {
        sandbox = new ToolSandbox(mockSchema);
    });

    it('validates a correct tool call', () => {
        const res = sandbox.validateToolCall('user1', 'compare_rides', '{"from":"A", "to":"B"}');
        expect(res.valid).toBe(true);
        expect(res.args.from).toBe('A');
    });

    it('rejects phantom tool', () => {
        const res = sandbox.validateToolCall('user1', 'book_flight_now', '{"from":"A", "to":"B"}');
        expect(res.valid).toBe(false);
        expect(res.error).toContain('Tool not found');
    });

    it('repairs missing field from user context', () => {
        const res = sandbox.validateToolCall('user1', 'compare_rides', '{"from":"A"}', { to: "B" });
        expect(res.valid).toBe(true);
        expect(res.args.to).toBe("B");
        expect(res.repairAttempted).toBe(true);
    });

    it('coerces string to number', () => {
        const res = sandbox.validateToolCall('user1', 'compare_rides', '{"from":"A", "to":"B", "passengers": "2"}');
        expect(res.valid).toBe(true);
        expect(res.args.passengers).toBe(2);
    });

    it('rejects malformed json that cannot be repaired', () => {
        const res = sandbox.validateToolCall('user1', 'compare_rides', '{"from":"A", "to:');
        expect(res.valid).toBe(false);
    });

    it('enforces rate limits', () => {
        for (let i = 0; i < 5; i++) {
            sandbox.validateToolCall('ratelimit-user', 'compare_rides', '{"from":"A", "to":"B"}');
        }
        const res = sandbox.validateToolCall('ratelimit-user', 'compare_rides', '{"from":"A", "to":"B"}');
        expect(res.valid).toBe(false);
        expect(res.error).toContain('Rate limit');
    });
});
