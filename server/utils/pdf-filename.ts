/**
 * Spec 019 — nome legível e único de PDF por demanda+tipo.
 *
 * Uma única função constrói o filename usado tanto no salvamento em disco
 * quanto no Content-Disposition do download, eliminando a divergência entre
 * os dois caminhos. Sem data nem contador de colisão: o nome é estável, então
 * cada re-refinamento sobrescreve o PDF anterior (exatamente 1 por demanda+tipo).
 */

const MAX_BASE_LENGTH = 60;

/**
 * Sanitiza o nome da solução para uso em sistemas de arquivos e headers HTTP:
 * remove acentos, troca runs de caracteres fora de [A-Za-z0-9] por "_",
 * apara "_" das pontas e limita o comprimento. Retorna '' se nada sobrar.
 */
export function sanitizePdfBaseName(solutionName: string | null | undefined): string {
  if (!solutionName) {
    return '';
  }

  return solutionName
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, MAX_BASE_LENGTH)
    .replace(/^_+|_+$/g, '');
}

export type PdfDocType = 'PRD' | 'Tasks' | 'TSD';

/**
 * Nome final do PDF: `{NomeDaSolucao}_{Tipo}.pdf`, com fallback para os
 * primeiros 8 caracteres do ID da demanda quando o nome está vazio ou a
 * sanitização não deixa nada aproveitável (RF-01/RF-02).
 */
export function buildPdfFilename(
  solutionName: string | null | undefined,
  demandId: number | string,
  docType: PdfDocType,
): string {
  const base = sanitizePdfBaseName(solutionName) || String(demandId).slice(0, 8);
  return `${base}_${docType}.pdf`;
}
