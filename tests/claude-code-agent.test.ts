import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ClaudeCodeAgent } from '../server/services/code-agents/code-agent';

let dir: string;
const bin: Record<string, string> = {};

function writeScript(name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'claude-agent-test-'));
  // Lê e descarta o stdin (prompt) e sai 0.
  bin.ok = writeScript('ok.sh', 'cat >/dev/null; echo generated; exit 0');
  // Ecoa os argumentos recebidos (para inspecionar as flags do CLI).
  bin.args = writeScript('args.sh', 'cat >/dev/null; echo "ARGS: $*"; exit 0');
  // Sai com código não-zero.
  bin.fail = writeScript('fail.sh', 'cat >/dev/null; echo "boom" 1>&2; exit 3');
  // Trava — força o timeout do agente.
  bin.hang = writeScript('hang.sh', 'sleep 30');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('Spec 10044 T4 — ClaudeCodeAgent (spawn)', () => {
  const baseReq = {
    demandId: 1,
    speckitPath: 'specs/1-handoff/spec.md',
    prompt: 'implemente isto',
    cwd: process.cwd(),
    timeoutMs: 5000,
  };

  it('sucesso: exit 0 → outcome succeeded, captura stdout', async () => {
    const agent = new ClaudeCodeAgent({ bin: bin.ok });
    const result = await agent.run(baseReq);
    expect(result.outcome).toBe('succeeded');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('generated');
    expect(result.errorMessage).toBeUndefined();
  });

  it('exit não-zero → outcome nonzero_exit com mensagem', async () => {
    const agent = new ClaudeCodeAgent({ bin: bin.fail });
    const result = await agent.run(baseReq);
    expect(result.outcome).toBe('nonzero_exit');
    expect(result.exitCode).toBe(3);
    expect(result.errorMessage).toMatch(/código 3/);
  });

  it('processo travado → outcome timeout, processo é morto (sem zombie)', async () => {
    const agent = new ClaudeCodeAgent({ bin: bin.hang });
    const start = Date.now();
    const result = await agent.run({ ...baseReq, timeoutMs: 300 });
    const elapsed = Date.now() - start;
    expect(result.outcome).toBe('timeout');
    expect(result.errorMessage).toMatch(/timeout/);
    // Resolveu logo após o timeout, não esperou os 30s do sleep. Folga generosa
    // para não falhar sob carga da suíte inteira (event loop saturado).
    expect(elapsed).toBeLessThan(15000);
  }, 20000);

  it('binário ausente → outcome spawn_error (ENOENT), nunca lança', async () => {
    const agent = new ClaudeCodeAgent({ bin: join(dir, 'does-not-exist-xyz') });
    const result = await agent.run(baseReq);
    expect(result.outcome).toBe('spawn_error');
    expect(result.exitCode).toBeNull();
    expect(result.errorMessage).toMatch(/ENOENT|não encontrado/);
  });

  // Spec 10064 Batch 2 — stream-json opt-in.
  describe('AGENT_CLI_STREAM_JSON (opt-in)', () => {
    const prev = process.env.AGENT_CLI_STREAM_JSON;
    afterAll(() => {
      if (prev === undefined) delete process.env.AGENT_CLI_STREAM_JSON;
      else process.env.AGENT_CLI_STREAM_JSON = prev;
    });

    it('default off: não injeta --output-format stream-json', async () => {
      delete process.env.AGENT_CLI_STREAM_JSON;
      const agent = new ClaudeCodeAgent({ bin: bin.args });
      const result = await agent.run(baseReq);
      expect(result.stdout).not.toContain('stream-json');
    });

    it('on: injeta --output-format stream-json --verbose', async () => {
      process.env.AGENT_CLI_STREAM_JSON = 'true';
      const agent = new ClaudeCodeAgent({ bin: bin.args });
      const result = await agent.run(baseReq);
      expect(result.stdout).toContain('--output-format stream-json --verbose');
    });
  });
});
