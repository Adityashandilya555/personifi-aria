/**
 * Graph Memory — DEV 3: The Soul
 *
 * PostgreSQL-native entity-relationship graph, adapted from mem0's MemoryGraph.
 * Uses recursive CTEs instead of Neo4j Cypher for traversal.
 *
 * Pipeline:
 * WRITE: extract entities (Groq 8B) → establish relations → detect contradictions → UPSERT
 * READ:  embed query entities → pgvector cosine search → recursive CTE traversal → format
 */

import Groq from 'groq-sdk'
import { getPool } from './character/session-store.js'
import { embed, embedBatch, queueForEmbedding } from './embeddings.js'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface Entity {
    entity: string
    entity_type: string
}

export interface Relation {
    source: string
    relationship: string
    destination: string
    source_type?: string
    destination_type?: string
}

export interface GraphSearchResult {
    source: string
    relationship: string
    destination: string
    similarity?: number
}

// ─── Groq Client ────────────────────────────────────────────────────────────

let groq: Groq | null = null

function getGroq(): Groq {
    if (!groq) {
        groq = new Groq({ apiKey: process.env.GROQ_API_KEY })
    }
    return groq
}

const EXTRACTION_MODEL = 'llama-3.1-8b-instant'

// ─── Prompts (adapted from mem0 graphs/utils.ts) ────────────────────────────

const EXTRACT_ENTITIES_PROMPT = `You are an advanced algorithm designed to extract entities from text for a travel assistant's knowledge graph.

Extract entities and their types. For self-references ("I", "me", "my"), use "USER" as the entity name.

Entity types to look for: person, place, food, activity, preference, accommodation, airline, date, budget, transport, cuisine

Return ONLY a JSON object:
{"entities": [{"entity": "<name>", "entity_type": "<type>"}]}

Examples:
Input: "I love vegetarian food and visited Bali last summer"
Output: {"entities": [{"entity": "USER", "entity_type": "person"}, {"entity": "vegetarian food", "entity_type": "food"}, {"entity": "Bali", "entity_type": "place"}]}

Input: "My friend John prefers Marriott hotels"
Output: {"entities": [{"entity": "USER", "entity_type": "person"}, {"entity": "John", "entity_type": "person"}, {"entity": "Marriott", "entity_type": "accommodation"}]}`

const EXTRACT_RELATIONS_PROMPT = `You are an algorithm that establishes relationships among entities for a travel assistant's knowledge graph.

Rules:
1. Use consistent, general, timeless relationship types (e.g., "prefers" not "started_preferring")
2. For self-references ("I", "me", "my"), use "USER" as the source entity
3. Only create relationships between entities mentioned in the text

Return ONLY a JSON object:
{"relations": [{"source": "<entity>", "relationship": "<relation>", "destination": "<entity>"}]}

Examples:
Input: "I love vegetarian food" with entities [USER, vegetarian food]
Output: {"relations": [{"source": "USER", "relationship": "prefers", "destination": "vegetarian food"}]}

Input: "We visited Bali and stayed at a boutique hotel" with entities [USER, Bali, boutique hotel]
Output: {"relations": [{"source": "USER", "relationship": "visited", "destination": "Bali"}, {"source": "USER", "relationship": "stayed_at", "destination": "boutique hotel"}]}`

const DELETE_RELATIONS_PROMPT = `You are a graph memory manager. Analyze existing relationships and determine which should be DELETED based on new information.

DELETION CRITERIA — delete ONLY if:
- Outdated: new info is more recent/accurate
- Contradictory: new info directly negates existing

DO NOT DELETE if same relationship type could have multiple destinations.
Example: "loves pizza" + "loves burger" → KEEP BOTH (additive, not contradictory)

Existing relationships:
{existing}

New information: {new_info}

Return ONLY a JSON object:
{"to_delete": [{"source": "<entity>", "relationship": "<relation>", "destination": "<entity>"}]}

Return {"to_delete": []} if nothing should be deleted.`

// ─── Write Path ─────────────────────────────────────────────────────────────

/**
 * Extract entities and relationships from a message and add to the graph.
 * Fire-and-forget: called asynchronously after response is sent.
 */
