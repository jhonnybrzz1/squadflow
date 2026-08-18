import { z } from 'zod';
import { Demand, ChatMessage } from '@shared/schema';
import { logger } from '../utils/logger';
import type { ValidationIssue } from './improvement-execution';

/**
 * Provenance de um claim numérico (Fase 3): registra cada número detectado, se foi
 * ancorado em alguma fonte e qual trecho o ancora. Foundation para validação por
 * claim em vez de checagem cega por substring.
 */
export interface NumericClaimProvenance {
  value: string;
  location: 'metrics_table' | 'prose';
  field?: 'baseline' | 'meta';
  anchored: boolean;
  anchoredBy?: string; // trecho da fonte que ancora o número (provenance)
  action: 'kept' | 'removed' | 'marked';
}

/**
 * Schema do bloco "Numeric Provenance" (Fase 3 / slice 5): provenance declarada na
 * EMISSÃO — o agente lista cada número usado e o trecho da fonte de onde veio, em vez
 * de o número ser ancorado por adivinhação pós-hoc.
 */
const numericProvenanceBlockSchema = z.object({
  claims: z.array(
    z.object({
      value: z.string().min(1),
      source: z.string().min(1),
    }),
  ),
});

/**
 * Spec 008 / US7: pós-processa a linha após a substituição de números para que
 * o marcador "[A MEDIR]" não quebre a gramática da frase — o QA (007-03)
 * encontrou artefatos como "MVP em [A MEDIR] )" e "custo: ~ [A MEDIR]".
 * Só toca em pontuação/aproximadores ao redor do marcador; nunca altera prosa.
 */
export function polishMeasurementMarkers(line: string): string {
  let out = line;
  // Aproximadores órfãos colados ao marcador: "~ [A MEDIR]", "≈ [A MEDIR]", "aprox. [A MEDIR]"
  out = out.replace(/(?:~|≈|aprox\.?|approx\.?)\s*(\[A MEDIR\])/gi, '$1');
  // Marcadores duplicados consecutivos (ranges substituídos em partes)
  out = out.replace(/\[A MEDIR\](?:\s*(?:e|a|-|–|\/|,)?\s*\[A MEDIR\])+/g, '[A MEDIR]');
  // Espaços presos dentro de parênteses: "( [A MEDIR]" / "[A MEDIR] )"
  out = out.replace(/\(\s+\[A MEDIR\]/g, '([A MEDIR]');
  out = out.replace(/\[A MEDIR\]\s+\)/g, '[A MEDIR])');
  // Parênteses esvaziados pelas remoções
  out = out.replace(/\(\s*\)/g, '');
  return out.replace(/\s+/g, ' ').trim();
}

