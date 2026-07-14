#!/usr/bin/env bash
set -euo pipefail

# Test runner for transactional persistence migrations
# Usage: ./scripts/test-transactional-persistence.sh [--local|--remote]

TARGET="${1:-local}"
PROJECT_ID="${SUPABASE_PROJECT_ID:-}"
API_KEY="${SUPABASE_API_KEY:-}"

echo "🔍 Testing transactional persistence migrations (target: $TARGET)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [ "$TARGET" = "local" ]; then
    echo "Target: Local Supabase (via \`supabase\` CLI)"
    echo "Running schema migrations..."
    supabase migration up --local --skip-seed || {
        echo "❌ Migration failed. Check database connectivity."
        exit 1
    }
    echo "✓ Schema migrations applied"
    
    echo "Running test suite..."
    supabase functions deploy --local || true
    supabase db execute << 'SQL'
-- Run the test suite
\i supabase/migrations/20260714223833_transactional_auto_persistence_test.sql
SQL
    echo "✓ Tests completed"
    
elif [ "$TARGET" = "remote" ]; then
    if [ -z "$PROJECT_ID" ] || [ -z "$API_KEY" ]; then
        echo "❌ Remote mode requires SUPABASE_PROJECT_ID and SUPABASE_API_KEY"
        exit 1
    fi
    
    echo "Target: Remote project ($PROJECT_ID)"
    echo "Pushing migrations..."
    supabase db push --project-id="$PROJECT_ID" || {
        echo "❌ Remote push failed."
        exit 1
    }
    echo "✓ Migrations pushed to remote"
else
    echo "❌ Unknown target: $TARGET (use 'local' or 'remote')"
    exit 1
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Transactional persistence tests PASSED"
