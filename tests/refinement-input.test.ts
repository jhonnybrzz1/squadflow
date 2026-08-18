import fs from 'fs/promises';
import JSZip from 'jszip';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { RefinementInputError, resolveRefinementInput } from '../server/services/refinement-input';

const tempFiles: string[] = [];

async function createUploadedTextFile(
  content: string,
  originalname = 'prd-fixture.txt',
): Promise<Express.Multer.File> {
  const filePath = path.join(
    os.tmpdir(),
    `aichatflow-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`,
  );
  await fs.writeFile(filePath, content, 'utf8');
  tempFiles.push(filePath);

  return {
    fieldname: 'files',
    originalname,
    encoding: '7bit',
    mimetype: 'text/plain',
    destination: os.tmpdir(),
    filename: path.basename(filePath),
    path: filePath,
    size: Buffer.byteLength(content),
  };
}

async function createUploadedDocxFile(content: string): Promise<Express.Multer.File> {
  const filePath = path.join(
    os.tmpdir(),
    `aichatflow-${Date.now()}-${Math.random().toString(16).slice(2)}.docx`,
  );
  const zip = new JSZip();
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
      <w:body>
        <w:p><w:r><w:t>${content}</w:t></w:r></w:p>
      </w:body>
    </w:document>`,
  );
  const buffer = await zip.generateAsync({ type: 'nodebuffer' });
  await fs.writeFile(filePath, buffer);
  tempFiles.push(filePath);

  return {
    fieldname: 'files',
    originalname: 'prd-fixture.docx',
    encoding: '7bit',
    mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    destination: os.tmpdir(),
    filename: path.basename(filePath),
    path: filePath,
    size: buffer.length,
  };
}

afterEach(async () => {
  await Promise.all(tempFiles.splice(0).map((file) => fs.unlink(file).catch(() => undefined)));
});

describe('resolveRefinementInput', () => {
  it('uses extracted document text when description is empty', async () => {
    const prdText = [
      'PRD_ASSINATURA_LOGIN_BIOMETRICO',
      'Critério de aceite: o refinamento precisa citar fallback seguro.',
      'Não fazer: redesenhar a arquitetura.',
    ].join('\n');

    const file = await createUploadedTextFile(prdText);
    const result = await resolveRefinementInput('', [file]);

    expect(result.refinementInputSource).toBe('document');
    expect(result.ideaText).toContain('PRD_ASSINATURA_LOGIN_BIOMETRICO');
    expect(result.ideaText).toContain('fallback seguro');
    expect(result.documentTextLength).toBe(result.ideaTextLength);
  });

  it('treats spaces-only description as empty and uses the document', async () => {
    const file = await createUploadedTextFile('PRD_ASSINATURA_SPACES_ONLY');
    const result = await resolveRefinementInput('   \n\t  ', [file]);

    expect(result.refinementInputSource).toBe('document');
    expect(result.ideaText).toContain('PRD_ASSINATURA_SPACES_ONLY');
  });

  it('extracts text from docx uploads when description is empty', async () => {
    const file = await createUploadedDocxFile('PRD_ASSINATURA_DOCX_COM_CONTEUDO');
    const result = await resolveRefinementInput('', [file]);

    expect(result.refinementInputSource).toBe('document');
    expect(result.ideaText).toContain('PRD_ASSINATURA_DOCX_COM_CONTEUDO');
  });

  it('combines description and document when both are provided', async () => {
    const file = await createUploadedTextFile('PRD_ASSINATURA_IGNORADA');
    const result = await resolveRefinementInput('Descrição preenchida deve vencer.', [file]);

    expect(result.refinementInputSource).toBe('description_document');
    expect(result.ideaText).toContain('Descrição preenchida deve vencer.');
    expect(result.ideaText).toContain('PRD_ASSINATURA_IGNORADA');
    expect(result.documentTextLength).toBeGreaterThan(0);
  });

  it('fails fast when description and extracted document text are empty', async () => {
    const file = await createUploadedTextFile('   ');

    await expect(resolveRefinementInput('', [file])).rejects.toMatchObject({
      errorCode: 'DOCUMENT_TEXT_EMPTY',
    } satisfies Partial<RefinementInputError>);
  });
});
