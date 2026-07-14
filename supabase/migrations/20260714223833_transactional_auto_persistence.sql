-- Transactional auto-persistence scaffold
-- Purpose: Enable atomic, multi-table persistence with SERIALIZABLE isolation
-- Status: Test-first (schema foundation, no data)
-- PR: fix/transactional-auto-persistence

BEGIN;

-- Transactional persistence metadata table
-- Tracks active transaction IDs, commit status, and rollback recovery
CREATE TABLE IF NOT EXISTS transactional_persist_meta (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id TEXT NOT NULL UNIQUE,
    user_id UUID NOT NULL,
    thread_id UUID NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    committed_at TIMESTAMP WITH TIME ZONE,
    status TEXT DEFAULT 'pending'::text,
    CONSTRAINT valid_persist_status CHECK (status IN ('pending', 'committed', 'rolled_back', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_transactional_persist_meta_status 
    ON transactional_persist_meta(status);
CREATE INDEX IF NOT EXISTS idx_transactional_persist_meta_user_thread 
    ON transactional_persist_meta(user_id, thread_id);
CREATE INDEX IF NOT EXISTS idx_transactional_persist_meta_created_at 
    ON transactional_persist_meta(created_at DESC);

-- Transactional artifact batch queue
-- Holds artifact rows pending atomic insertion across a transaction boundary
CREATE TABLE IF NOT EXISTS transactional_artifact_batch (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transaction_id TEXT NOT NULL REFERENCES transactional_persist_meta(transaction_id) ON DELETE CASCADE,
    artifact_type TEXT NOT NULL,
    artifact_data JSONB NOT NULL,
    inserted_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    -- Dedup guard: content_hash ensures no duplicate values per transaction
    content_hash TEXT NOT NULL,
    CONSTRAINT unique_txn_content UNIQUE (transaction_id, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_transactional_artifact_batch_txn 
    ON transactional_artifact_batch(transaction_id);
CREATE INDEX IF NOT EXISTS idx_transactional_artifact_batch_type 
    ON transactional_artifact_batch(artifact_type);

-- Enable RLS for security
ALTER TABLE transactional_persist_meta ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactional_artifact_batch ENABLE ROW LEVEL SECURITY;

-- RLS policies (stub — will be tightened per your OSINT isolation rules)
CREATE POLICY "Users see own transactional metadata" 
    ON transactional_persist_meta 
    FOR SELECT 
    USING (auth.uid() = user_id);

CREATE POLICY "Users see own artifact batches" 
    ON transactional_artifact_batch 
    FOR SELECT 
    USING (
        transaction_id IN (
            SELECT transaction_id FROM transactional_persist_meta 
            WHERE user_id = auth.uid()
        )
    );

COMMIT;
