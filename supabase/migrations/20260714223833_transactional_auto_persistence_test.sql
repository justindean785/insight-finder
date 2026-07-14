-- Test suite for transactional persistence (validates schema correctness)
-- Run AFTER 20260714223833_transactional_auto_persistence.sql

BEGIN;

-- Test 1: transactional_persist_meta table exists with correct columns
DO $$
DECLARE
    v_column_count INT;
BEGIN
    SELECT COUNT(*) INTO v_column_count
    FROM information_schema.columns
    WHERE table_name = 'transactional_persist_meta'
    AND table_schema = 'public';
    
    IF v_column_count < 7 THEN
        RAISE EXCEPTION 'transactional_persist_meta missing required columns (found %, expected 7)', v_column_count;
    END IF;
    
    RAISE NOTICE 'Test 1 PASS: transactional_persist_meta has % columns', v_column_count;
END $$;

-- Test 2: transactional_artifact_batch table exists
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'transactional_artifact_batch') THEN
        RAISE EXCEPTION 'transactional_artifact_batch table not found';
    END IF;
    RAISE NOTICE 'Test 2 PASS: transactional_artifact_batch table exists';
END $$;

-- Test 3: Insert a transactional metadata row (basic write)
DO $$
DECLARE
    v_txn_id TEXT := 'test-txn-' || now()::text;
    v_inserted_id UUID;
BEGIN
    INSERT INTO transactional_persist_meta (
        transaction_id, user_id, thread_id, status
    ) VALUES (
        v_txn_id,
        '00000000-0000-0000-0000-000000000001'::uuid,
        '00000000-0000-0000-0000-000000000002'::uuid,
        'pending'
    ) RETURNING id INTO v_inserted_id;
    
    IF v_inserted_id IS NULL THEN
        RAISE EXCEPTION 'Failed to insert transactional metadata';
    END IF;
    
    RAISE NOTICE 'Test 3 PASS: inserted transactional metadata row %', v_inserted_id;
END $$;

-- Test 4: Verify status constraint (invalid status should fail)
DO $$
BEGIN
    BEGIN
        INSERT INTO transactional_persist_meta (
            transaction_id, user_id, thread_id, status
        ) VALUES (
            'test-txn-invalid-' || now()::text,
            '00000000-0000-0000-0000-000000000003'::uuid,
            '00000000-0000-0000-0000-000000000004'::uuid,
            'invalid_status'
        );
        RAISE EXCEPTION 'Status constraint check failed — invalid status was allowed';
    EXCEPTION WHEN check_violation THEN
        RAISE NOTICE 'Test 4 PASS: status constraint properly rejects invalid values';
    END;
END $$;

-- Test 5: Unique constraint on transaction_id
DO $$
DECLARE
    v_txn_id TEXT := 'unique-test-' || now()::text;
BEGIN
    INSERT INTO transactional_persist_meta (
        transaction_id, user_id, thread_id, status
    ) VALUES (
        v_txn_id,
        '00000000-0000-0000-0000-000000000005'::uuid,
        '00000000-0000-0000-0000-000000000006'::uuid,
        'pending'
    );
    
    BEGIN
        INSERT INTO transactional_persist_meta (
            transaction_id, user_id, thread_id, status
        ) VALUES (
            v_txn_id,
            '00000000-0000-0000-0000-000000000007'::uuid,
            '00000000-0000-0000-0000-000000000008'::uuid,
            'pending'
        );
        RAISE EXCEPTION 'Unique constraint on transaction_id failed';
    EXCEPTION WHEN unique_violation THEN
        RAISE NOTICE 'Test 5 PASS: transaction_id uniqueness constraint works';
    END;
END $$;

-- Test 6: Indexes exist and are usable
DO $$
DECLARE
    v_index_count INT;
BEGIN
    SELECT COUNT(*) INTO v_index_count
    FROM pg_indexes
    WHERE tablename IN ('transactional_persist_meta', 'transactional_artifact_batch');
    
    IF v_index_count < 5 THEN
        RAISE EXCEPTION 'Expected at least 5 indexes, found %', v_index_count;
    END IF;
    
    RAISE NOTICE 'Test 6 PASS: % indexes created', v_index_count;
END $$;

-- Test 7: RLS is enabled
DO $$
DECLARE
    v_rls_enabled INT;
BEGIN
    SELECT COUNT(*) INTO v_rls_enabled
    FROM information_schema.tables
    WHERE table_name IN ('transactional_persist_meta', 'transactional_artifact_batch')
    AND row_security_enforced = true;
    
    IF v_rls_enabled < 2 THEN
        RAISE EXCEPTION 'RLS not enabled on one or both tables';
    END IF;
    
    RAISE NOTICE 'Test 7 PASS: RLS enabled on both tables';
END $$;

COMMIT;