export async function addToGraph(
    userId: string,
    message: string
): Promise<{ added: Relation[]; deleted: Relation[] }> {
    const added: Relation[] = []
    const deleted: Relation[] = []

    try {
        // Step 1: Extract entities
        const entities = await extractEntities(message)
        if (entities.length === 0) return { added, deleted }

        // Build entity type map
        const entityTypeMap: Record<string, string> = {}
        for (const e of entities) {
            entityTypeMap[e.entity] = e.entity_type
        }

        // Step 2: Extract relationships
        const relations = await extractRelations(message, entities)
        if (relations.length === 0) return { added, deleted }

        // Step 3: Replace "USER" with actual userId for storage
        const normalizedRelations = relations.map(r => ({
            ...r,
            source: r.source === 'USER' ? userId : r.source.toLowerCase(),
            destination: r.destination === 'USER' ? userId : r.destination.toLowerCase(),
            source_type: entityTypeMap[r.source] || 'unknown',
            destination_type: entityTypeMap[r.destination] || 'unknown',
        }))

        // Step 4: Search existing relations for this user
        const existingRelations = await getExistingRelations(userId)

        // Step 5: Detect contradictions
        if (existingRelations.length > 0) {
            const toDelete = await detectContradictions(existingRelations, message)
            for (const rel of toDelete) {
                await deleteRelation(userId, rel)
                deleted.push(rel)
            }
        }

        // Step 6: UPSERT new relations
        for (const rel of normalizedRelations) {
            await upsertRelation(userId, rel, message)
            added.push(rel)
        }
    } catch (error) {
        console.error('[graph-memory] addToGraph failed:', error)
    }

    return { added, deleted }
}

// ─── Read Path ──────────────────────────────────────────────────────────────

/**
 * Search the entity graph for context relevant to a query.
 * Uses embedding similarity + recursive CTE for graph traversal.
 *
 * Accepts a single userId or an array of userIds (for cross-channel identity).
 */
