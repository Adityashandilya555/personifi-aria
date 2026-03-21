import { generateResponse, ProviderResult, ChatMessage } from '../llm/tierManager.js';
import { getGroqTools, bodyHooks } from '../tools/index.js';
import { ToolSandbox } from './tool-sandbox.js';
import { AlphaContextBundle, compressToolResults } from './context-manager.js';

const sandbox = new ToolSandbox(getGroqTools() as any);

export interface AlphaCallerResult {
    content: string;
    toolCalls: Array<{ name: string; args: any }>;
    toolResults: Array<{ name: string; result: any }>;
    provider: string;
}

export function buildSystemPrompt(bundle: AlphaContextBundle): string {
    const parts = [bundle.soul];
    if (bundle.userContext) parts.push(`## User Context\n${bundle.userContext}`);
    if (bundle.pulseTopics) parts.push(`## Pulse & Topics\n${bundle.pulseTopics}`);
    if (bundle.proactiveState) parts.push(`## Proactive State\n${bundle.proactiveState}`);
    if (bundle.toolResults) parts.push(bundle.toolResults);
    return parts.join('\n\n');
}

export async function callAlpha(
    userId: string,
    bundle: AlphaContextBundle,
    userMessage: string
): Promise<AlphaCallerResult> {
    const messages: ChatMessage[] = [
        { role: 'system', content: buildSystemPrompt(bundle) },
        ...bundle.history,
        { role: 'user', content: userMessage }
    ];

    const tools = getGroqTools();

    console.log(`[Alpha] Call 1: Message classification and tool decision`);
    const start1 = Date.now();
    const call1Opts: any = { temperature: 0.7 };
    if (tools && tools.length > 0) {
        call1Opts.tools = tools;
        call1Opts.toolChoice = 'auto';
    }
    const res1 = await generateResponse(messages, call1Opts);
    console.log(`[Alpha] Provider: ${res1.provider} | Latency: ${Date.now() - start1}ms`);

    if (!res1.toolCalls || res1.toolCalls.length === 0) {
        console.log(`[Alpha] Decision: respond (no tool)`);
        return {
            content: res1.text,
            toolCalls: [],
            toolResults: [],
            provider: res1.provider
        };
    }

    const executedCalls = [];
    const executionResults = [];
    
    // Process tool calls
    for (const tc of res1.toolCalls) {
        const toolName = tc.function.name;
        const argsStr = tc.function.arguments;
        
        console.log(`[Alpha] Tool call: ${toolName} ${argsStr}`);
        
        const validRes = sandbox.validateToolCall(userId, toolName, argsStr);
        if (validRes.valid) {
            executedCalls.push({ name: toolName, args: validRes.args });
            
            console.log(`[Alpha/Tools] Executing: ${toolName}`);
            const tStart = Date.now();
            let execRes: any;
            try {
                execRes = await bodyHooks.executeTool(toolName, validRes.args);
            } catch (err: any) {
                console.error(`[Alpha/Tools] Exception executing ${toolName}:`, err);
                execRes = { error: err.message || 'Execution failed natively' };
            }
            console.log(`[Alpha/Tools] Executed ${toolName} in ${Date.now() - tStart}ms`);
            
            executionResults.push({ name: toolName, result: execRes });
            
            // Append to messages for Call 2
            const compressedRes = compressToolResults(JSON.stringify(execRes), 800, toolName);
            messages.push({ role: 'assistant', content: '', tool_calls: [tc] } as any);
            messages.push({ role: 'tool', content: compressedRes, tool_call_id: tc.id } as any);
        } else {
            console.log(`[Alpha/Tools] Validation failed: ${validRes.error}`);
            messages.push({ role: 'assistant', content: '', tool_calls: [tc] } as any);
            messages.push({ role: 'tool', content: JSON.stringify({ error: validRes.error }), tool_call_id: tc.id } as any);
        }
    }

    console.log(`[Alpha] Call 2: Response with tool result`);
    const start2 = Date.now();
    const res2 = await generateResponse(messages, {
        temperature: 0.7
    });
    console.log(`[Alpha] Provider: ${res2.provider} | Latency: ${Date.now() - start2}ms`);

    return {
        content: res2.text,
        toolCalls: executedCalls,
        toolResults: executionResults,
        provider: res2.provider
    };
}
