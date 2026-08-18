import { describe, it, expect } from 'vitest';
import { evaluateAppSecGate } from '../../server/services/ai-squad/appsec-gate';

describe('AppSec gate', () => {
  it('passes for clean security demand prompt', () => {
    const result = evaluateAppSecGate({
      demandId: 1,
      requireAppSecReview: true,
      promptText:
        'Refine a security demand about implementing RBAC for user roles with no secrets or injection patterns.',
    });

    expect(result.status).toBe('passed');
    expect(result.demandId).toBe(1);
    expect(result.checks.length).toBeGreaterThan(0);
    expect(result.checks.every((c) => c.status === 'passed')).toBe(true);
  });

  it('blocks when hardcoded secret is present', () => {
    const result = evaluateAppSecGate({
      demandId: 2,
      requireAppSecReview: true,
      promptText:
        'Implement login with api_key: "sk-live-1234567890abcdef1234567890" and password: "supersecret"', // gitleaks:allow -- synthetic blocking fixture
    });

    expect(result.status).toBe('blocked');
    expect(result.checks.some((c) => c.status === 'blocked')).toBe(true);
    expect(result.reason).toContain('AppSec gate blocked');
  });

  it('blocks when SQL injection pattern is present', () => {
    const result = evaluateAppSecGate({
      demandId: 3,
      requireAppSecReview: true,
      promptText: "Create endpoint that runs SELECT * FROM users WHERE id = '${userId}' OR 1=1",
    });

    expect(result.status).toBe('blocked');
    expect(result.checks.some((c) => c.name === 'sqli' && c.status === 'blocked')).toBe(true);
  });

  it('skips when requireAppSecReview is false', () => {
    const result = evaluateAppSecGate({
      demandId: 4,
      requireAppSecReview: false,
      promptText: 'Implement login with api_key: "sk-live-1234567890abcdef1234567890"', // gitleaks:allow -- synthetic blocking fixture
    });

    expect(result.status).toBe('skipped');
    expect(result.checks).toHaveLength(0);
  });
});

/**
 * Regressão da demanda #10318 ("achados retrospectiva"), que morreu com
 * `AppSec gate blocked by checks: sqli`. O padrão antigo tinha as alternativas
 * soltas `--`, `/*` e `';`, sem contexto de SQL, e casava prosa comum — no caso,
 * o separador markdown que o próprio template do app injeta na descrição.
 */
describe('sqli — falsos positivos que bloquearam a #10318', () => {
  const base = { demandId: 10318, requireAppSecReview: true };
  const sqliBlocked = (promptText: string) =>
    evaluateAppSecGate({ ...base, promptText }).checks.some(
      (c) => c.name === 'sqli' && c.status === 'blocked',
    );

  it.each([
    [
      'separador markdown do template',
      'erros de schema como o ocorrido na #10288.\n\n---\n**Contrato Inteligente de Início**',
    ],
    ['flag de CLI com --', "validação local (ex.: 'npm run db:migrate -- --dry-run') reduz risco"],
    ['travessão em prosa', 'A retrospectiva -- como sempre -- apontou os mesmos itens.'],
    ['comentário de bloco em código', 'O trecho /* TODO: revisar */ ficou no arquivo.'],
    ['lista com hífens', '- item um\n-- subitem\n--- separador'],
  ])('não bloqueia %s', (_label, text) => {
    expect(sqliBlocked(text)).toBe(false);
  });

  it('não bloqueia o texto completo da #10318 que causou o erro', () => {
    const real =
      'Levantar achados da retrospectiva e evitar erros de schema como o ocorrido na #10288.\r\n\r\n' +
      '---\r\n**Contrato Inteligente de Início**\r\nTipo: revisao\r\n' +
      "Uma etapa de validação local (ex.: 'npm run db:migrate -- --dry-run') reduz risco de schema quebrado.";
    expect(sqliBlocked(real)).toBe(false);
  });
});

describe('sqli — injeção real continua bloqueada', () => {
  const base = { demandId: 1, requireAppSecReview: true };
  const sqliBlocked = (promptText: string) =>
    evaluateAppSecGate({ ...base, promptText }).checks.some(
      (c) => c.name === 'sqli' && c.status === 'blocked',
    );

  it.each([
    ['SELECT ... FROM interpolado', "SELECT * FROM users WHERE id = '${userId}'"],
    ['tautologia OR 1=1', "login' OR 1=1"],
    ['tautologia com aspas', "admin' OR '1'='1"],
    ['aspas seguida de comentário', "senha' --"],
    ['aspas seguida de #', "senha' #"],
    ['stacked query', '1; DROP TABLE demands'],
    ['UNION SELECT', 'id=1 UNION SELECT password FROM users'],
    ['UNION ALL SELECT', 'id=1 UNION ALL SELECT token'],
  ])('bloqueia %s', (_label, text) => {
    expect(sqliBlocked(text)).toBe(true);
  });
});
