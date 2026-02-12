-- =============================================================================
-- DEV 3: THE SOUL — Vector Memory + Graph Memory Schema
-- Run on DigitalOcean Managed PostgreSQL (v15+)
-- =============================================================================

-- Enable pgvector extension (required for vector similarity search)
-- DigitalOcean Managed PG supports this on v15+
CREATE EXTENSION IF NOT EXISTS vector;

-- =============================================================================
-- 1. Vector Memory Store (adapted from mem0 pgvector pattern)
-- =============================================================================

CREATE TABLE IF NOT EXISTS memories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    memory TEXT NOT NULL,
    vector vector(768),                      -- Jina embeddings (768-dim)
    hash VARCHAR(64),                        -- MD5 for dedup
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- HNSW index for fast cosine similarity search
CREATE INDEX IF NOT EXISTS memories_hnsw_idx
    ON memories USING hnsw (vector vector_cosine_ops);

CREATE INDEX IF NOT EXISTS memories_user_id_idx ON memories(user_id);
CREATE INDEX IF NOT EXISTS memories_hash_idx ON memories(hash);

-- Trigger for auto-updating updated_at (reuse existing function from schema.sql)
CREATE TRIGGER update_memories_updated_at
    BEFORE UPDATE ON memories
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- =============================================================================
-- 2. Entity-Relationship Graph (replaces Neo4j)
-- =============================================================================

CREATE TABLE IF NOT EXISTS entity_relations (
    relation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    source_entity VARCHAR(200) NOT NULL,
    source_type VARCHAR(100) DEFAULT 'unknown',
    relationship VARCHAR(200) NOT NULL,
    destination_entity VARCHAR(200) NOT NULL,
    destination_type VARCHAR(100) DEFAULT 'unknown',
    source_embedding vector(768),
    destination_embedding vector(768),
    mentions INTEGER DEFAULT 1,
    confidence DECIMAL(3,2) DEFAULT 0.70,
    source_message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, source_entity, relationship, destination_entity)
);

CREATE INDEX IF NOT EXISTS entity_relations_user_idx ON entity_relations(user_id);
CREATE INDEX IF NOT EXISTS entity_relations_source_idx ON entity_relations(source_entity);
CREATE INDEX IF NOT EXISTS entity_relations_dest_idx ON entity_relations(destination_entity);
CREATE INDEX IF NOT EXISTS entity_source_emb_idx
    ON entity_relations USING hnsw (source_embedding vector_cosine_ops);
CREATE INDEX IF NOT EXISTS entity_dest_emb_idx
    ON entity_relations USING hnsw (destination_embedding vector_cosine_ops);

CREATE TRIGGER update_entity_relations_updated_at
    BEFORE UPDATE ON entity_relations
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- =============================================================================
-- 3. Memory History (tracks ADD/UPDATE/DELETE events — mem0 pattern)
-- =============================================================================

CREATE TABLE IF NOT EXISTS memory_history (
    history_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    memory_id UUID NOT NULL,
    user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
    event VARCHAR(10) NOT NULL CHECK (event IN ('ADD', 'UPDATE', 'DELETE')),
    old_memory TEXT,
    new_memory TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS memory_history_memory_idx ON memory_history(memory_id);
CREATE INDEX IF NOT EXISTS memory_history_user_idx ON memory_history(user_id);

-- =============================================================================
-- 4. Embedding Queue (for batch processing via cron job)
-- =============================================================================

CREATE TABLE IF NOT EXISTS embedding_queue (
    queue_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    target_table VARCHAR(50) NOT NULL,       -- 'memories' or 'entity_relations'
    target_id UUID NOT NULL,                 -- row ID in target table
    target_column VARCHAR(50) NOT NULL,      -- 'vector', 'source_embedding', etc.
    text_to_embed TEXT NOT NULL,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    error_message TEXT,
    attempts INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS embedding_queue_status_idx ON embedding_queue(status);
CREATE INDEX IF NOT EXISTS embedding_queue_created_idx ON embedding_queue(created_at);
