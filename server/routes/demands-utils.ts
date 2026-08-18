import { resolvePath } from '@shared/utils/paths';
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger';

/**
 * Resolve o nome do arquivo markdown aplicando mapeamento do prd_mapping.json
 * Retorna o nome do arquivo sanitizado ou null em caso de erro
 *
 * 🟢 Guard clause: retorna arquivo original se mapeamento falhar
 */
export function resolveMappedMarkdownFile(markdownFile: string): string | null {
  const mappingPath = resolvePath('prd_mapping.json');
  if (!fs.existsSync(mappingPath)) {
    return markdownFile;
  }

  try {
    const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8'));
    const mappedFile = mapping[markdownFile];
    if (mappedFile && !mappedFile.includes('..')) {
      return path.basename(mappedFile);
    }
    return markdownFile;
  } catch (e) {
    logger.warn('Failed to parse prd_mapping.json', {
      error: e instanceof Error ? e : undefined,
    });
    return markdownFile;
  }
}

/**
 * Lê o conteúdo de um arquivo markdown do diretório documents
 * Retorna o conteúdo ou null se o arquivo não existir ou for inválido
 *
 * 🟢 Guard clause: retorna null se path traversal detectado
 */
export function readMarkdownFile(markdownFile: string): string | null {
  const documentsDir = resolvePath('documents');
  const markdownPath = path.join(documentsDir, markdownFile);
  const resolvedPath = path.resolve(markdownPath);

  if (!resolvedPath.startsWith(path.resolve(documentsDir))) {
    return null;
  }

  if (!fs.existsSync(resolvedPath)) {
    return null;
  }

  const content = fs.readFileSync(resolvedPath, 'utf8');
  return content;
}

/**
 * Carrega o conteúdo de um documento markdown baseado no tipo e URL da demanda
 * Aplica sanitização de path, mapeamento de arquivo e validação de conteúdo
 */
export function loadDocumentContent(
  type: string,
  prdUrl: string | null,
  tasksUrl: string | null,
  tddUrl: string | null = null,
): string {
  const urlPath = type === 'prd' ? prdUrl : type === 'tdd' ? tddUrl : tasksUrl;
  if (!urlPath) {
    return '';
  }

  const filenameWithPdf = urlPath.split('/').pop() || '';
  let markdownFile = filenameWithPdf.replace('.pdf', '.md').replace('.txt', '.md');

  // Security: Sanitize filename to prevent path traversal
  markdownFile = path.basename(markdownFile).replace(/\.\./g, '');
  if (!markdownFile || markdownFile.includes('..')) {
    logger.warn('Path traversal attempt blocked', { context: { filename: filenameWithPdf } });
    return '';
  }

  // Apply mapping from prd_mapping.json
  markdownFile = resolveMappedMarkdownFile(markdownFile) || markdownFile;
  if (!markdownFile) {
    return '';
  }

  // Read markdown file from documents directory
  const fileContent = readMarkdownFile(markdownFile);
  return fileContent || '';
}
