#!/usr/bin/env node

/**
 * Generate frontend pivot-loop types from edge function source
 *
 * This script extracts type definitions from:
 *   supabase/functions/osint-agent/pivot-loop/types.ts
 *
 * And generates:
 *   src/types/pivot-loop.ts
 *
 * Run: npm run build:generate-types
 * CI check: verify src/types/pivot-loop.ts has not been manually edited
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(__dirname);

const sourceFile = path.join(
  repoRoot,
  'supabase/functions/osint-agent/pivot-loop/types.ts'
);

const targetFile = path.join(repoRoot, 'src/types/pivot-loop.ts');

const generatedHeader = `/**
 * Structured Pivot Loop Types
 *
 * GENERATED FILE: Do not edit directly. This is generated from:
 *   supabase/functions/osint-agent/pivot-loop/types.ts
 *
 * To update types, edit the edge function types.ts file and run:
 *   npm run build:generate-types
 *
 * This ensures frontend and backend types stay in sync.
 *
 * Schema definitions for the PLAN → GATE → EXECUTE → CORROBORATE → PRUNE → NEXT PIVOT
 * investigation loop. This feature is feature-flagged (STRUCTURED_PIVOT_LOOP=false by default).
 */\n\n`;

try {
  // Read source types
  const sourceContent = fs.readFileSync(sourceFile, 'utf-8');

  // Extract types (everything after the header comment)
  const headerEndIndex = sourceContent.indexOf('*/\n') + 3;
  const typeContent = sourceContent.substring(headerEndIndex).trim();

  // Generate frontend file
  const generatedContent = generatedHeader + typeContent;

  // Write to target file
  fs.writeFileSync(targetFile, generatedContent, 'utf-8');

  console.log('✓ Generated:', targetFile);
  console.log(`  Source: ${sourceFile}`);
  console.log(`  Types: ${(typeContent.match(/^(export (type|interface))/gm) || []).length} definitions`);
  console.log('');
  console.log('Remember: src/types/pivot-loop.ts is generated. Do not edit manually.');
  console.log('Edit supabase/functions/osint-agent/pivot-loop/types.ts instead.');
} catch (err) {
  console.error('✗ Error generating types:', err.message);
  process.exit(1);
}
