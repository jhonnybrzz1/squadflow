import 'dotenv/config';
import { refinementRAGService } from '../server/services/refinement-rag';

async function main(): Promise<void> {
  const ingested = await refinementRAGService.ingestFromDocuments();
  console.log(`Refinement RAG: ${ingested} documento(s) ingerido(s).`);
}

main().catch((error) => {
  console.error('Failed to ingest refinement RAG documents:', error);
  process.exit(1);
});
