/**
 * Backfill de departmentalização do RAG.
 *
 * Para o histórico criado antes da coluna `repo_full_name` existir, este
 * script:
 *
 *   1. Varre todas as demandas em `demands` e, quando `repo_full_name`
 *      estiver NULL, tenta extrair o repo do `description` via regex
 *      (mesma heurística que o context-builder já usava). Persiste o valor
 *      direto na coluna canônica.
 *
 *   2. Re-ingere os documentos do disco. O `RefinementRAGService` agora
 *      consulta a tabela demands (já backfillada) ao parsear cada arquivo,
 *      então documentos pré-existentes recebem o repo correto na próxima
 *      passagem do upsert.
 *
 *   3. Backfilla diretamente as linhas em `refinement_rag_documents` que
 *      ainda tenham `repo_full_name = NULL` mas cuja `demand_id` aponta
 *      para uma demanda já atribuída.
 *
 * Documentos que continuarem `repo_full_name = NULL` representam:
 *  - Demandas sem repositório associado (ex.: discovery puro), que devem
 *    permanecer "globais"; ou
 *  - Artefatos legados sem demand_id parseável.
 *
 * Em ambos os casos eles ficam excluídos do recall por padrão (modo seguro
 * "scope.includeGlobal=false") — o trade-off acordado na decisão de design.
 *
 * Uso:
 *   npm run backfill:repo-full-name
 */

import { sql } from 'drizzle-orm';
import { db } from '../server/db';
import { dbAll, dbRun } from '../server/utils/db-utils';
import { extractRepoFullNameFromText } from '../server/utils/repo-context';
import { refinementRAGService } from '../server/services/refinement-rag';

interface DemandRow {
  id: number;
  description: string | null;
  repo_full_name: string | null;
}

async function backfillDemands(): Promise<{ scanned: number; updated: number }> {
  const rows = (await dbAll(
    db,
    sql`SELECT id, description, repo_full_name FROM demands`,
  )) as DemandRow[];

  let updated = 0;
  for (const row of rows) {
    if (row.repo_full_name) continue;
    const repoFullName = extractRepoFullNameFromText(row.description);
    if (!repoFullName) continue;
    await dbRun(db, sql`UPDATE demands SET repo_full_name = ${repoFullName} WHERE id = ${row.id}`);
    updated += 1;
  }

  return { scanned: rows.length, updated };
}

async function main(): Promise<void> {
  console.log('▶ Etapa 1/3 — backfill de demands.repo_full_name a partir do description…');
  const demandResult = await backfillDemands();
  console.log(
    `   ✓ ${demandResult.updated}/${demandResult.scanned} demandas atualizadas com repo_full_name.`,
  );

  console.log('▶ Etapa 2/3 — re-ingerindo documentos do disco com a nova atribuição…');
  const ingested = await refinementRAGService.ingestFromDocuments();
  console.log(`   ✓ ${ingested} documento(s) re-ingerido(s).`);

  console.log('▶ Etapa 3/3 — backfill de refinement_rag_documents.repo_full_name…');
  const ragUpdated = await refinementRAGService.backfillRepoFullName();
  console.log(`   ✓ ${ragUpdated} chunk(s) atualizado(s) na tabela RAG.`);

  console.log('\nResumo:');
  console.log(`  demands atualizadas........ ${demandResult.updated}`);
  console.log(`  rag chunks atualizados..... ${ragUpdated}`);
  console.log(`  documentos re-ingeridos.... ${ingested}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Falha no backfill de departmentalização:', error);
    process.exit(1);
  });
