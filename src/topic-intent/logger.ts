/**
 * Topic Intent Logger — Phase 7
 * Structured logging for topic signals, phase transitions, and strategy directives.
 */

import type { TopicPhase, IntentSignal } from './types.js'

export function logSignalRecorded(
    userId: string,
    topicId: string,
    topic: string,
    signal: IntentSignal,
    newConfidence: number,
): void {
    console.log('[topic-intent] signal_recorded', {
        userId,
        topicId,
        topic,
        signal: signal.signal,
        delta: signal.delta,
        newConfidence,
        ts: signal.timestamp,
    })
}

export function logPhaseTransition(
    userId: string,
    topicId: string,
    topic: string,
    fromPhase: TopicPhase,
    toPhase: TopicPhase,
    confidence: number,
): void {
    console.log('[topic-intent] phase_transition', {
        userId,
        topicId,
        topic,
        fromPhase,
        toPhase,
        confidence,
    })
}

export function logStrategyGenerated(
    userId: string,
    topic: string,
    phase: TopicPhase,
    confidence: number,
    strategyPreview: string,
): void {
    console.log('[topic-intent] strategy_generated', {
        userId,
        topic,
        phase,
        confidence,
        strategyPreview: strategyPreview.substring(0, 120),
    })
}

export function logProactiveFollowUp(
    userId: string,
    topicId: string,
    topic: string,
    confidence: number,
): void {
    console.log('[topic-intent] proactive_followup_sent', {
        userId,
        topicId,
        topic,
        confidence,
    })
}

export function logExecutionBridge(
    userId: string,
    topicId: string,
    topic: string,
    toolName: string,
): void {
    console.log(`[TopicIntent] Execution bridge: topic="${topic}" → tool=${toolName}`, {
        userId,
        topicId,
    })
}

export function logTopicCompleted(
    userId: string,
    topicId: string,
    topic: string,
): void {
    console.log(`[TopicIntent] Topic completed: topic="${topic}"`, {
        userId,
        topicId,
    })
}
