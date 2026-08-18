/**
 * T3 da demanda 10071 — limpeza de documentos falsos (stubs) persistidos antes
 * do fix do Bug 1 (falha de LLM virava PRD/checklist placeholder gravado como real).
 *
 * Uso:
 *   npx tsx scripts/cleanup-fake-documents.ts            # dry-run: só relata (default)
 *   npx tsx scripts/cleanup-fake-documents.ts --apply    # executa com backup + transação
 *
 * Garantias (critérios de aceite do T3):
 * - DRY-RUN por default: o critério de "documento falso" deve ser validado
 *   manualmente (rodar sem --apply e revisar a lista) antes de aplicar.
 * - Backup ANTES de qualquer alteração: cópia do sqlite.db e os .md detectados
 *   são MOVIDOS para documents/.fake-doc-backup-<ts>/ (nada é apagado de fato).
 * - Transação explícita: as alterações no banco rodam em BEGIN/COMMIT com
 *   ROLLBACK em erro.
 * - Idempotente: reexecutar não encontra nada (os arquivos já foram movidos e
 *   os metadados removidos).
 *
 * Somente SQLite (ambiente local real). Aborta se DATABASE_URL apontar para
 * Postgres.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

// Assinaturas EXATAS dos stubs pré-fix (document-generator.ts antes do Bug 1).
// Exigimos a string distintiva completa para não apagar documento legítimo.
const STUB_SIGNATURES: Array<{ label: string; test: (content: string) => boolean }> = [
  {
    label: 'PRD/TSD stub ("gerado com base no refinamento da squad")',
    test: (c) => c.includes('gerado com base no refinamento da squad.'),
  },
  {
    label: 'Tasks stub (template "Implementar funcionalidade principal")',
    test: (c) =>
      c.includes('**T1:** Implementar funcionalidade principal') &&
      c.includes('Critérios de aceite: Funcionalidade operando conforme PRD'),
  },
  {
    label: 'Tasks stub de erro ("[ERRO] Re-processar o refinamento")',
    test: (c) => c.includes('[ERRO] Re-processar o refinamento desta demanda'),
  },
];

interface FakeDoc {
  file: string;
  demandId: number | null;
  docType: 'prd' | 'tasks' | 'tdd' | null;
  signature: string;
}

function parseDocFilename(filename: string): {
  demandId: number | null;
  docType: FakeDoc['docType'];
} {
  // Padrão do versionamento: <Type>_<demandId>_<sufixo>.md (ex.: PRD_10071_v1.md)
  const m = /^(PRD|Tasks|TSD|TDD)_(\d+)_/i.exec(filename);
  if (!m) return { demandId: null, docType: null };
  const raw = m[1].toLowerCase();
  const docType = raw === 'prd' ? 'prd' : raw === 'tasks' ? 'tasks' : 'tdd';
  return { demandId: Number(m[2]), docType };
}

function main(): void {
  const apply = process.argv.includes('--apply');
  const root = process.cwd();
  const documentsDir = path.join(root, 'documents');
  const dbPath = path.join(root, 'sqlite.db');

  if ((process.env.DATABASE_URL ?? '').startsWith('postgres')) {
    console.error('❌ DATABASE_URL aponta para Postgres — este script é SQLite-only.');
    process.exit(1);
  }
  if (!fs.existsSync(documentsDir) || !fs.existsSync(dbPath)) {
    console.error(`❌ Não encontrei ${documentsDir} e/ou ${dbPath}. Rode na raiz do projeto.`);
    process.exit(1);
  }

  // 1. Varredura (somente leitura)
  const found: FakeDoc[] = [];
  for (const file of fs.readdirSync(documentsDir)) {
    if (!file.endsWith('.md')) continue;
    const content = fs.readFileSync(path.join(documentsDir, file), 'utf8');
    const hit = STUB_SIGNATURES.find((s) => s.test(content));
    if (!hit) continue;
    const { demandId, docType } = parseDocFilename(file);
    found.push({ file, demandId, docType, signature: hit.label });
  }

  if (found.length === 0) {
    console.log('✅ Nenhum documento falso encontrado (nada a fazer — idempotente).');
    return;
  }

  console.log(`Encontrado(s) ${found.length} documento(s) com assinatura de stub:\n`);
  for (const doc of found) {
    console.log(
      `  - documents/${doc.file}  [demanda ${doc.demandId ?? '?'} · ${doc.docType ?? 'tipo desconhecido'}]`,
    );
    console.log(`    assinatura: ${doc.signature}`);
  }

  if (!apply) {
    console.log(
      '\nDRY-RUN: nada foi alterado. Revise a lista acima (critério do T3 exige validação manual) e rode com --apply para executar.',
    );
    return;
  }

  const actionable = found.filter((d) => d.demandId !== null && d.docType !== null);
  const skipped = found.filter((d) => d.demandId === null || d.docType === null);
  for (const doc of skipped) {
    console.log(`\n⚠️  Pulando documents/${doc.file}: não consegui extrair demanda/tipo do nome.`);
  }

  // 2. Backups ANTES de qualquer alteração
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const dbBackup = path.join(root, `sqlite.db.backup-fake-docs-${ts}`);
  fs.copyFileSync(dbPath, dbBackup);
  console.log(`\n📦 Backup do banco: ${path.basename(dbBackup)}`);

  const fileBackupDir = path.join(documentsDir, `.fake-doc-backup-${ts}`);
  fs.mkdirSync(fileBackupDir, { recursive: true });

  // 3. Banco em transação explícita
  const db = new Database(dbPath);
  const selectVersions = db.prepare('SELECT document_versions FROM demands WHERE id = ?');
  const updateDemand = db.prepare(
    'UPDATE demands SET document_versions = ?, prd_url = CASE WHEN ? = 1 THEN NULL ELSE prd_url END, tasks_url = CASE WHEN ? = 1 THEN NULL ELSE tasks_url END, tdd_url = CASE WHEN ? = 1 THEN NULL ELSE tdd_url END WHERE id = ?',
  );

  const cleanup = db.transaction((docs: FakeDoc[]) => {
    for (const doc of docs) {
      const row = selectVersions.get(doc.demandId) as
        | { document_versions: string | null }
        | undefined;
      if (!row) continue;
      let versions: Record<string, unknown> = {};
      try {
        versions = row.document_versions ? JSON.parse(row.document_versions) : {};
      } catch (_) {
        versions = {};
      }
      delete versions[doc.docType as string];
      const serialized = Object.keys(versions).length > 0 ? JSON.stringify(versions) : null;
      updateDemand.run(
        serialized,
        doc.docType === 'prd' ? 1 : 0,
        doc.docType === 'tasks' ? 1 : 0,
        doc.docType === 'tdd' ? 1 : 0,
        doc.demandId,
      );
    }
  });

  try {
    cleanup(actionable); // better-sqlite3 .transaction = BEGIN/COMMIT, ROLLBACK em throw
  } catch (err) {
    db.close();
    console.error('❌ Falha na transação — banco intacto (rollback automático).', err);
    process.exit(1);
  }

  // 4. Mover os arquivos só DEPOIS do commit no banco
  for (const doc of actionable) {
    fs.renameSync(path.join(documentsDir, doc.file), path.join(fileBackupDir, doc.file));
  }
  db.close();

  console.log(
    `📦 ${actionable.length} arquivo(s) movido(s) para documents/${path.basename(fileBackupDir)}/`,
  );
  console.log('✅ Limpeza concluída. Reexecute para confirmar idempotência (deve achar 0).');
}

main();
