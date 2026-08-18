/**
 * Demanda 10113 — Análise 360° de conteúdo mockado.
 *
 * Gera relatório em specs/10113-handoff/report.md com:
 * - Candidatos a mock classificados por Tier (1/2/3)
 * - Contagem de Exposure (imports/references)
 * - Cruzamento com features Q3
 * - Flag de risco de testes
 */
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = process.cwd();
const REPORT_PATH = path.join(REPO_ROOT, 'specs/10113-handoff/report.md');

const EXCLUDE_DIRS = [
  'node_modules',
  'dist',
  '.git',
  'docs',
  'documents',
  'uploads',
  'logs',
  '.learnings',
];

const TEST_PATTERNS = ['tests/', 'test/', '__tests__', 'fixtures/', 'seeds/', 'mocks/'];

interface GrepPattern {
  name: string;
  regex: string;
  onlyRuntime: boolean;
}

const PATTERNS: GrepPattern[] = [
  // Stubs/mocks/fakes explícitos (não comentários genéricos)
  {
    name: 'explicit_mock_or_stub',
    regex:
      '^[^/]*\\b(mock|stub|fake|hardcoded|placeholder|TODO.*implement|temporary|temp)\\b[^/]*$',
    onlyRuntime: false,
  },
  // catch blocks returning success/allowed/true (fail-open behaviors)
  {
    name: 'catch_fail_open',
    regex:
      'catch\\s*\\([^)]*\\)\\s*\\{[^}]*(?:success\\s*:\\s*true|allowed\\s*:\\s*true|isGrounded\\s*:\\s*true)',
    onlyRuntime: true,
  },
  // Return of literal object that looks like a mocked response in routes/services
  {
    name: 'mocked_literal_return',
    regex:
      'return\\s+\\{[^{}]*(?:success\\s*:\\s*true|status\\s*:\\s*[\"\']ok|data\\s*:|result\\s*:|message\\s*:|error\\s*:\\s*(?:false|null)|allowed\\s*:\\s*true|mock|fake|placeholder|fallback)',
    onlyRuntime: true,
  },
  // Static fallback values in routes/controllers (res.json with literal object)
  {
    name: 'res_json_literal',
    regex:
      'res\\.(?:json|send|status)\\([^)]*\\{[^{}]*(?:success|status|data|message|result|error|mock|fake|placeholder)',
    onlyRuntime: true,
  },
  // Functions returning default/placeholder data
  {
    name: 'placeholder_default',
    regex:
      '(?:const|let|var)\\s+\\w+\\s*=\\s*(?:\\[|\\{)[^;]*(?:placeholder|hardcoded|TODO|FIXME|mock|fake)',
    onlyRuntime: false,
  },
];

const Q3_FEATURES: Record<string, { files: string[]; keywords: string[] }> = {
  'Retrospectiva Automatizada': {
    files: ['roundtable-orchestrator.ts', 'squad-coordinator.ts'],
    keywords: ['retrospective', 'retrospectiva'],
  },
  'Backlog como Pipeline': {
    files: ['backlog', 'pipeline'],
    keywords: ['backlog', 'pipeline'],
  },
  Discovery: {
    files: ['discovery', 'phase0'],
    keywords: ['discovery', 'phase0', 'descoberta'],
  },
  Governança: {
    files: ['governance', 'model-governance', 'guardrail'],
    keywords: ['governance', 'guardrail', 'guardrails'],
  },
  Observabilidade: {
    files: ['observability', 'metrics', 'telemetry'],
    keywords: ['observability', 'metrics', 'telemetry'],
  },
};

interface Candidate {
  file: string;
  line: number;
  snippet: string;
  pattern: string;
  tier: 1 | 2 | 3;
  exposure: number;
  q3Features: string[];
  hasFailureTest: boolean;
  hasSuccessTest: boolean;
  hasPayloadValidationTest: boolean;
}

function isTestPath(file: string): boolean {
  return TEST_PATTERNS.some((p) => file.includes(p));
}

function getTier(file: string, pattern: string): 1 | 2 | 3 {
  if (isTestPath(file)) return 3;

  const isRuntime = file.startsWith('server/services/') || file.startsWith('server/routes/');
  const isClient = file.startsWith('client/src/');

  if (isRuntime && (pattern === 'catch_fail_open' || pattern === 'res_json_literal')) {
    return 1;
  }

  if (isRuntime && (pattern === 'mocked_literal_return' || pattern === 'placeholder_default')) {
    return 2;
  }

  if ((isRuntime || isClient) && pattern === 'explicit_mock_or_stub') {
    return 2;
  }

  return 3;
}