export class NumericIntegrityValidator {
  /**
   * Escaneia e valida a integridade dos dados numéricos em todo o PRD
   * (tanto nas tabelas de métricas quanto na prosa).
   * Substitui números não ancorados por "A MEDIR — sem baseline" ou "Definir após baseline".
   * Retorna também um `ledger` de provenance por claim numérico.
   */
  static validate(
    prdContent: string,
    demand: Demand,
    refinementMessages: ChatMessage[],
    sourceLabel = 'PRD',
    mode: 'remove' | 'mark' = 'remove',
  ): {
    cleanPrd: string;
    removedCount: number;
    ledger: NumericClaimProvenance[];
  } {
    // 1. Coletar todas as fontes válidas de grounding (B4)
    const sources: string[] = [
      demand.title || '',
      demand.description || '',
      ...refinementMessages.map((m) => m.message || ''),
    ];

    // Helper para extrair o núcleo da expressão
    const getCoreExpression = (matchText: string): string => {
      return matchText
        .replace(/^(?:cerca de|aproximadamente|~|com|de|para|em|ROI|estimado)\s+/gi, '')
        .replace(/\s+(?:de|em|para)$/gi, '')
        .replace(/^~/, '')
        .trim();
    };

    // 2. Definir os padrões numéricos estendidos (B1)
    // Os padrões de percentual e prazo aceitam ranges (ex: "20-30%", "5–10%", "2-3 dias")
    // para que a faixa inteira seja tratada como um único match (evita sobras como "20-").
    const percentageRegex =
      /(?:cerca de|aproximadamente|~)?\s*\b\d+(?:[.,]\d+)?(?:\s*[-–—]\s*\d+(?:[.,]\d+)?)?%\s*(?:de|em)?/gi;
    const roiRegex =
      /(?:com\s+)?(?:ROI\s+)?(?:esperado\s+|estimado\s+)?(?:para\s+esta\s+iniciativa\s+)?(?:é\s+|de\s+)*\b\d+:\d+\b/gi;
    const monetaryRegex = /(?:cerca de|aproximadamente|~)?\s*\b[R$]+\s*\d+(?:[.,]\d+)?\b/gi;
    const monetaryRegexAlt = /\$\s?\d+(?:[.,]\d+)?\b/gi;
    const deadlineRegex =
      /(?:de|para)?\s*\b\d+(?:[.,]\d+)?(?:\s*[-–—]\s*\d+(?:[.,]\d+)?)?\s*(?:h|hora|horas|dia|dias|semana|semanas|m[êe]s|m[êe]ses|meses)\b\s*(?:para)?/gi;

    const allPatterns = [percentageRegex, roiRegex, monetaryRegex, monetaryRegexAlt, deadlineRegex];

    const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Helper de provenance (prosa): retorna o trecho da fonte que ancora o token, ou
    // null. Usa fronteira numérica (lookbehind/lookahead contra [\d.,]) para não casar
    // o número dentro de um número maior na fonte (ex.: "2 semanas" não casa em
    // "12 semanas"). Busca por fonte individual para registrar a origem.
    const findAnchor = (matchText: string): string | null => {
      const token = matchText.toLowerCase().trim();
      if (!token) return null;
      const boundedRe = new RegExp(`(?<![\\d.,])${escapeRegExp(token)}(?![\\d.,])`);
      const source = sources.find((s) => boundedRe.test(s.toLowerCase()));
      return source ? source.slice(0, 120) : null;
    };
    // Provenance com fronteira numérica para células da tabela (só dígitos crus):
    // evita ancorar um dígito isolado contido em um número maior na fonte
    // (ex.: "5" não casa em "50"/"2025") — corrige o falso-positivo da diagnose.
    const findNumberAnchor = (numStr: string): string | null => {
      const token = numStr.trim();
      if (!token) return null;
      const boundedRe = new RegExp(`(?<![\\d.,])${token}(?![\\d.,])`);
      const source = sources.find((s) => boundedRe.test(s));
      return source ? source.slice(0, 120) : null;
    };

    const ledger: NumericClaimProvenance[] = [];
    let removedCount = 0;
    const lines = prdContent.split('\n');
    let inMetricsTable = false;

    const updatedLines = lines.map((line) => {
      // Identificar se entramos na tabela de métricas
      if (line.includes('|')) {
        const lowerLine = line.toLowerCase();
        if (
          lowerLine.includes('métrica') &&
          lowerLine.includes('baseline') &&
          lowerLine.includes('meta')
        ) {
          inMetricsTable = true;
          return line;
        }

        // Linha de separador de cabeçalho tipo |---|---|
        if (line.includes('-')) {
          return line;
        }

        if (inMetricsTable) {
          const parts = line.split('|');
          if (parts.length >= 4) {
            // parts[0] é antes do primeiro |, parts[1] é Métrica, parts[2] é Baseline, parts[3] é Meta
            const baselineCell = parts[2].trim();
            const metaCell = parts[3].trim();

            // Validar Baseline (parts[2])
            let baselineChanged = false;
            // Procurar números usando regex simples de dígitos na célula
            const digits = baselineCell.match(/\d+/g);
            if (digits) {
              for (const digit of digits) {
                if (findNumberAnchor(digit) === null) {
                  baselineChanged = true;
                  break;
                }
              }
            }
            if (baselineChanged) {
              parts[2] = ` A MEDIR — sem baseline `;
              removedCount++;
            }
            if (digits) {
              ledger.push(
                baselineChanged
                  ? {
                      value: baselineCell,
                      location: 'metrics_table',
                      field: 'baseline',
                      anchored: false,
                      action: 'marked',
                    }
                  : {
                      value: baselineCell,
                      location: 'metrics_table',
                      field: 'baseline',
                      anchored: true,
                      anchoredBy: findNumberAnchor(digits[0]) ?? undefined,
                      action: 'kept',
                    },
              );
            }

            // Validar Meta (parts[3])
            let metaChanged = false;
            const metaDigits = metaCell.match(/\d+/g);
            if (metaDigits) {
              for (const digit of metaDigits) {
                if (findNumberAnchor(digit) === null) {
                  metaChanged = true;
                  break;
                }
              }
            }
            if (metaChanged) {
              parts[3] = ` Definir após baseline `;
              removedCount++;
            }
            if (metaDigits) {
              ledger.push(
                metaChanged
                  ? {
                      value: metaCell,
                      location: 'metrics_table',
                      field: 'meta',
                      anchored: false,
                      action: 'marked',
                    }
                  : {
                      value: metaCell,
                      location: 'metrics_table',
                      field: 'meta',
                      anchored: true,
                      anchoredBy: findNumberAnchor(metaDigits[0]) ?? undefined,
                      action: 'kept',
                    },
              );
            }

            return parts.join('|');
          }
        }
      } else {
        // Saiu da tabela
        inMetricsTable = false;
      }

      // Se for prosa (não é linha de tabela)
      if (!line.includes('|')) {
        let updatedLine = line;

        // Rodar os padrões para remover números não-ancorados da prosa
        for (const regex of allPatterns) {
          regex.lastIndex = 0;
          let match: RegExpExecArray | null;

          const matchesToReplace: { text: string; start: number; end: number }[] = [];

          while ((match = regex.exec(updatedLine)) !== null) {
            const matchText = match[0];
            const coreExpr = getCoreExpression(matchText);

            // Verificar se o núcleo do match está ancorado e registrar a provenance.
            const anchor = findAnchor(coreExpr);
            if (anchor === null) {
              matchesToReplace.push({
                text: matchText,
                start: match.index,
                end: match.index + matchText.length,
              });
              ledger.push({
                value: coreExpr,
                location: 'prose',
                anchored: false,
                action: mode === 'mark' ? 'marked' : 'removed',
              });
            } else {
              ledger.push({
                value: coreExpr,
                location: 'prose',
                anchored: true,
                anchoredBy: anchor,
                action: 'kept',
              });
            }
          }

          // Substituir de trás para a frente.
          // 'remove' (default/PRD): apaga o número. 'mark' (resposta crua do agente):
          // troca por marcador legível pra não deixar a frase com buraco. As bordas
          // de espaço são normalizadas pelo collapse de whitespace logo abaixo.
          const replacement = mode === 'mark' ? ' [A MEDIR] ' : '';
          for (let i = matchesToReplace.length - 1; i >= 0; i--) {
            const m = matchesToReplace[i];
            updatedLine =
              updatedLine.substring(0, m.start) + replacement + updatedLine.substring(m.end);
            removedCount++;
          }
        }

        // Limpar múltiplos espaços criados pelas remoções e remover espaços extras no fim/início
        updatedLine = updatedLine.replace(/\s+/g, ' ').trim();
        // Spec 008 / US7: normalizar pontuação ao redor de "[A MEDIR]" para não quebrar frases
        updatedLine = polishMeasurementMarkers(updatedLine);
        if (updatedLine === ',' || updatedLine === '.' || updatedLine === '~') {
          updatedLine = '';
        }

        return updatedLine;
      }

      return line;
    });

    // Idempotência (B5): Garantir que múltiplas passagens limpem espaços extras e mantenham a formatação
    const cleanPrd = updatedLines.join('\n').replace(/\n{3,}/g, '\n\n');

    if (removedCount > 0) {
      logger.info(`Grounding numérico (${sourceLabel}): Números fabricados removidos`, {
        context: {
          demandId: demand.id,
          removedCount,
          claimsTotal: ledger.length,
          claimsAnchored: ledger.filter((c) => c.anchored).length,
        },
      });
    }

    return {
      cleanPrd,
      removedCount,
      ledger,
    };
  }

