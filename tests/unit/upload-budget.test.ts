import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  cleanupUploadedFiles,
  matchesDeclaredType,
  MULTER_LIMITS,
  UPLOAD_BUDGET,
  validateUploadedFiles,
} from '../../server/services/upload-budget';

const tmpFiles: string[] = [];

async function makeTempFile(content: Buffer): Promise<string> {
  const filePath = path.join(os.tmpdir(), `upload-budget-test-${Date.now()}-${Math.random()}`);
  await fs.writeFile(filePath, content);
  tmpFiles.push(filePath);
  return filePath;
}

function multerFile(overrides: Partial<Express.Multer.File>): Express.Multer.File {
  return {
    fieldname: 'files',
    originalname: 'file.bin',
    encoding: '7bit',
    mimetype: 'application/octet-stream',
    size: 0,
    destination: os.tmpdir(),
    filename: 'file.bin',
    path: '',
    buffer: Buffer.alloc(0),
    stream: undefined as never,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(tmpFiles.map((f) => fs.unlink(f).catch(() => {})));
  tmpFiles.length = 0;
});

describe('MULTER_LIMITS', () => {
  it('cobre todas as dimensões estruturais do orçamento', () => {
    expect(MULTER_LIMITS.fileSize).toBe(10 * 1024 * 1024);
    expect(MULTER_LIMITS.files).toBe(10);
    expect(MULTER_LIMITS.parts).toBe(30);
    expect(MULTER_LIMITS.fields).toBe(20);
    expect(MULTER_LIMITS.fieldSize).toBe(64 * 1024);
  });
});

describe('matchesDeclaredType', () => {
  it('aceita assinaturas corretas', () => {
    expect(matchesDeclaredType('image/png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]))).toBe(
      true,
    );
    expect(matchesDeclaredType('image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    expect(matchesDeclaredType('application/pdf', Buffer.from('%PDF-1.7'))).toBe(true);
    expect(
      matchesDeclaredType(
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      ),
    ).toBe(true);
    expect(matchesDeclaredType('text/plain', Buffer.from('hello world'))).toBe(true);
  });

  it('rejeita PNG renomeado como texto (assinatura diverge)', () => {
    const pngHead = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
    expect(matchesDeclaredType('text/plain', pngHead)).toBe(false);
  });

  it('rejeita texto declarado como PNG', () => {
    expect(matchesDeclaredType('image/png', Buffer.from('not a png'))).toBe(false);
  });

  it('rejeita arquivo vazio', () => {
    expect(matchesDeclaredType('text/plain', Buffer.alloc(0))).toBe(false);
  });

  it('rejeita tipo desconhecido sem assinatura', () => {
    expect(matchesDeclaredType('application/x-thing', Buffer.from('data'))).toBe(false);
  });
});

describe('validateUploadedFiles', () => {
  it('aceita arquivos dentro do orçamento com assinatura válida', async () => {
    const filePath = await makeTempFile(Buffer.from('conteudo de texto'));
    const result = await validateUploadedFiles([
      multerFile({ path: filePath, size: 17, mimetype: 'text/plain' }),
    ]);
    expect(result.ok).toBe(true);
  });

  it('rejeita orçamento total excedido (reason budget)', async () => {
    const files = [
      multerFile({ path: '/dev/null', size: UPLOAD_BUDGET.maxTotalBytes - 1000 }),
      multerFile({ path: '/dev/null', size: 2000 }),
    ];
    const result = await validateUploadedFiles(files);
    expect(result).toEqual({ ok: false, reason: 'budget' });
  });

  it('rejeita assinatura divergente (reason signature) sem processar o request', async () => {
    const fakeTxt = await makeTempFile(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));
    const result = await validateUploadedFiles([
      multerFile({ path: fakeTxt, size: 5, mimetype: 'text/plain', originalname: 'fake.txt' }),
    ]);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('signature');
    expect(result.offendingFile).toBe('fake.txt');
  });
});

describe('cleanupUploadedFiles', () => {
  it('remove todos os temporários do request e é idempotente', async () => {
    const a = await makeTempFile(Buffer.from('a'));
    const b = await makeTempFile(Buffer.from('b'));
    const req = {
      files: [multerFile({ path: a }), multerFile({ path: b })],
    } as unknown as import('express').Request;

    await cleanupUploadedFiles(req);
    await expect(fs.access(a)).rejects.toThrow();
    await expect(fs.access(b)).rejects.toThrow();

    // Segunda chamada não lança (ENOENT ignorado).
    await expect(cleanupUploadedFiles(req)).resolves.toBeUndefined();
  });
});
