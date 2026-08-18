/**
 * Demanda 10037 — geração de fluxogramas pós-refinamento.
 *
 * Produz o TEXTO-FONTE Mermaid a partir do resultado do refinamento. A
 * renderização para SVG acontece no cliente (ADR-0002), então este módulo não
 * tem dependência de browser: ele extrai, mascara PII e valida sintaxe.
 *
 * Todas as funções são puras — o chamador é quem lê documentos e persiste.
 */

export const MAX_FLOWCHART_NODES = 20;

/** Rótulo que substitui qualquer PII encontrada antes da persistência. */
const REDACTED = '[REDACTED]';

/**
 * Padrões de PII mascarados antes de o texto virar diagrama.
 *
 * A ordem importa: `token` vem antes de `email` porque uma chave de API pode
 * conter '@'; e `cpf` antes de `phone` porque as duas máscaras numéricas se
 * sobrepõem em parte do formato.
 */
const PII_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  // Bearer/API keys e afins: prefixo conhecido + corpo longo sem espaço.
  { name: 'token', pattern: /\b(?:sk|pk|tp|ghp|gho|xox[baprs])[-_][A-Za-z0-9_-]{16,}\b/g },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g },
  { name: 'email', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  // CPF com ou sem pontuação.
  { name: 'cpf', pattern: /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g },
  // CNPJ com ou sem pontuação.
  { name: 'cnpj', pattern: /\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g },
  // Telefone BR com DDD, com ou sem +55 e pontuação.
  { name: 'phone', pattern: /(?:\+55\s?)?\(?\d{2}\)?[\s.-]?9?\d{4}[\s.-]?\d{4}\b/g },
];

/** Erro de geração de artefato — vira HTTP 400 na camada de rota. */
export class ArtifactGenerationError extends Error {
  constructor(
    message: string,
    public readonly code: 'empty_input' | 'no_processes' | 'invalid_syntax',
  ) {
    super(message);
    this.name = 'ArtifactGenerationError';
  }
}

/**
 * Substitui PII por `[REDACTED]`.
 *
 * Roda ANTES de montar o diagrama, não na renderização: o texto persistido não
 * pode conter dado sensível (US5).
 */
export function maskPii(text: string): string {
  let masked = text;
  for (const { pattern } of PII_PATTERNS) {
    masked = masked.replace(pattern, REDACTED);
  }
  return masked;
}

/**
 * Extrai os passos do processo a partir do markdown do refinamento.
 *
 * Cada rótulo é limpo e então tem a PII mascarada — nessa ordem, para que o
 * marcador `[REDACTED]` sobreviva à remoção de colchetes (ver `cleanLabel`).
 *
 * Heurística, em ordem de preferência — para na primeira que render resultado:
 *   1. Títulos de tarefa (`### T1 — Fazer algo`)
 *   2. Cabeçalhos de seção de nível 2/3
 *   3. Itens de lista numerada (`1. Passo`)
 *   4. Itens de lista com marcador (`- Passo`)
 *
 * Retorna [] quando nada é reconhecido — o chamador decide se isso é erro.
 */
