import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

/**
 * Demanda 10268 — o CLI é a via de uso do verificador: as skills que produzem
 * achados rodam no harness, fora do app, então não há middleware onde plugar o
 * gate. O que importa aqui é o código de saída: é ele que permite usar o
 * verificador como gate real num hook ou pipeline.
 */

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-findings-'));

function write(name: string, findings: unknown): string {
  const file = path.join(tmpDir, name);
  fs.writeFileSync(file, JSON.stringify(findings));
  return file;
}

/**
 * Roda o CLI e devolve status + saída combinada.
 *
 * `spawnSync` em vez de `execFileSync` porque parte das mensagens sai em
 * stderr (o aviso do modo `warn`, por exemplo) e o processo termina com 0 —
 * capturar só stdout perderia justamente o que esses testes verificam.
 */
function runCli(args: string[]): { status: number; output: string } {
  const result = spawnSync('npx', ['tsx', 'scripts/verify-findings.ts', ...args], {
    encoding: 'utf8',
  });
  return {
    status: result.status ?? -1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

const REAL = {
  skill: 'evaluate-rag',
  patternId: 'B-2',
  summary: 'log de retrieval com latência',
  evidenceFile: 'server/services/retrieval-service.ts',
  evidenceLine: 176,
  verificationCommand: 'retrievalMs',
};

const FALSO = {
  skill: 'llm-evaluation',
  patternId: 'DASH-01',
  summary: 'dashboard de custos não existe',
  evidenceFile: 'server/services/cost-dashboard-inexistente.ts',
  evidenceLine: 12,
  verificationCommand: 'renderDashboard',
};

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('CLI verify-findings', () => {
  it('sai com 0 quando todos os achados se sustentam', () => {
    const { status } = runCli(['--file', write('ok.json', [REAL]), '--mode', 'enforce']);
    expect(status).toBe(0);
  });

  it('sai com 1 em enforce quando algum achado não se sustenta', () => {
    const { status, output } = runCli([
      '--file',
      write('misto.json', [REAL, FALSO]),
      '--mode',
      'enforce',
    ]);
    expect(status).toBe(1);
    expect(output).toMatch(/bloqueado \(enforce\)/);
  });

  it('sai com 0 em warn com os mesmos achados — mede sem barrar', () => {
    const { status, output } = runCli([
      '--file',
      write('misto-warn.json', [REAL, FALSO]),
      '--mode',
      'warn',
    ]);
    expect(status).toBe(0);
    expect(output).toMatch(/seguem adiante \(warn\)/);
  });

  it('reporta a taxa de achados verificados', () => {
    const { output } = runCli(['--file', write('taxa.json', [REAL, FALSO]), '--mode', 'warn']);
    expect(output).toMatch(/1\/2 achados com evidência reproduzível \(50%\)/);
  });

  it('aceita lote vazio sem falhar', () => {
    const { status } = runCli(['--file', write('vazio.json', []), '--mode', 'enforce']);
    expect(status).toBe(0);
  });

  it('aceita o formato { findings: [...] }', () => {
    const { status } = runCli([
      '--file',
      write('wrapped.json', { findings: [REAL] }),
      '--mode',
      'enforce',
    ]);
    expect(status).toBe(0);
  });

  it('falha com mensagem clara quando o JSON é inválido', () => {
    const file = path.join(tmpDir, 'quebrado.json');
    fs.writeFileSync(file, '{isso não é json');
    const { status, output } = runCli(['--file', file]);
    expect(status).toBe(1);
    expect(output).toMatch(/não é JSON válido/);
  });
});
