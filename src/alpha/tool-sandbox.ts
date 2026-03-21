export interface ToolSchema {
    type: 'function';
    function: {
        name: string;
        description: string;
        parameters: {
            type: 'object';
            properties: Record<string, any>;
            required?: string[];
        };
    };
}

export interface ValidationResult {
    valid: boolean;
    toolName: string;
    args: Record<string, any>;
    error?: string;
    repairAttempted?: boolean;
}

const rateLimits = new Map<string, { count: number; resetAt: number }>();

export class ToolSandbox {
    private definitions: ToolSchema[];

    constructor(definitions: ToolSchema[]) {
        this.definitions = definitions;
    }

    private checkRateLimit(userId: string, toolName: string, maxCalls: number = 5): boolean {
        const key = `${userId}:${toolName}`;
        const now = Date.now();
        
        let record = rateLimits.get(key);
        if (!record || record.resetAt < now) {
            record = { count: 1, resetAt: now + 60000 };
            rateLimits.set(key, record);
            return true;
        }

        if (record.count >= maxCalls) {
            return false;
        }

        record.count++;
        return true;
    }

    private repairJson(jsonStr: string): Record<string, any> | null {
        // very basic repair attempts
        let trimmed = jsonStr.trim();
        
        if (!trimmed.endsWith('}')) {
            try { return JSON.parse(trimmed + '}'); } catch {}
            try { return JSON.parse(trimmed + '"}'); } catch {}
        }
        
        // try replacing single quotes with double quotes
        try {
            return JSON.parse(trimmed.replace(/'/g, '"'));
        } catch {}

        return null; // giving up
    }

    private coerceArgs(parsed: Record<string, any>, schema: ToolSchema): Record<string, any> {
        const props = schema.function.parameters.properties;
        const coerced = { ...parsed };
        for (const [key, propSchema] of Object.entries(props)) {
            if (key in coerced && propSchema.type === 'number' && typeof coerced[key] === 'string') {
                const num = Number(coerced[key]);
                if (!isNaN(num)) {
                    coerced[key] = num;
                }
            }
            if (key in coerced && propSchema.type === 'boolean' && typeof coerced[key] === 'string') {
                if (coerced[key].toLowerCase() === 'true') coerced[key] = true;
                if (coerced[key].toLowerCase() === 'false') coerced[key] = false;
            }
        }
        return coerced;
    }

    private checkSchema(args: Record<string, any>, schema: ToolSchema): { pass: boolean, missing?: string } {
        const required = schema.function.parameters.required || [];
        for (const req of required) {
            if (!(req in args) || args[req] === undefined || args[req] === null) {
                return { pass: false, missing: req };
            }
        }
        return { pass: true };
    }

    public validateToolCall(
        userId: string,
        toolName: string,
        argsStr: string,
        userContext?: Record<string, any> // mock user context for default injection
    ): ValidationResult {
        // Rate limiting
        if (!this.checkRateLimit(userId, toolName)) {
            console.log(`[Alpha/Sandbox] REJECTED rate limit exceeded: "${toolName}"`);
            return { valid: false, toolName, args: {}, error: 'Rate limit exceeded for tool' };
        }

        // Phantom tool rejection
        const schema = this.definitions.find(d => d.function.name === toolName);
        if (!schema) {
            console.log(`[Alpha/Sandbox] REJECTED phantom tool: "${toolName}" — not in schema`);
            return { valid: false, toolName, args: {}, error: 'Tool not found in definitions' };
        }

        let parsed: Record<string, any>;
        let repairAttempted = false;

        try {
            parsed = JSON.parse(argsStr || '{}');
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
                return { valid: false, toolName, args: {}, error: 'Parsed arguments did not yield an object.' };
            }
        } catch (e) {
            // Attempt simple JSON repair
            const repaired = this.repairJson(argsStr);
            if (repaired) {
                parsed = repaired;
                repairAttempted = true;
                console.log(`[Alpha/Sandbox] Repair attempt: fixed JSON syntax`);
            } else {
                return { valid: false, toolName, args: {}, error: 'Malformed JSON arguments' };
            }
        }

        // Type Coercion
        parsed = this.coerceArgs(parsed, schema);

        console.log(`[Alpha/Sandbox] Validating tool call: ${toolName} ${JSON.stringify(parsed)}`);

        // Schema check
        const schemaCheck = this.checkSchema(parsed, schema);
        if (!schemaCheck.pass) {
            console.log(`[Alpha/Sandbox] Schema check: FAIL — missing required field "${schemaCheck.missing}"`);
            
            // Repair attempt: inject from user context
            if (userContext && schemaCheck.missing! in userContext) {
                console.log(`[Alpha/Sandbox] Repair attempt: injected default from user context`);
                parsed[schemaCheck.missing!] = userContext[schemaCheck.missing!];
                repairAttempted = true;
                console.log(`[Alpha/Sandbox] Retry: PASS`);
            } else {
                return { valid: false, toolName, args: parsed, repairAttempted, error: `Missing required field "${schemaCheck.missing}"` };
            }
        } else {
            console.log(`[Alpha/Sandbox] Schema check: PASS`);
        }

        return { valid: true, toolName, args: parsed, repairAttempted };
    }
}