export function extractProcesses(markdown: string): string[] {
  const lines = markdown.split('\n');

  const strategies: Array<(line: string) => string | null> = [
    (line) => {
      const m = line.match(/^#{2,4}\s+T\d+\s*[—–-]\s*(.+)$/);
      return m ? m[1] : null;
    },
    (line) => {
      const m = line.match(/^#{2,3}\s+(?!T\d)(.+)$/);
      return m ? m[1] : null;
    },
    (line) => {
      const m = line.match(/^\s*\d+[.)]\s+(.+)$/);
      return m ? m[1] : null;
    },
    (line) => {
      const m = line.match(/^\s*[-*+]\s+(.+)$/);
      return m ? m[1] : null;
    },
  ];

  for (const strategy of strategies) {
    const found = lines
      .map((line) => strategy(line))
      .filter((value): value is string => value !== null)
      .map((value) => maskPii(cleanLabel(value)))
      .filter((value) => value.length > 0);

    if (found.length >= 2) {
      return dedupe(found).slice(0, MAX_FLOWCHART_NODES);
    }
  }

  return [];
}

/**
 * Remove marcação inline e normaliza espaços de um rótulo extraído.
 *
 * Os caracteres com significado sintático no Mermaid são removidos por
 * precaução. Verificado em 2026-07-20 que o Mermaid aceita `[`, `(`, `/` e
 * Unicode dentro de rótulos entre aspas — só `"` é realmente fatal —, mas a
 * limpeza conservadora mantém o diagrama legível e o validador simples.
 *
 * O mascaramento de PII roda DEPOIS desta função (ver `extractProcesses`):
 * fosse antes, a remoção de `[` e `]` reduziria `[REDACTED]` a `REDACTED`,
 * indistinguível de texto comum do refinamento.
 */
function cleanLabel(raw: string): string {
  return raw
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/\*([^*]*)\*/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/~~([^~]*)~~/g, '$1')
    .replace(/[{}[\]|<>"']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[:.,;]+$/, '')
    .slice(0, 80)
    .trim();
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Monta um `flowchart TD` linear a partir dos passos.
 *
 * Os rótulos já passaram por `cleanLabel`, que remove os caracteres com
 * significado sintático no Mermaid (`{}[]|<>"'`), então aqui basta envolvê-los
 * em aspas.
 */
export function buildFlowchart(processes: string[]): string {
  const nodes = processes.map((label, index) => `  N${index}["${label}"]`);
  const edges = processes.slice(1).map((_, index) => `  N${index} --> N${index + 1}`);

  return ['flowchart TD', ...nodes, ...edges].join('\n');
}

/**
 * Validação sintática do Mermaid sem browser.
 *
 * Não substitui o parser real do Mermaid (que roda no cliente) — cobre as
 * falhas que a geração pode introduzir: cabeçalho ausente, colchetes ou aspas
 * desbalanceados, aresta apontando para nó inexistente.
 */
export function validateFlowchart(source: string): { ok: true } | { ok: false; reason: string } {
  const lines = source.split('\n').filter((line) => line.trim().length > 0);

  if (lines.length === 0) return { ok: false, reason: 'diagrama vazio' };
  if (!/^flowchart\s+(TD|TB|LR|RL|BT)$/.test(lines[0].trim())) {
    return { ok: false, reason: 'primeira linha deve declarar a direção (ex.: "flowchart TD")' };
  }
  if (lines.length < 2) return { ok: false, reason: 'diagrama sem nós' };

  const declared = new Set<string>();
  const referenced: string[] = [];

  for (const line of lines.slice(1)) {
    const trimmed = line.trim();

    const nodeMatch = trimmed.match(/^([A-Za-z][\w]*)\["([^"]*)"\]$/);
    if (nodeMatch) {
      declared.add(nodeMatch[1]);
      continue;
    }

    const edgeMatch = trimmed.match(/^([A-Za-z][\w]*)\s*-->\s*([A-Za-z][\w]*)$/);
    if (edgeMatch) {
      referenced.push(edgeMatch[1], edgeMatch[2]);
      continue;
    }

    return { ok: false, reason: `linha não reconhecida: "${trimmed.slice(0, 60)}"` };
  }

  if (declared.size === 0) return { ok: false, reason: 'diagrama sem nós' };

  const orphan = referenced.find((id) => !declared.has(id));
  if (orphan) return { ok: false, reason: `aresta referencia nó inexistente: "${orphan}"` };

  return { ok: true };
}

export interface FlowchartResult {
  source: string;
  nodeCount: number;
  truncated: boolean;
}

/**
 * Pipeline completo: extrai processos (limpando e mascarando cada rótulo) →
 * monta o diagrama → valida a sintaxe.
 *
 * Só os rótulos são persistidos, e `extractProcesses` já os entrega mascarados,
 * então nenhuma PII do refinamento chega ao banco.
 */
export function generateFlowchart(markdown: string): FlowchartResult {
  if (!markdown || markdown.trim().length === 0) {
    throw new ArtifactGenerationError(
      'O refinamento está vazio. Gere o PRD, tasks ou TDD antes de criar o fluxograma.',
      'empty_input',
    );
  }

  const processes = extractProcesses(markdown);

  if (processes.length === 0) {
    throw new ArtifactGenerationError(
      'Não foi possível identificar processos no refinamento. ' +
        'O fluxograma precisa de ao menos dois passos (títulos, seções ou lista).',
      'no_processes',
    );
  }

  const source = buildFlowchart(processes);
  const validation = validateFlowchart(source);

  if (!validation.ok) {
    throw new ArtifactGenerationError(
      `Diagrama gerado é inválido: ${validation.reason}`,
      'invalid_syntax',
    );
  }

  return {
    source,
    nodeCount: processes.length,
    truncated: processes.length >= MAX_FLOWCHART_NODES,
  };
}
