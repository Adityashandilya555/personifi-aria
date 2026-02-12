/**
 * Memory Pipeline Types — DEV 3: The Soul (Hybrid Architecture)
 *
 * Centralized type definitions for the entire memory pipeline.
 * Combines mem0's atomic-fact model with Letta's consolidated-block model.
 *
 * Architecture:
 *   mem0 side  → MemoryFact, MemoryAction, AddMemoryParams (ingestion)
 *   Letta side → MemoryBlock, MemoryBlockLabel (presentation)
 *   Graph side → GraphEntity, GraphRelation (knowledge graph)
 *   Shared     → MemorySearchResult, MemoryHistoryEntry
 */

// ═══════════════════════════════════════════════════════════════════════════
// 1. MEMORY FACTS — Atomic units of knowledge (mem0 pattern)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A single stored memory fact.
 * Maps to the `memories` table row.
 */
export interface MemoryFact {
    /** UUID primary key from PostgreSQL */
    id: string
    /** The fact text content, e.g. "Is vegetarian", "Budget is $2000" */
    memory: string
    /** MD5 hash for deduplication */
    hash?: string
    /** Cosine similarity score (only present in search results) */
    score?: number
    /** ISO timestamp of creation */
    createdAt?: string
    /** ISO timestamp of last update */
    updatedAt?: string
    /** Arbitrary metadata (categories, source, etc.) */
    metadata?: Record<string, unknown>
}

/**
 * An LLM-decided action on a memory fact.
 * Output of the UUID→integer→decision pipeline.
 *
 * IDs here are **sequential integers** (mem0 trick) during LLM processing,
 * mapped back to real UUIDs before execution.
 */
export interface MemoryAction {
    /** Sequential integer ID (during LLM) or real UUID (after mapping) */
    id: string
    /** The fact text (new content for ADD, updated content for UPDATE) */
    text: string
    /** The decision: ADD new, UPDATE existing, DELETE existing, or NONE */
    event: 'ADD' | 'UPDATE' | 'DELETE' | 'NONE'
    /** Original text before update (only for UPDATE events) */
    old_memory?: string
}

/**
 * Parameters for the memory ingestion pipeline.
 * Passed to `addMemories()` to drive the full mem0 pipeline.
 */
export interface AddMemoryParams {
    /** User UUID from the `users` table */
    userId: string
    /** The raw user message to extract facts from */
    message: string
    /** Recent conversation history for context */
    history?: Array<{ role: string; content: string }>
    /** Optional metadata to attach to new memories */
    metadata?: Record<string, unknown>
}

/**
 * Result of a memory ingestion run.
 */