function runGrep(pattern: string): string {
  const tmpFile = path.join(
    '/tmp',
    `rg-10113-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
  );
  fs.writeFileSync(tmpFile, pattern);
  const excludeGlob = EXCLUDE_DIRS.map((p) => `--glob=!${p}/**`).join(' ');
  const cmd = `rg -n -g '*.ts' -g '*.tsx' -g '*.js' -g '*.jsx' -g '*.json' ${excludeGlob} -P -f ${tmpFile} server/ shared/ client/src/ scripts/ || true`;
  try {
    const out = execSync(cmd, { cwd: REPO_ROOT, encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 });
    return out;
  } catch {
    return '';
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      /* ignore */
    }
  }
}

function countImports(file: string): number {
  if (!file.startsWith('server/')) return 0;
  const base = path.basename(file, path.extname(file));
  // Count references by filename in .ts/.tsx files outside tests
  try {
    const out = execSync(
      `rg -c -g '*.ts' -g '*.tsx' -F '${base}' server/ client/src/ shared/ 2>/dev/null || true`,
      { cwd: REPO_ROOT, encoding: 'utf-8' },
    );
    return parseInt(out.trim() || '0', 10) || 0;
  } catch {
    return 0;
  }
}

function detectQ3Features(file: string, snippet: string): string[] {
  const lower = (file + ' ' + snippet).toLowerCase();
  const matches: string[] = [];
  for (const [feature, data] of Object.entries(Q3_FEATURES)) {
    if (data.files.some((f) => file.toLowerCase().includes(f.toLowerCase()))) {
      matches.push(feature);
      continue;
    }
    if (data.keywords.some((k) => lower.includes(k.toLowerCase()))) {
      matches.push(feature);
    }
  }
  return matches;
}

function checkTests(file: string) {
  const base = path.basename(file, path.extname(file));

  const run = (cmd: string): boolean => {
    try {
      const out = execSync(cmd, { cwd: REPO_ROOT, encoding: 'utf-8' });
      return out.trim().length > 0;
    } catch {
      return false;
    }
  };

  const failureTest = `rg -n -g '*.test.ts' -g '*.test.tsx' -F '${base}' tests/ | rg -i 'throw|error|timeout|fail|reject' 2>/dev/null || true`;
  const successTest = `rg -n -g '*.test.ts' -g '*.test.tsx' -F '${base}' tests/ | rg -i 'success|resolve|ok|true|valid' 2>/dev/null || true`;
  const payloadTest = `rg -n -g '*.test.ts' -g '*.test.tsx' -F '${base}' tests/ | rg -i 'schema|zod|validate|payload|body|parse' 2>/dev/null || true`;

  return {
    hasFailureTest: run(failureTest),
    hasSuccessTest: run(successTest),
    hasPayloadValidationTest: run(payloadTest),
  };
}

