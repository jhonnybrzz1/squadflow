/**
 * FEAT-20260724-001 — materialização de specs a partir do refinamento.
 * Usa um diretório temporário real, sem tocar no repo.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { materializeSpec } from '../server/services/spec-materializer';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'specmat-'));
  fs.mkdirSync(path.join(root, 'documents'), { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function writeDoc(name: string, content: string) {
  fs.writeFileSync(path.join(root, 'documents', name), content);
}

describe('materializeSpec', () => {
  it('cria spec.md/tasks.md a partir do PRD e Tasks', () => {
    writeDoc('PRD_500_v1.md', '# Demanda - Feature de teste\n\n## Objetivo\nfazer X.');
    writeDoc('Tasks_500_v1.md', '# Tasks\n- [ ] T1');

    const r = materializeSpec(500, { projectRoot: root });
    expect(r.status).toBe('created');
    expect(r.files).toEqual(['spec.md', 'tasks.md']);

    const dir = path.join(root, 'specs', '500-handoff');
    expect(fs.readFileSync(path.join(dir, 'spec.md'), 'utf8')).toContain('Feature de teste');
    expect(fs.readFileSync(path.join(dir, 'tasks.md'), 'utf8')).toContain('T1');
  });

  // P0 grounding, critério 5: `evidence.md` é do fechamento da IMPLEMENTAÇÃO
  // (gates executados), não do refinamento. Gerá-lo aqui produzia um documento
  // com cara de verificação sem que nenhuma tivesse ocorrido — foi o caso das
  // demandas 10330/10332/10336.
  it('NÃO cria evidence.md apenas por concluir o refinamento', () => {
    writeDoc('PRD_502_v1.md', '# Demanda - Sem evidência no refino');
    writeDoc('Tasks_502_v1.md', '# Tasks\n- [ ] T1');

    const r = materializeSpec(502, { projectRoot: root });

    expect(r.files).not.toContain('evidence.md');
    expect(fs.existsSync(path.join(root, 'specs', '502-handoff', 'evidence.md'))).toBe(false);
  });

  it('escolhe a MAIOR versão do PRD (v2 sobre v1)', () => {
    writeDoc('PRD_500_v1.md', '# Demanda - Versão um');
    writeDoc('PRD_500_v2.md', '# Demanda - Versão dois');
    materializeSpec(500, { projectRoot: root });
    const spec = fs.readFileSync(path.join(root, 'specs', '500-handoff', 'spec.md'), 'utf8');
    expect(spec).toContain('Versão dois');
  });

  it('NÃO sobrescreve spec existente (regra LRN-20260718-001)', () => {
    fs.mkdirSync(path.join(root, 'specs', '500-handoff'), { recursive: true });
    fs.writeFileSync(path.join(root, 'specs', '500-handoff', 'spec.md'), 'ORIGINAL');
    writeDoc('PRD_500_v1.md', '# Demanda - Não deveria sobrescrever');

    const r = materializeSpec(500, { projectRoot: root });
    expect(r.status).toBe('skipped-exists');
    expect(fs.readFileSync(path.join(root, 'specs', '500-handoff', 'spec.md'), 'utf8')).toBe(
      'ORIGINAL',
    );
  });

  it('sem PRD, não cria nada', () => {
    const r = materializeSpec(999, { projectRoot: root });
    expect(r.status).toBe('skipped-no-prd');
    expect(fs.existsSync(path.join(root, 'specs', '999-handoff'))).toBe(false);
  });

  it('PRD sem Tasks: cria só spec.md', () => {
    writeDoc('PRD_501_v1.md', '# Demanda - Só PRD');
    const r = materializeSpec(501, { projectRoot: root });
    expect(r.files).toEqual(['spec.md']);
  });
});