export interface AddMemoryResult {
    /** Newly created MemoryFact items */
    results: MemoryFact[]
    /** All actions taken (ADD/UPDATE/DELETE) */
    actions: MemoryAction[]
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. MEMORY BLOCKS — Consolidated text blocks (Letta pattern)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Well-known block labels.
 * Each label is a distinct "section" of the agent's working memory.
 *
 * - `persona`:  Aria's personality and behavioral guidelines (read-only base)
 * - `human`:    Consolidated profile of the user (rewritten by rethink jobs)
 * - `goals`:    User's active travel goals and plans
 * - `preferences`: User's stable preferences (dietary, accommodation, etc.)
 */
export type MemoryBlockLabel = 'persona' | 'human' | 'goals' | 'preferences'

/**
 * A single memory block (Letta Block concept).
 * Maps to the `memory_blocks` table row.
 *
 * Key design: blocks have a **character limit**. When the block is nearing
 * its limit, the rethink job consolidates and trims content.
 */
export interface MemoryBlock {
    /** UUID primary key */
    id: string
    /** User UUID (null for system-level blocks like persona) */
    userId: string | null
    /** Block label — determines where this appears in the system prompt */
    label: MemoryBlockLabel
    /** The actual text content of the block */
    value: string
    /** Maximum characters allowed (soft limit for LLM awareness) */
    limit: number
    /** Description of the block's purpose (shown to LLM in metadata) */
    description: string
    /** Whether the agent can modify this block via tools */
    readOnly: boolean
    /** ISO timestamp of creation */
    createdAt?: string
    /** ISO timestamp of last update */
    updatedAt?: string
}

/**
 * Rendered XML representation of memory blocks for system prompt injection.
 * Letta renders blocks as:
 *   <memory_blocks>
 *     <persona><value>...</value><metadata>chars=X/Y</metadata></persona>
 *     <human><value>...</value><metadata>chars=X/Y</metadata></human>
 *   </memory_blocks>
 */
export interface RenderedBlockMetadata {
    /** Current character count of the block value */
    charsCurrent: number
    /** Maximum character limit */
    charsLimit: number
    /** Percentage of limit used (0-100) */
    utilization: number
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. GRAPH MEMORY — Entity-relationship knowledge graph
// ═══════════════════════════════════════════════════════════════════════════

/**
 * An extracted entity from user text.
 * Output of the entity extraction LLM step.
 */
export interface GraphEntity {
    /** Entity name (normalized: "USER" for self-references) */
    entity: string
    /** Entity type: person, place, food, activity, etc. */
    entityType: string
}

/**
 * A relationship between two entities.
 * Maps to the `entity_relations` table row.
 */
export interface GraphRelation {
    /** Source entity name */
    source: string
    /** Relationship verb/phrase (timeless: "prefers", "visited", etc.) */
    relationship: string
    /** Destination entity name */
    destination: string
    /** Source entity type (optional, for richer graph queries) */
    sourceType?: string
    /** Destination entity type */
    destinationType?: string
}

/**
 * A graph search result with similarity score.
 */
export interface GraphSearchResult {
    source: string
    relationship: string
    destination: string
    /** Cosine similarity from pgvector (0-1, higher = more similar) */
    similarity?: number
}

/**
 * Parameters for adding to the knowledge graph.
 */
export interface AddGraphParams {
    /** User UUID */
    userId: string
    /** Raw message to extract entities/relations from */
    message: string
}

/**
 * Result of a graph ingestion run.
 */
export interface AddGraphResult {
    /** Relations that were added/upserted */
    added: GraphRelation[]
    /** Relations that were deleted (contradiction resolution) */
    deleted: GraphRelation[]
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. MEMORY SEARCH — Unified search results
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Parameters for searching memories.
 */
export interface SearchMemoryParams {
    /** User UUID */
    userId: string
    /** Natural language query to search for */
    query: string
    /** Maximum results to return (default: 5) */
    limit?: number
}

/**
 * Parameters for searching the knowledge graph.
 */
export interface SearchGraphParams {
    /** User UUID */
    userId: string
    /** Natural language query */
    query: string
    /** Max hops for recursive CTE traversal (default: 2) */
    depth?: number
    /** Maximum results to return (default: 10) */
    limit?: number
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. MEMORY HISTORY — Audit trail
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A single history entry tracking a memory change.
 * Maps to the `memory_history` table row.
 */
export interface MemoryHistoryEntry {
    /** UUID primary key */
    historyId: string
    /** UUID of the memory that was changed */
    memoryId: string
    /** User UUID */
    userId: string
    /** What happened: ADD, UPDATE, or DELETE */
    event: 'ADD' | 'UPDATE' | 'DELETE'
    /** Previous text (for UPDATE/DELETE) */
    oldMemory?: string
    /** New text (for ADD/UPDATE) */
    newMemory?: string
    /** When this change occurred */
    createdAt: string
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. LLM RESPONSE SHAPES — Expected JSON from extraction prompts
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Expected shape of the fact extraction LLM response.
 * Schema: { "facts": string[] }
 */
export interface FactExtractionResponse {
    facts: string[]
}

/**
 * Expected shape of the memory decision LLM response.
 * Schema: { "memory": MemoryAction[] }
 */
export interface MemoryDecisionResponse {
    memory: Array<{
        id: string
        text: string
        event: 'ADD' | 'UPDATE' | 'DELETE' | 'NONE'
        old_memory?: string
    }>
}

/**
 * Expected shape of the entity extraction LLM response.
 * Schema: { "entities": [{ entity: string, entity_type: string }] }
 */
export interface EntityExtractionResponse {
    entities: Array<{
        entity: string
        entity_type: string
    }>
}

/**
 * Expected shape of the relation extraction LLM response.
 * Schema: { "relations": [{ source, relationship, destination }] }
 */
export interface RelationExtractionResponse {
    relations: Array<{
        source: string
        relationship: string
        destination: string
    }>
}

/**
 * Expected shape of the contradiction detection LLM response.
 * Schema: { "to_delete": [{ source, relationship, destination }] }
 */
export interface ContradictionDetectionResponse {
    to_delete: Array<{
        source: string
        relationship: string
        destination: string
    }>
}