function isCommentOrDoc(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

function isFalsePositive(name: string, snippet: string): boolean {
  const lower = snippet.toLowerCase();
  if (name === 'explicit_mock_or_stub') {
    if (
      lower.includes('placeholder=') ||
      lower.includes('placeholder:') ||
      lower.includes('placeholder "')
    )
      return true;
    if (lower.includes('data-[placeholder]') || lower.includes('placeholder)')) return true;
    if (
      lower.includes('mock') &&
      (lower.includes('test') || lower.includes('vitest') || lower.includes('jest'))
    )
      return true;
    // words in JSDoc that are not about actual mocks
    if (isCommentOrDoc(snippet) && !lower.includes('hardcoded')) return true;
  }
  if (name === 'res_json_literal') {
    // res.json with normal confirmations or simple data pass-through are not mocks
    if (
      lower.includes('message:') &&
      !lower.includes('fallback') &&
      !lower.includes('mock') &&
      !lower.includes('fake')
    )
      return true;
    if (
      lower.includes('login:') ||
      lower.includes('results:') ||
      lower.includes('flags:') ||
      lower.includes('policies,')
    )
      return true;
    if (
      lower.includes('success: true') &&
      !lower.includes('fallback') &&
      !lower.includes('mock') &&
      !lower.includes('fake') &&
      !lower.includes('placeholder') &&
      !lower.includes('data: []')
    ) {
      return true;
    }
  }
  if (name === 'mocked_literal_return') {
    // return { success: true } is normal; only flag if contains fallback/mock/fake/placeholder/error:null/empty arrays
    if (
      lower.includes('success: true') &&
      !lower.includes('fallback') &&
      !lower.includes('mock') &&
      !lower.includes('fake') &&
      !lower.includes('placeholder') &&
      !lower.includes('error: false') &&
      !lower.includes('error: null') &&
      !lower.includes('data: []')
    ) {
      return true;
    }
  }
  return false;
}

function main() {
  const candidates: Candidate[] = [];

  for (const { name, regex, onlyRuntime } of PATTERNS) {
    const raw = runGrep(regex);
    if (!raw.trim()) continue;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const match = line.match(/^(.+):(\d+):(.+)$/);
      if (!match) continue;
      const [, file, lineNumStr, snippet] = match;
      const lineNum = parseInt(lineNumStr, 10);

      if (file.includes('scripts/mock-audit-10113.ts')) continue;
      if (onlyRuntime && !file.startsWith('server/') && !file.startsWith('client/src/')) continue;
      if (isCommentOrDoc(snippet) && name !== 'explicit_mock_or_stub') continue;

      // Skip known false positives: words inside JSDoc/param names
      if (
        name === 'explicit_mock_or_stub' &&
        isCommentOrDoc(snippet) &&
        !snippet.toLowerCase().includes('hardcoded') &&
        !snippet.toLowerCase().includes('placeholder')
      ) {
        continue;
      }

      if (isFalsePositive(name, snippet)) continue;

      const tier = getTier(file, name);
      const exposure = tier <= 2 ? countImports(file) : 0;
      const q3Features = tier <= 2 ? detectQ3Features(file, snippet) : [];
      const tests =
        tier <= 2
          ? checkTests(file)
          : { hasFailureTest: false, hasSuccessTest: false, hasPayloadValidationTest: false };

      candidates.push({
        file,
        line: lineNum,
        snippet: snippet.trim().slice(0, 200),
        pattern: name,
        tier,
        exposure,
        q3Features,
        ...tests,
      });
    }
  }

  // Deduplicate by file+line
  const seen = new Set<string>();
  const unique = candidates.filter((c) => {
    const key = `${c.file}:${c.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const knownTier1 = [
    {
      file: 'server/services/openai-ai.ts',
      reason: 'Fallback estático / resposta mockada em erro',
    },
    {
      file: 'server/services/llm-guardrails.ts',
      reason: 'Comportamento fail-open em catch (mitigado recentemente, mas ainda existe opt-in)',
    },
    {
      file: 'server/services/agent-jobs.ts',
      reason: 'Ausência de fila durável — processamento em-memory',
    },
  ];

  const tier1 = unique.filter((c) => c.tier === 1).sort((a, b) => b.exposure - a.exposure);
  const tier2 = unique.filter((c) => c.tier === 2).sort((a, b) => b.exposure - a.exposure);
  const tier3 = unique.filter((c) => c.tier === 3).sort((a, b) => a.file.localeCompare(b.file));

  const score = (c: Candidate) => c.exposure * (c.tier === 1 ? 3 : 2);

  const lines: string[] = [];
  lines.push('# Relatório 10113 — Análise 360° de Conteúdo Mockado');
  lines.push('');
  lines.push('**Gerado em:** ' + new Date().toISOString());
  lines.push(
    '**Método:** grep automatizado + heurística de tier + contagem de imports + cruzamento Q3.',
  );
  lines.push('');
  lines.push('## Resumo');
  lines.push(`- Tier 1 (crítico): ${tier1.length} itens`);
  lines.push(`- Tier 2 (alto): ${tier2.length} itens`);
  lines.push(`- Tier 3 (fixtures/seeds/testes): ${tier3.length} itens`);
  lines.push('');

  lines.push('## Mocks Tier 1 já confirmados (demandas anteriores)');
  for (const k of knownTier1) {
    lines.push(`- \`${k.file}\`: ${k.reason}`);
  }
  lines.push('');

  lines.push('## Mocks Tier 1 detectados');
  if (tier1.length === 0) {
    lines.push('_Nenhum novo mock crítico detectado além dos já confirmados._');
  } else {
    lines.push('| Arquivo | Linha | Padrão | Exposure | Score | Features Q3 | Risco Testes |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const c of tier1) {
      const q3 = c.q3Features.join(', ') || 'Sem impacto Q3';
      const testRisk =
        !c.hasFailureTest || !c.hasSuccessTest || !c.hasPayloadValidationTest ? 'Risco' : 'Coberto';
      lines.push(
        `| \`${c.file}\` | ${c.line} | ${c.pattern} | ${c.exposure} | ${score(c)} | ${q3} | ${testRisk} |`,
      );
      lines.push(`| | | \`${c.snippet}\` | | | | |`);
    }
  }
  lines.push('');

  lines.push('## Mocks Tier 2 detectados');
  if (tier2.length === 0) {
    lines.push('_Nenhum mock Tier 2 detectado._');
  } else {
    lines.push('| Arquivo | Linha | Padrão | Exposure | Score | Features Q3 | Risco Testes |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const c of tier2.slice(0, 50)) {
      const q3 = c.q3Features.join(', ') || 'Sem impacto Q3';
      const testRisk =
        !c.hasFailureTest || !c.hasSuccessTest || !c.hasPayloadValidationTest ? 'Risco' : 'Coberto';
      lines.push(
        `| \`${c.file}\` | ${c.line} | ${c.pattern} | ${c.exposure} | ${score(c)} | ${q3} | ${testRisk} |`,
      );
      lines.push(`| | | \`${c.snippet}\` | | | | |`);
    }
    if (tier2.length > 50) {
      lines.push(`_... e mais ${tier2.length - 50} itens._`);
    }
  }
  lines.push('');

  lines.push('## Mocks que bloqueiam features Q3');
  const q3Blockers = [...tier1, ...tier2]
    .filter((c) => c.q3Features.length > 0)
    .sort((a, b) => score(b) - score(a));
  if (q3Blockers.length === 0) {
    lines.push('_Nenhum mock detectado impactando features Q3._');
  } else {
    lines.push('| Arquivo | Tier | Exposure | Score | Features Q3 |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const c of q3Blockers.slice(0, 30)) {
      lines.push(
        `| \`${c.file}\` | ${c.tier} | ${c.exposure} | ${score(c)} | ${c.q3Features.join(', ')} |`,
      );
    }
  }
  lines.push('');

  lines.push('## Tier 3 — Fixtures / Seeds / Testes');
  lines.push(
    `_Total: ${tier3.length} ocorrências._ Excluídas do scoring por serem artefatos de desenvolvimento.`,
  );
  if (tier3.length > 0) {
    lines.push('| Arquivo | Linha | Padrão | Snippet |');
    lines.push('| --- | --- | --- | --- |');
    for (const c of tier3.slice(0, 30)) {
      lines.push(`| \`${c.file}\` | ${c.line} | ${c.pattern} | \`${c.snippet}\` |`);
    }
    if (tier3.length > 30) {
      lines.push(`_... e mais ${tier3.length - 30} itens._`);
    }
  }
  lines.push('');

  lines.push('## Risco de Regressão (falta de testes)');
  const atRisk = [...tier1, ...tier2].filter(
    (c) => !c.hasFailureTest || !c.hasSuccessTest || !c.hasPayloadValidationTest,
  );
  if (atRisk.length === 0) {
    lines.push('_Todos os mocks Tier 1/2 têm cobertura mínima de testes._');
  } else {
    lines.push(`_Total: ${atRisk.length} mocks Tier 1/2 com cobertura incompleta._`);
    lines.push('| Arquivo | Falha | Sucesso | Payload |');
    lines.push('| --- | --- | --- | --- |');
    for (const c of atRisk.slice(0, 30)) {
      lines.push(
        `| \`${c.file}\` | ${c.hasFailureTest ? 'sim' : 'não'} | ${c.hasSuccessTest ? 'sim' : 'não'} | ${c.hasPayloadValidationTest ? 'sim' : 'não'} |`,
      );
    }
  }
  lines.push('');

  lines.push('## Notas e Limitações');
  lines.push('- Grep pode conter falsos positivos (ex: comentários com a palavra "mock").');
  lines.push('- Exposure é proxy por contagem de imports; não substitui telemetria real de uso.');
  lines.push(
    '- Cruzamento Q3 é baseado em keywords e filenames, não em análise semântica profunda.',
  );
  lines.push(
    '- Mocks de teste/fixtures/seeds foram excluídos do scoring, mas listados como Tier 3 informativo.',
  );

  fs.writeFileSync(REPORT_PATH, lines.join('\n'));
  console.log(`Relatório gerado: ${REPORT_PATH}`);
  console.log(`Tier 1: ${tier1.length}, Tier 2: ${tier2.length}, Tier 3: ${tier3.length}`);
}

main();