export async function searchGraph(
    userId: string | string[],
    query: string,
    depth = 2,
    limit = 10
): Promise<GraphSearchResult[]> {
    const primaryId = Array.isArray(userId) ? userId[0] : userId
    const userIds = Array.isArray(userId) ? userId : [userId]

    // Extract entities from the query
    const entities = await extractEntities(query)

    if (entities.length === 0) {
        // Fallback: embed the full query and search by vector similarity
        return searchGraphByEmbedding(userIds, query, limit)
    }

    // Embed each entity and search
    const allResults: GraphSearchResult[] = []

    for (const entity of entities) {
        const entityName = entity.entity === 'USER' ? primaryId : entity.entity.toLowerCase()
        const entityEmbedding = await embed(entityName, 'retrieval.query')

        if (entityEmbedding) {
            const results = await searchGraphRecursive(userIds, entityEmbedding, depth, limit)
            allResults.push(...results)
        } else {
            // Fallback: exact text match
            const results = await searchGraphByText(primaryId, entityName, depth, limit)
            allResults.push(...results)
        }
    }

    // Deduplicate by source+relationship+destination
    const seen = new Set<string>()
    return allResults.filter(r => {
        const key = `${r.source}|${r.relationship}|${r.destination}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
    }).slice(0, limit)
}

/**
 * PostgreSQL recursive CTE for graph traversal with embedding similarity.
 */
async function searchGraphRecursive(
    userIds: string[],
    queryEmbedding: number[],
    depth: number,
    limit: number
): Promise<GraphSearchResult[]> {
    const pool = getPool()
    const vectorStr = `[${queryEmbedding.join(',')}]`

    const result = await pool.query(
        `WITH RECURSIVE graph_walk AS (
       -- Base case: find entities matching query embedding
       SELECT source_entity, relationship, destination_entity,
              1 - (source_embedding <=> $1::vector) AS similarity,
              1 AS depth,
              ARRAY[source_entity] AS path
       FROM entity_relations
       WHERE user_id = ANY($2::uuid[])
         AND source_embedding IS NOT NULL
         AND 1 - (source_embedding <=> $1::vector) > 0.3

       UNION ALL

       -- Recursive: walk relationships up to N hops
       SELECT er.source_entity, er.relationship, er.destination_entity,
              1 - (er.source_embedding <=> $1::vector) AS similarity,
              gw.depth + 1,
              gw.path || er.source_entity
       FROM entity_relations er
       JOIN graph_walk gw ON LOWER(er.source_entity) = LOWER(gw.destination_entity)
       WHERE gw.depth < $3
         AND er.user_id = ANY($2::uuid[])
         AND NOT er.source_entity = ANY(gw.path)  -- Prevent cycles
     )
     SELECT DISTINCT source_entity, relationship, destination_entity, similarity
     FROM graph_walk
     ORDER BY similarity DESC
     LIMIT $4`,
        [vectorStr, userIds, depth, limit]
    )

    return result.rows.map((row: any) => ({
        source: row.source_entity,
        relationship: row.relationship,
        destination: row.destination_entity,
        similarity: parseFloat(row.similarity),
    }))
}

/**
 * Fallback: search graph by full-query embedding similarity.
 */
async function searchGraphByEmbedding(
    userIds: string[],
    query: string,
    limit: number
): Promise<GraphSearchResult[]> {
    const queryEmbedding = await embed(query, 'retrieval.query')
    if (!queryEmbedding) return searchGraphByText(userIds[0], query, 1, limit)

    const pool = getPool()
    const vectorStr = `[${queryEmbedding.join(',')}]`

    const result = await pool.query(
        `SELECT source_entity, relationship, destination_entity,
            1 - (source_embedding <=> $1::vector) AS similarity
     FROM entity_relations
     WHERE user_id = ANY($2::uuid[]) AND source_embedding IS NOT NULL
     ORDER BY source_embedding <=> $1::vector
     LIMIT $3`,
        [vectorStr, userIds, limit]
    )

    return result.rows.map((row: any) => ({
        source: row.source_entity,
        relationship: row.relationship,
        destination: row.destination_entity,
        similarity: parseFloat(row.similarity),
    }))
}

/**
 * Fallback: text-based graph search when embeddings unavailable.
 */
async function searchGraphByText(
    userId: string,
    entityName: string,
    depth: number,
    limit: number
): Promise<GraphSearchResult[]> {
    const pool = getPool()

    const result = await pool.query(
        `WITH RECURSIVE graph_walk AS (
       SELECT source_entity, relationship, destination_entity, 1 AS depth,
              ARRAY[source_entity] AS path
       FROM entity_relations
       WHERE user_id = $1
         AND (LOWER(source_entity) = LOWER($2) OR LOWER(destination_entity) = LOWER($2))
       UNION ALL
       SELECT er.source_entity, er.relationship, er.destination_entity, gw.depth + 1,
              gw.path || er.source_entity
       FROM entity_relations er
       JOIN graph_walk gw ON LOWER(er.source_entity) = LOWER(gw.destination_entity)
       WHERE gw.depth < $3 AND er.user_id = $1
         AND NOT er.source_entity = ANY(gw.path)
     )
     SELECT DISTINCT source_entity, relationship, destination_entity
     FROM graph_walk
     LIMIT $4`,
        [userId, entityName, depth, limit]
    )

    return result.rows.map((row: any) => ({
        source: row.source_entity,
        relationship: row.relationship,
        destination: row.destination_entity,
    }))
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

async function extractEntities(text: string): Promise<Entity[]> {
    const client = getGroq()

    try {
        const response = await client.chat.completions.create({
            model: EXTRACTION_MODEL,
            messages: [
                { role: 'system', content: EXTRACT_ENTITIES_PROMPT },
                { role: 'user', content: text },
            ],
            temperature: 0.1,
            max_tokens: 300,
            response_format: { type: 'json_object' },
        })

        const content = response.choices[0]?.message?.content
        if (!content) return []

        const parsed = JSON.parse(content)
        return Array.isArray(parsed.entities) ? parsed.entities : []
    } catch (error) {
        console.error('[graph-memory] Entity extraction failed:', error)
        return []
    }
}

async function extractRelations(text: string, entities: Entity[]): Promise<Relation[]> {
    const client = getGroq()
    const entityList = entities.map(e => e.entity).join(', ')

    try {
        const response = await client.chat.completions.create({
            model: EXTRACTION_MODEL,
            messages: [
                { role: 'system', content: EXTRACT_RELATIONS_PROMPT },
                { role: 'user', content: `Text: "${text}"\nEntities: [${entityList}]` },
            ],
            temperature: 0.1,
            max_tokens: 300,
            response_format: { type: 'json_object' },
        })

        const content = response.choices[0]?.message?.content
        if (!content) return []

        const parsed = JSON.parse(content)
        return Array.isArray(parsed.relations) ? parsed.relations : []
    } catch (error) {
        console.error('[graph-memory] Relation extraction failed:', error)
        return []
    }
}

async function getExistingRelations(userId: string): Promise<Relation[]> {
    const pool = getPool()
    const result = await pool.query(
        `SELECT source_entity, relationship, destination_entity, source_type, destination_type
     FROM entity_relations WHERE user_id = $1
     ORDER BY updated_at DESC LIMIT 50`,
        [userId]
    )
    return result.rows.map((row: any) => ({
        source: row.source_entity,
        relationship: row.relationship,
        destination: row.destination_entity,
        source_type: row.source_type,
        destination_type: row.destination_type,
    }))
}

async function detectContradictions(
    existing: Relation[],
    newInfo: string
): Promise<Relation[]> {
    const client = getGroq()

    const existingStr = existing
        .map(r => `${r.source} -- ${r.relationship} -- ${r.destination}`)
        .join('\n')

    const prompt = DELETE_RELATIONS_PROMPT
        .replace('{existing}', existingStr)
        .replace('{new_info}', newInfo)

    try {
        const response = await client.chat.completions.create({
            model: EXTRACTION_MODEL,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.1,
            max_tokens: 300,
            response_format: { type: 'json_object' },
        })

        const content = response.choices[0]?.message?.content
        if (!content) return []

        const parsed = JSON.parse(content)
        return Array.isArray(parsed.to_delete) ? parsed.to_delete : []
    } catch (error) {
        console.error('[graph-memory] Contradiction detection failed:', error)
        return []
    }
}

async function upsertRelation(userId: string, relation: Relation, sourceMessage: string): Promise<void> {
    const pool = getPool()

    // Embed source and destination for similarity search
    const [sourceEmb, destEmb] = await Promise.all([
        embed(relation.source, 'retrieval.passage'),
        embed(relation.destination, 'retrieval.passage'),
    ])

    const sourceVec = sourceEmb ? `[${sourceEmb.join(',')}]` : null
    const destVec = destEmb ? `[${destEmb.join(',')}]` : null

    const result = await pool.query(
        `INSERT INTO entity_relations
       (user_id, source_entity, source_type, relationship, destination_entity, destination_type,
        source_embedding, destination_embedding, source_message)
     VALUES ($1, $2, $3, $4, $5, $6, $7::vector, $8::vector, $9)
     ON CONFLICT (user_id, source_entity, relationship, destination_entity)
     DO UPDATE SET
       mentions = entity_relations.mentions + 1,
       confidence = LEAST(entity_relations.confidence + 0.05, 0.99),
       source_embedding = COALESCE($7::vector, entity_relations.source_embedding),
       destination_embedding = COALESCE($8::vector, entity_relations.destination_embedding),
       source_message = $9,
       updated_at = NOW()
     RETURNING relation_id`,
        [userId, relation.source, relation.source_type || 'unknown',
            relation.relationship, relation.destination, relation.destination_type || 'unknown',
            sourceVec, destVec, sourceMessage]
    )

    // If embeddings weren't available, queue them
    if (!sourceEmb && result.rows[0]) {
        await queueForEmbedding('entity_relations', result.rows[0].relation_id, 'source_embedding', relation.source)
    }
    if (!destEmb && result.rows[0]) {
        await queueForEmbedding('entity_relations', result.rows[0].relation_id, 'destination_embedding', relation.destination)
    }
}

async function deleteRelation(userId: string, relation: Relation): Promise<void> {
    const pool = getPool()
    await pool.query(
        `DELETE FROM entity_relations
     WHERE user_id = $1 AND LOWER(source_entity) = LOWER($2)
       AND LOWER(relationship) = LOWER($3) AND LOWER(destination_entity) = LOWER($4)`,
        [userId, relation.source, relation.relationship, relation.destination]
    )
}

/**
 * Format graph context for system prompt injection.
 */
export function formatGraphForPrompt(results: GraphSearchResult[]): string {
    if (results.length === 0) return ''

    const lines = results.map(r => `• ${r.source} → ${r.relationship} → ${r.destination}`)
    return `## What I Know About Your Connections\n${lines.join('\n')}`
}

/**
 * Get all relations for a user (for debugging/admin).
 */
export async function getAllRelations(userId: string, limit = 100): Promise<Relation[]> {
    const pool = getPool()
    const result = await pool.query(
        `SELECT source_entity, relationship, destination_entity, source_type, destination_type, mentions, confidence
     FROM entity_relations WHERE user_id = $1
     ORDER BY mentions DESC, updated_at DESC LIMIT $2`,
        [userId, limit]
    )
    return result.rows.map((row: any) => ({
        source: row.source_entity,
        relationship: row.relationship,
        destination: row.destination_entity,
        source_type: row.source_type,
        destination_type: row.destination_type,
    }))
}
