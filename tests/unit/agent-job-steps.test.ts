import { describe, it, expect } from 'vitest';
import { parseAgentSteps } from '../../server/services/agent-job-steps';

describe('parseAgentSteps (spec 10064 Batch 2)', () => {
  it('extrai tool_use, texto e resultado de stream-json', () => {
    const stdout = [
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Vou editar o arquivo.' },
            { type: 'tool_use', name: 'Edit', input: { file_path: 'server/foo.ts' } },
          ],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }],
        },
      }),
      JSON.stringify({ type: 'result', subtype: 'success', result: 'done' }),
    ].join('\n');

    const steps = parseAgentSteps(stdout);

    expect(steps).toEqual([
      { kind: 'text', label: 'Vou editar o arquivo.' },
      { kind: 'tool', label: 'Edit server/foo.ts' },
      { kind: 'tool', label: 'Bash npm test' },
      { kind: 'result', label: 'done' },
    ]);
  });

  it('faz fallback para linhas de transcript quando não é JSON', () => {
    const stdout = 'linha 1\n\n  linha 2  \nlinha 3';
    const steps = parseAgentSteps(stdout);
    expect(steps).toEqual([
      { kind: 'text', label: 'linha 1' },
      { kind: 'text', label: 'linha 2' },
      { kind: 'text', label: 'linha 3' },
    ]);
  });

  it('usa stderr como passo de erro quando stdout não rende passos', () => {
    const steps = parseAgentSteps('', 'ENOENT: claude não encontrado');
    expect(steps).toHaveLength(1);
    expect(steps[0].kind).toBe('error');
    expect(steps[0].label).toContain('ENOENT');
  });

  it('nunca lança e capa o número de passos', () => {
    const many = Array.from({ length: 250 }, (_, i) => `linha ${i}`).join('\n');
    const steps = parseAgentSteps(many);
    expect(steps.length).toBeLessThanOrEqual(100);
  });

  it('JSON inválido misturado cai no fallback sem quebrar', () => {
    const steps = parseAgentSteps('{não é json\noutra linha');
    // Nenhuma linha parseou como evento → fallback de transcript.
    expect(steps.length).toBe(2);
    expect(steps.every((s) => s.kind === 'text')).toBe(true);
  });
});
