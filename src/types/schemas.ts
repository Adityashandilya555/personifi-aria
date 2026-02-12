/**
 * Zod Validation Schemas — DEV 3: The Soul (Hybrid Architecture)
 *
 * Runtime validation for LLM JSON responses.
 * Every LLM extraction step returns JSON that we JSON.parse() — but LLMs
 * hallucinate keys, omit fields, return wrong types. Zod catches these
 * at parse-time with `.safeParse()` so we can fall back gracefully.
 *
 * Usage:
 *   const result = FactExtractionSchema.safeParse(JSON.parse(llmOutput))
 *   if (!result.success) return []  // Fallback
 *   return result.data.facts        // Type-safe
 */

import { z } from 'zod'

// ═══════════════════════════════════════════════════════════════════════════
// 1. FACT EXTRACTION — mem0 pipeline step 1
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Schema for the fact extraction LLM response.
 * Expected: { "facts": ["fact1", "fact2", ...] }
 *
 * Coercion: if `facts` is missing, defaults to empty array.
 * Filtering: strips empty strings and non-string values.
 */
export const FactExtractionSchema = z.object({
    facts: z.array(
        z.string().min(1)
    ).default([]),
})

export type FactExtraction = z.infer<typeof FactExtractionSchema>

// ═══════════════════════════════════════════════════════════════════════════
// 2. MEMORY DECISION — mem0 pipeline step 6 (the UUID→int→decision step)
// ═══════════════════════════════════════════════════════════════════════════

/** Valid memory action events */
export const MemoryEventSchema = z.enum(['ADD', 'UPDATE', 'DELETE', 'NONE'])

/**
 * A single memory action from the LLM.
 * Note: `id` is a string because it's a sequential integer ("0", "1", "2")
 * during LLM processing, mapped back to UUIDs after.
 */
export const MemoryActionSchema = z.object({
    id: z.union([z.string(), z.number()]).transform(String),
    text: z.string().default(''),
    event: MemoryEventSchema,
    old_memory: z.string().optional(),
})

/**
 * Schema for the memory decision LLM response.
 * Expected: { "memory": [{ id, text, event, old_memory? }] }
 */
export const MemoryDecisionSchema = z.object({
    memory: z.array(MemoryActionSchema).default([]),
})

export type MemoryDecision = z.infer<typeof MemoryDecisionSchema>

// ═══════════════════════════════════════════════════════════════════════════
// 3. ENTITY EXTRACTION — graph pipeline step 1
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A single extracted entity.
 */
export const GraphEntitySchema = z.object({
    entity: z.string().min(1),
    entity_type: z.string().default('unknown'),
})

/**
 * Schema for the entity extraction LLM response.
 * Expected: { "entities": [{ entity, entity_type }] }
 */
export const EntityExtractionSchema = z.object({
    entities: z.array(GraphEntitySchema).default([]),
})

export type EntityExtraction = z.infer<typeof EntityExtractionSchema>

// ═══════════════════════════════════════════════════════════════════════════
// 4. RELATION EXTRACTION — graph pipeline step 2
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A single extracted relation.
 */
export const GraphRelationSchema = z.object({
    source: z.string().min(1),
    relationship: z.string().min(1),
    destination: z.string().min(1),
})

/**
 * Schema for the relation extraction LLM response.
 * Expected: { "relations": [{ source, relationship, destination }] }
 */
export const RelationExtractionSchema = z.object({
    relations: z.array(GraphRelationSchema).default([]),
})

export type RelationExtraction = z.infer<typeof RelationExtractionSchema>

// ═══════════════════════════════════════════════════════════════════════════
// 5. CONTRADICTION DETECTION — graph pipeline step 5
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Schema for the contradiction detection LLM response.
 * Expected: { "to_delete": [{ source, relationship, destination }] }
 */
export const ContradictionDetectionSchema = z.object({
    to_delete: z.array(GraphRelationSchema).default([]),
})

export type ContradictionDetection = z.infer<typeof ContradictionDetectionSchema>

// ═══════════════════════════════════════════════════════════════════════════
// 6. COGNITIVE ANALYSIS — pre-response analysis
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Valid emotional states (matches cognitive.ts EmotionalState type).
 */
export const EmotionalStateSchema = z.enum([
    'excited', 'frustrated', 'curious', 'neutral',
    'anxious', 'grateful', 'nostalgic', 'overwhelmed',
])

/**
 * Valid conversation goals (matches cognitive.ts ConversationGoal type).
 */
export const ConversationGoalSchema = z.enum([
    'inform', 'recommend', 'clarify', 'empathize',
    'redirect', 'upsell', 'plan', 'reassure',
])

/**
 * Schema for the cognitive analysis LLM response.
 */
export const CognitiveAnalysisSchema = z.object({
    internal_monologue: z.string().default('Processing user message.'),
    emotional_state: EmotionalStateSchema.default('neutral'),
    conversation_goal: ConversationGoalSchema.default('inform'),
    relevant_memories: z.array(z.string()).default([]),
})

export type CognitiveAnalysis = z.infer<typeof CognitiveAnalysisSchema>

// ═══════════════════════════════════════════════════════════════════════════
// 7. MESSAGE CLASSIFIER — 8B gate for token savings
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Valid message complexity levels.
 */
export const MessageComplexitySchema = z.enum(['simple', 'moderate', 'complex'])

/**
 * Schema for the 8B classifier response.
 * Validates the JSON output from classifyMessage().
 */
export const ClassifierResultSchema = z.object({
    message_complexity: MessageComplexitySchema.default('moderate'),
    needs_tool: z.boolean().default(false),
    tool_hint: z.string().nullable().default(null),
    skip_memory: z.boolean().default(false),
    skip_graph: z.boolean().default(false),
    skip_cognitive: z.boolean().default(false),
})

export type ClassifierResultParsed = z.infer<typeof ClassifierResultSchema>

// ═══════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Safely parse LLM JSON output with a Zod schema.
 * Returns the parsed+validated data or null on any failure.
 *
 * Usage:
 *   const data = safeParseLLM(llmJsonString, FactExtractionSchema)
 *   if (!data) return []  // fallback
 *   return data.facts     // type-safe
 */
export function safeParseLLM<T extends z.ZodTypeAny>(
    raw: string | null | undefined,
    schema: T
): z.infer<T> | null {
    if (!raw) return null

    try {
        const parsed = JSON.parse(raw)
        const result = schema.safeParse(parsed)
        if (result.success) {
            return result.data
        }
        console.warn('[schemas] Zod validation failed:', result.error.issues)
        return null
    } catch (err) {
        console.warn('[schemas] JSON parse failed:', err)
        return null
    }
}
