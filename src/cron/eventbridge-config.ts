/**
 * EventBridge Rule Definitions — Issue #93 (PR 5 of 8)
 *
 * Type-safe configuration for all EventBridge cron rules that trigger the
 * proactive engagement Lambda. These definitions mirror the existing node-cron
 * cadences in scheduler.ts and serve as both runtime reference and IaC input.
 *
 * Usage:
 *   - Runtime: lambda-handler.ts uses event detail types to route invocations
 *   - IaC:     listRuleDefinitions() emits JSON for CloudFormation / Terraform
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EventBridgeRuleConfig {
    /** Unique rule name — used as EventBridge rule Name */
    readonly ruleName: string

    /** EventBridge schedule expression (cron or rate) */
    readonly scheduleExpression: string

    /** Detail type in the EventBridge event — used for routing in lambda-handler */
    readonly detailType: string

    /** Human-readable description for the EventBridge rule */
    readonly description: string

    /** Whether the rule is enabled by default on creation */
    readonly enabled: boolean
}

// ─── Event Detail Types ───────────────────────────────────────────────────────

/**
 * All known event detail types. The lambda-handler routes on these values.
 * Keep this in sync with the handler's switch statement.
 */
export const EventDetailTypes = {
    PROACTIVE_ENGAGEMENT: 'proactive-engagement',
    TOPIC_FOLLOWUPS: 'topic-followups',
    STIMULUS_REFRESH: 'stimulus-refresh',
    SOCIAL_OUTBOUND: 'social-outbound',
    FRIEND_BRIDGE: 'friend-bridge',
    MEMORY_QUEUE: 'memory-queue',
    SESSION_SUMMARIZE: 'session-summarize',
    PRICE_ALERTS: 'price-alerts',
    INTELLIGENCE_CRON: 'intelligence-cron',
    STALE_TOPIC_SWEEP: 'stale-topic-sweep',
    RATE_LIMIT_CLEANUP: 'rate-limit-cleanup',
} as const

export type EventDetailType = (typeof EventDetailTypes)[keyof typeof EventDetailTypes]

// ─── Rule Definitions ─────────────────────────────────────────────────────────

/**
 * All EventBridge rule definitions for the proactive engagement pipeline.
 * Cadences match the existing node-cron schedules in scheduler.ts.
 *
 * EventBridge cron syntax: cron(min hour dom month dow year)
 * Note: EventBridge uses 6-field cron, not 5-field like node-cron.
 */
const RULE_DEFINITIONS: readonly EventBridgeRuleConfig[] = [
    {
        ruleName: 'aria-topic-followups',
        scheduleExpression: 'rate(30 minutes)',
        detailType: EventDetailTypes.TOPIC_FOLLOWUPS,
        description: 'Topic follow-ups — checks warm topics (confidence >25%, inactive 4h+) and sends natural follow-ups',
        enabled: true,
    },
    {
        ruleName: 'aria-proactive-engagement',
        scheduleExpression: 'rate(2 hours)',
        detailType: EventDetailTypes.PROACTIVE_ENGAGEMENT,
        description: 'Content blast pipeline — generic content blast when no warm topics exist',
        enabled: true,
    },
    {
        ruleName: 'aria-social-outbound',
        scheduleExpression: 'rate(15 minutes)',
        detailType: EventDetailTypes.SOCIAL_OUTBOUND,
        description: 'Social outbound worker — processes pending social interactions',
        enabled: true,
    },
    {
        ruleName: 'aria-stimulus-refresh',
        scheduleExpression: 'rate(30 minutes)',
        detailType: EventDetailTypes.STIMULUS_REFRESH,
        description: 'Stimulus refresh (weather + traffic + festival) for all active user locations',
        enabled: true,
    },
    {
        ruleName: 'aria-friend-bridge',
        scheduleExpression: 'rate(30 minutes)',
        detailType: EventDetailTypes.FRIEND_BRIDGE,
        description: 'Social friend bridge — outbound friend-based messaging',
        enabled: true,
    },
    {
        ruleName: 'aria-price-alerts',
        scheduleExpression: 'rate(30 minutes)',
        detailType: EventDetailTypes.PRICE_ALERTS,
        description: 'Price alert checks for monitored items',
        enabled: true,
    },
    {
        ruleName: 'aria-intelligence-cron',
        scheduleExpression: 'rate(2 hours)',
        detailType: EventDetailTypes.INTELLIGENCE_CRON,
        description: 'Intelligence model weight and preference updates',
        enabled: true,
    },
    {
        ruleName: 'aria-session-summarize',
        scheduleExpression: 'rate(5 minutes)',
        detailType: EventDetailTypes.SESSION_SUMMARIZE,
        description: 'Archivist session summarization — summarizes completed sessions',
        enabled: true,
    },
    {
        ruleName: 'aria-memory-queue',
        scheduleExpression: 'rate(1 minute)',
        detailType: EventDetailTypes.MEMORY_QUEUE,
        description: 'Archivist memory write queue — processes pending memory writes (30s batch in Lambda)',
        enabled: true,
    },
    {
        ruleName: 'aria-rate-limit-cleanup',
        scheduleExpression: 'rate(1 hour)',
        detailType: EventDetailTypes.RATE_LIMIT_CLEANUP,
        description: 'Rate limit cleanup — removes expired rate limit entries',
        enabled: true,
    },
    {
        ruleName: 'aria-stale-topic-sweep',
        scheduleExpression: 'rate(1 hour)',
        detailType: EventDetailTypes.STALE_TOPIC_SWEEP,
        description: 'Stale topic sweep — auto-abandons topics with no signal for 72h',
        enabled: true,
    },
]

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Get all EventBridge rule definitions.
 * Used by lambda-handler for routing and by IaC/tooling for provisioning.
 */
export function listRuleDefinitions(): readonly EventBridgeRuleConfig[] {
    return RULE_DEFINITIONS
}

/**
 * Get a single rule definition by detail type.
 */
export function getRuleByDetailType(detailType: string): EventBridgeRuleConfig | undefined {
    return RULE_DEFINITIONS.find(r => r.detailType === detailType)
}

/**
 * Export all rule definitions as a JSON string suitable for CloudFormation
 * or Terraform resource generation.
 *
 * Each rule maps to an EventBridge Rule + Target pointing to the proactive Lambda.
 *
 * @param lambdaArn - The ARN of the Lambda function to target
 * @returns JSON string with CloudFormation-style resource definitions
 */
export function exportRulesAsCloudFormation(lambdaArn: string): string {
    const resources: Record<string, object> = {}

    for (const rule of RULE_DEFINITIONS) {
        const logicalId = rule.ruleName
            .replace(/^aria-/, '')
            .replace(/-([a-z])/g, (_, c) => c.toUpperCase())

        resources[`AriaRule${logicalId.charAt(0).toUpperCase() + logicalId.slice(1)}`] = {
            Type: 'AWS::Events::Rule',
            Properties: {
                Name: rule.ruleName,
                Description: rule.description,
                ScheduleExpression: rule.scheduleExpression,
                State: rule.enabled ? 'ENABLED' : 'DISABLED',
                Targets: [
                    {
                        Arn: lambdaArn,
                        Id: `${rule.ruleName}-target`,
                        Input: JSON.stringify({
                            'detail-type': rule.detailType,
                            source: 'aria.proactive',
                        }),
                    },
                ],
            },
        }
    }

    return JSON.stringify({ Resources: resources }, null, 2)
}
