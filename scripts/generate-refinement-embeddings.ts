/**
 * Script to generate embeddings for Refinement RAG documents.
 * Run this after ingesting PRDs/Tasks to enable semantic search on historical refinements.
 *
 * Usage: npx tsx scripts/generate-refinement-embeddings.ts
 */

import { refinementRAGService } from '../server/services/refinement-rag';

async function main(): Promise<void> {
  console.log('Starting Refinement RAG embedding generation...\n');

  // First, ensure all documents are ingested
  const ingested = await refinementRAGService.ingestFromDocuments();
  console.log(`Documents ingested: ${ingested}`);

  // Generate embeddings for documents without them
  const generated = await refinementRAGService.generateMissingEmbeddings();
  console.log(`\nEmbeddings generated: ${generated}`);

  console.log('\nDone! Semantic search for refinements is now available.');
}

main().catch((error) => {
  console.error('Failed to generate refinement embeddings:', error);
  process.exit(1);
});
