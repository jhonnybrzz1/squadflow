import fs from 'fs/promises';
import path from 'path';
import JSZip from 'jszip';
import { PDFParse } from 'pdf-parse';

export type RefinementInputSource = 'description' | 'document' | 'description_document';

export interface RefinementInputResolution {
  ideaText: string;
  refinementInputSource: RefinementInputSource;
  documentText: string;
  documentTextLength: number;
  ideaTextLength: number;
}

export class RefinementInputError extends Error {
  constructor(
    public readonly errorCode: 'DOCUMENT_TEXT_EMPTY' | 'DOCUMENT_UNSAFE',
    message: string,
  ) {
    super(message);
    this.name = 'RefinementInputError';
  }
}

// Spec 012 (H-06/FR-005): caps de descompressão do caminho DOCX.
// Ver specs/012-seguranca-local-guardrails/data-model.md#DocxExtractionLimits.
export const DOCX_LIMITS = {
  maxInputBytes: 10 * 1024 * 1024,
  maxZipEntries: 200,
  maxXmlOutputBytes: 20 * 1024 * 1024,
  maxCompressionRatio: 100,
} as const;

async function extractDocxText(buffer: Buffer): Promise<string> {
  if (buffer.length > DOCX_LIMITS.maxInputBytes) {
    throw new RefinementInputError('DOCUMENT_UNSAFE', 'Documento DOCX excede o tamanho suportado');
  }

  const zip = await JSZip.loadAsync(buffer);
  if (Object.keys(zip.files).length > DOCX_LIMITS.maxZipEntries) {
    throw new RefinementInputError(
      'DOCUMENT_UNSAFE',
      'Documento DOCX contém entradas demais para ser processado com segurança',
    );
  }

  const entry = zip.file('word/document.xml');
  if (!entry) {
    return '';
  }

  // Teto aplicado DURANTE o stream: o metadado de tamanho do zip é forjável,
  // então a defesa real é abortar quando a saída excede o orçamento.
  const outputCap = Math.min(
    DOCX_LIMITS.maxXmlOutputBytes,
    buffer.length * DOCX_LIMITS.maxCompressionRatio,
  );
  const chunks: Buffer[] = [];
  let outputBytes = 0;

  const documentXml = await new Promise<string>((resolve, reject) => {
    const stream = entry.nodeStream();
    stream.on('data', (chunk: Buffer | string) => {
      const asBuffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      outputBytes += asBuffer.length;
      if (outputBytes > outputCap) {
        stream.pause();
        reject(
          new RefinementInputError(
            'DOCUMENT_UNSAFE',
            'Documento DOCX com expansão excessiva foi rejeitado',
          ),
        );
        return;
      }
      chunks.push(asBuffer);
    });
    stream.on('error', (error) => reject(error));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });

  return documentXml;
}

export async function extractTextFromUploadedFile(file: Express.Multer.File): Promise<string> {
  const ext = path.extname(file.originalname || file.path).toLowerCase();
  const mimeType = file.mimetype || '';

  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    ext === '.docx'
  ) {
    const buffer = await fs.readFile(file.path);
    const documentXml = await extractDocxText(buffer);

    if (!documentXml) {
      return '';
    }

    return documentXml
      .replace(/<w:tab\/>/g, '\t')
      .replace(/<\/w:p>/g, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .trim();
  }

  if (mimeType === 'application/pdf' || ext === '.pdf') {
    const buffer = await fs.readFile(file.path);
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      return result.text || '';
    } finally {
      await parser.destroy();
    }
  }

  if (mimeType.startsWith('text/') || ['.txt', '.md', '.markdown', '.csv', '.json'].includes(ext)) {
    return fs.readFile(file.path, 'utf8');
  }

  return '';
}

export async function extractTextFromUploadedFiles(
  files: Express.Multer.File[] = [],
): Promise<string> {
  const extractedParts: string[] = [];

  for (const file of files) {
    const text = await extractTextFromUploadedFile(file);
    if (text.trim()) {
      extractedParts.push(text.trim());
    }
  }

  return extractedParts.join('\n\n---\n\n').trim();
}

export async function resolveRefinementInput(
  description: string | null | undefined,
  files: Express.Multer.File[] = [],
): Promise<RefinementInputResolution> {
  const descriptionText = description?.trim() ?? '';
  const documentText = await extractTextFromUploadedFiles(files);

  if (descriptionText && documentText.trim()) {
    const combined = `${descriptionText}

---
**DOCUMENTAÇÃO ANEXADA (EXTRAÍDA PARA REFINAMENTO):**
${documentText}`.trim();

    return {
      ideaText: combined,
      refinementInputSource: 'description_document',
      documentText,
      documentTextLength: documentText.length,
      ideaTextLength: combined.length,
    };
  }

  if (descriptionText) {
    return {
      ideaText: descriptionText,
      refinementInputSource: 'description',
      documentText,
      documentTextLength: documentText.length,
      ideaTextLength: descriptionText.length,
    };
  }

  if (!documentText.trim()) {
    throw new RefinementInputError(
      'DOCUMENT_TEXT_EMPTY',
      'A descrição está vazia e não foi possível extrair texto do documento anexado.',
    );
  }

  return {
    ideaText: documentText,
    refinementInputSource: 'document',
    documentText,
    documentTextLength: documentText.length,
    ideaTextLength: documentText.length,
  };
}
