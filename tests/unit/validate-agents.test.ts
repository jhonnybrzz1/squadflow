import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { validateAgents } from '../../scripts/validate-agents';

const validYaml = `version: "1.0.0"
name: Test Agent
description: Test description
model: openai/gpt-4
model_fallback: openai/gpt-3.5
temperature: 0.7
max_tokens: 2000
system_prompt: "You are a test agent."
`;

describe('M-1: validateAgents', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('happy path: YAML válido passa', async () => {
    fs.writeFileSync(path.join(tmpDir, 'test_agent.yaml'), validYaml);
    const errors = await validateAgents(tmpDir);
    expect(errors).toEqual([]);
  });

  it('regressão: todos os YAMLs reais passam', async () => {
    const errors = await validateAgents(path.resolve(process.cwd(), 'agents'));
    expect(errors).toEqual([]);
  });

  it('campo obrigatório ausente gera erro formatado', async () => {
    const badYaml = validYaml.replace(/^name:.*$/m, '');
    fs.writeFileSync(path.join(tmpDir, 'bad.yaml'), badYaml);
    const errors = await validateAgents(tmpDir);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toMatch(/bad\.yaml/);
    expect(errors[0].message).toContain('name');
  });

  it('tipo inválido gera mensagem com esperado vs obtido', async () => {
    const badYaml = validYaml.replace('temperature: 0.7', 'temperature: "0.7"');
    fs.writeFileSync(path.join(tmpDir, 'bad.yaml'), badYaml);
    const errors = await validateAgents(tmpDir);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain('temperature');
    expect(errors[0].message).toContain('esperado');
  });

  it('YAML malformado falha no parser com mensagem clara', async () => {
    const malformed = validYaml + '\n  broken_indent: \n      - ok\n    - bad';
    fs.writeFileSync(path.join(tmpDir, 'malformed.yaml'), malformed);
    const errors = await validateAgents(tmpDir);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain('malformed.yaml');
    expect(errors[0].message).toContain('YAML malformado');
  });

  it('temperatura fora do range é rejeitada', async () => {
    const badYaml = validYaml.replace('temperature: 0.7', 'temperature: 5.0');
    fs.writeFileSync(path.join(tmpDir, 'bad.yaml'), badYaml);
    const errors = await validateAgents(tmpDir);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain('temperature');
  });

  it('max_tokens negativo é rejeitado', async () => {
    const badYaml = validYaml.replace('max_tokens: 2000', 'max_tokens: -100');
    fs.writeFileSync(path.join(tmpDir, 'bad.yaml'), badYaml);
    const errors = await validateAgents(tmpDir);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain('max_tokens');
  });
});
