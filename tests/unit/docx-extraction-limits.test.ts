import JSZip from 'jszip';
import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DOCX_LIMITS,
  extractTextFromUploadedFile,
  RefinementInputError,
} from '../../server/services/refinement-input';

const tmpFiles: string[] = [];

async function writeDocx(zip: JSZip): Promise<Express.Multer.File> {
  const buffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });
  const filePath = path.join(os.tmpdir(), `docx-limits-${Date.now()}-${Math.random()}.docx`);
  await fs.writeFile(filePath, buffer);
  tmpFiles.push(filePath);
  return {
    fieldname: 'files',
    originalname: 'doc.docx',
    encoding: '7bit',
    mimetype: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    size: buffer.length,
    destination: os.tmpdir(),
    filename: path.basename(filePath),
    path: filePath,
    buffer: Buffer.alloc(0),
    stream: undefined as never,
  };
}

afterEach(async () => {
  await Promise.all(tmpFiles.map((f) => fs.unlink(f).catch(() => {})));
  tmpFiles.length = 0;
});

describe('DOCX extraction limits (spec 012 FR-005)', () => {
  it('extrai texto de DOCX válido', async () => {
    const zip = new JSZip();
    zip.file(
      'word/document.xml',
      '<w:document><w:p><w:r><w:t>Olá mundo</w:t></w:r></w:p></w:document>',
    );
    const file = await writeDocx(zip);
    const text = await extractTextFromUploadedFile(file);
    expect(text).toContain('Olá mundo');
  });

  it('rejeita zip com entradas demais', async () => {
    const zip = new JSZip();
    zip.file('word/document.xml', '<w:document/>');
    for (let i = 0; i < DOCX_LIMITS.maxZipEntries + 1; i++) {
      zip.file(`junk/${i}.txt`, 'x');
    }
    const file = await writeDocx(zip);
    await expect(extractTextFromUploadedFile(file)).rejects.toThrow(RefinementInputError);
  });

  it('rejeita DOCX-bomba (expansão excessiva) antes da descompactação integral', async () => {
    const zip = new JSZip();
    // ~20KB de zip que expande para ~50MB de zeros: razão >> 100×.
    zip.file('word/document.xml', Buffer.alloc(50 * 1024 * 1024, 0x41));
    const file = await writeDocx(zip);
    await expect(extractTextFromUploadedFile(file)).rejects.toThrow(
      /expansão excessiva|tamanho suportado/,
    );
  });

  it('DOCX sem word/document.xml retorna vazio (payload inválido, não crash)', async () => {
    const zip = new JSZip();
    zip.file('outra/coisa.xml', '<x/>');
    const file = await writeDocx(zip);
    await expect(extractTextFromUploadedFile(file)).resolves.toBe('');
  });

  it('erros de segurança usam errorCode DOCUMENT_UNSAFE sem dado sensível', async () => {
    const zip = new JSZip();
    zip.file('word/document.xml', Buffer.alloc(50 * 1024 * 1024, 0x41));
    const file = await writeDocx(zip);
    try {
      await extractTextFromUploadedFile(file);
      expect.unreachable('deveria ter lançado');
    } catch (error) {
      expect(error).toBeInstanceOf(RefinementInputError);
      expect((error as RefinementInputError).errorCode).toBe('DOCUMENT_UNSAFE');
      expect((error as RefinementInputError).message).not.toContain(os.tmpdir());
    }
  });
});
