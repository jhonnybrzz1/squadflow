import { describe, expect, it } from 'vitest';

import { WebSocketOriginPolicy } from '../../server/services/websocket/origin-policy';

describe('WebSocketOriginPolicy', () => {
  it('aceita origem localhost na porta real após setActualPort', () => {
    const policy = new WebSocketOriginPolicy({} as NodeJS.ProcessEnv);
    policy.setActualPort(5000);
    expect(policy.decide('http://localhost:5000')).toBe('accept');
    expect(policy.decide('http://127.0.0.1:5000')).toBe('accept');
  });

  it('rejeita origem ausente', () => {
    const policy = new WebSocketOriginPolicy({} as NodeJS.ProcessEnv);
    policy.setActualPort(5000);
    expect(policy.decide(undefined)).toBe('reject');
    expect(policy.decide('')).toBe('reject');
  });

  it('rejeita origem externa não listada', () => {
    const policy = new WebSocketOriginPolicy({} as NodeJS.ProcessEnv);
    policy.setActualPort(5000);
    expect(policy.decide('https://evil.example')).toBe('reject');
    expect(policy.decide('http://localhost:9999')).toBe('reject');
  });

  it('rejeita tudo enquanto a porta real não foi definida (default vazio)', () => {
    const policy = new WebSocketOriginPolicy({} as NodeJS.ProcessEnv);
    expect(policy.decide('http://localhost:5000')).toBe('reject');
  });

  it('normaliza case e barra final da origem', () => {
    const policy = new WebSocketOriginPolicy({} as NodeJS.ProcessEnv);
    policy.setActualPort(5000);
    expect(policy.decide('HTTP://LOCALHOST:5000/')).toBe('accept');
  });

  it('override por WS_ALLOWED_ORIGINS substitui o default', () => {
    const policy = new WebSocketOriginPolicy({
      WS_ALLOWED_ORIGINS: 'http://localhost:8080, https://painel.local',
    } as NodeJS.ProcessEnv);
    policy.setActualPort(5000);
    expect(policy.decide('http://localhost:8080')).toBe('accept');
    expect(policy.decide('https://painel.local')).toBe('accept');
    expect(policy.decide('http://localhost:5000')).toBe('reject');
  });

  it('descarta entradas inválidas do CSV e mantém as válidas', () => {
    const policy = new WebSocketOriginPolicy({
      WS_ALLOWED_ORIGINS: 'not-a-url, ftp://x, http://localhost:8080',
    } as NodeJS.ProcessEnv);
    expect(policy.decide('http://localhost:8080')).toBe('accept');
    expect(policy.decide('not-a-url')).toBe('reject');
  });

  it('CSV totalmente inválido recai no default seguro', () => {
    const policy = new WebSocketOriginPolicy({
      WS_ALLOWED_ORIGINS: 'garbage, ,also-garbage',
    } as NodeJS.ProcessEnv);
    policy.setActualPort(5000);
    expect(policy.decide('http://localhost:5000')).toBe('accept');
    expect(policy.decide('https://evil.example')).toBe('reject');
  });
});
