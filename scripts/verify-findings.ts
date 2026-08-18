/**
 * Demanda 10268 — verificador de achados de autoavaliação, via linha de comando.
 *
 * As três skills que produzem achados (`avaliar-fluxo-agentes`, `evaluate-rag`,
 * `llm-evaluation`) rodam no harness, fora deste app — não há pipeline interno
 * onde plugar o gate como middleware. Este script é a via de uso: recebe os
 * achados que a skill produziu e confirma, contra o código real, que cada um
 * aponta arquivo, linha e termo que existem de fato.
 *
 * Em `enforce` o processo sai com código 1 quando algum achado não se sustenta,
 * o que permite usá-lo como gate de verdade num pipeline ou hook.
 *
 * Uso:
 *   npm run verify:findings -- --file achados.json
 *   cat achados.json | npm run verify:findings
 *   npm run verify:findings -- --file achados.json --mode warn
 *
 * Formato de entrada (array, ou { findings: [...] }):
 *   [
 *     {
 *       "skill": "evaluate-rag",
 *       "patternId": "A-2",
 *       "summary": "groundedness depende só do LLM-judge",
 *       "evidenceFile": "server/services/groundedness-validator.ts",
 *       "evidenceLine": 212,
 *       "verificationCommand": "pré-filtro determinístico"
 *     }
 *   ]
 */

import fs from 'node:fs';

import {
  getFindingVerifierMode,
  runFindingGate,
  type Finding,
  type FindingVerifierMode,
} from '../server/services/ai-squad/finding-verifier';

function parseArgs(argv: string[]): { file?: string; mode?: FindingVerifierMode } {
  const out: { file?: string; mode?: FindingVerifierMode } = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--file') out.file = argv[++i];
    else if (argv[i] === '--mode') {
      const value = argv[++i];
      if (value !== 'warn' && value !== 'enforce') {
        throw new Error(`--mode aceita "warn" ou "enforce", recebeu "${value}"`);
      }
      out.mode = value;
    }
  }
  return out;
}

async function readInput(file?: string): Promise<string> {
  if (file) return fs.readFileSync(file, 'utf8');
  if (process.stdin.isTTY) {
    throw new Error('nenhuma entrada: passe --file <arquivo> ou envie o JSON por stdin');
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

/** Aceita tanto um array cru quanto `{ findings: [...] }`. */
function parseFindings(raw: string): Finding[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`entrada não é JSON válido: ${(error as Error).message}`);
  }
  const list = Array.isArray(parsed)
    ? parsed
    : (parsed as { findings?: unknown[] } | null)?.findings;
  if (!Array.isArray(list)) {
    throw new Error('esperado um array de achados, ou um objeto com a chave "findings"');
  }
  return list as Finding[];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.mode ?? getFindingVerifierMode();
  const findings = parseFindings(await readInput(args.file));

  if (findings.length === 0) {
    console.log('Nenhum achado na entrada — nada a verificar.');
    return;
  }

  const gate = runFindingGate(findings, mode);

  console.log(`\nVerificação de achados — modo ${mode}`);
  console.log('='.repeat(60));

  for (const result of gate.results) {
    const mark = result.verified ? 'OK  ' : 'FALHA';
    const id = result.finding.patternId ? ` [${result.finding.patternId}]` : '';
    console.log(
      `${mark} ${result.finding.skill}${id}: ${result.finding.evidenceFile}:${result.finding.evidenceLine}`,
    );
    console.log(`      ${result.reason}`);
  }

  const rate = gate.totalCount > 0 ? Math.round((gate.verifiedCount / gate.totalCount) * 100) : 0;
  console.log('='.repeat(60));
  console.log(
    `${gate.verifiedCount}/${gate.totalCount} achados com evidência reproduzível (${rate}%)`,
  );

  if (gate.rejected.length === 0) return;

  if (mode === 'enforce') {
    console.error(`\n${gate.rejected.length} achado(s) sem evidência — bloqueado (enforce).`);
    process.exitCode = 1;
    return;
  }
  console.warn(
    `\n${gate.rejected.length} achado(s) sem evidência — seguem adiante (warn). ` +
      'Rode com --mode enforce para bloquear.',
  );
}

main().catch((error) => {
  console.error(`[verify-findings] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