  /**
   * Verifica a provenance DECLARADA pelo agente na emissão (slice 5). Extrai um bloco
   * "Numeric Provenance" (JSON) e confere, para cada claim, que (a) a fonte declarada
   * existe entre as fontes reais e (b) o número do claim consta nessa fonte (fronteira
   * numérica). Falhas viram ValidationIssue 'error' (contrato unificado). Sem bloco,
   * não bloqueia. Retorna também o conteúdo sem o bloco.
   */
  static verifyDeclaredProvenance(
    content: string,
    demand: Demand,
    refinementMessages: ChatMessage[],
  ): { valid: boolean; issues: ValidationIssue[]; cleanContent: string } {
    const match = content.match(
      /\*\*Numeric Provenance.*?\*\*.*?(?:```json)?\s*(\{[\s\S]*?\})\s*(?:```|$)/is,
    );

    if (!match || !match[1]) {
      // Sem bloco declarado: nada a verificar (não bloqueia).
      return { valid: true, issues: [], cleanContent: content };
    }

    const cleanContent = content.replace(match[0], '').trim();

    let raw: unknown;
    try {
      raw = JSON.parse(match[1]);
    } catch (_) {
      return {
        valid: false,
        issues: [
          {
            section: 'Numeric Provenance',
            message: 'Numeric Provenance: JSON inválido',
            severity: 'error',
            category: 'metrics',
          },
        ],
        cleanContent,
      };
    }

    const parsed = numericProvenanceBlockSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        valid: false,
        issues: parsed.error.issues.map((issue) => ({
          section: 'Numeric Provenance',
          message: `Numeric Provenance — ${issue.path.join('.') || 'root'}: ${issue.message}`,
          severity: 'error' as const,
          category: 'metrics' as const,
        })),
        cleanContent,
      };
    }

    const sources = [
      demand.title || '',
      demand.description || '',
      ...refinementMessages.map((m) => m.message || ''),
    ].map((s) => s.toLowerCase());

    const issues: ValidationIssue[] = [];
    for (const claim of parsed.data.claims) {
      const declaredSource = claim.source.toLowerCase().trim();
      const matchingSource = sources.find((s) => s.includes(declaredSource));

      if (!matchingSource) {
        issues.push({
          section: 'Numeric Provenance',
          message: `Fonte declarada não encontrada para "${claim.value}": "${claim.source}"`,
          severity: 'error',
          category: 'metrics',
        });
        continue;
      }

      // O número do claim deve constar na fonte real apontada (fronteira numérica).
      const digits = claim.value.match(/\d+/g) || [];
      const numberInSource = digits.every((digit) =>
        new RegExp(`(?<![\\d.,])${digit}(?![\\d.,])`).test(matchingSource),
      );
      if (digits.length > 0 && !numberInSource) {
        issues.push({
          section: 'Numeric Provenance',
          message: `Número "${claim.value}" não consta na fonte declarada`,
          severity: 'error',
          category: 'metrics',
        });
      }
    }

    return { valid: issues.length === 0, issues, cleanContent };
  }
}
