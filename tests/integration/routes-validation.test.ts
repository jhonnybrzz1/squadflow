import express from 'express';
import request from 'supertest';
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { errorHandler } from '../../server/middleware/error-handler';
import { asyncHandler } from '../../server/middleware/error-handler';

// Configuração mínima do Express para testar os middlewares sem subir o server completo
const app = express();
app.use(express.json());

// Rota simulando o comportamento de POST /api/demands com Zod e asyncHandler
app.post(
  '/api/demands/test-validation',
  asyncHandler(async (req: Request, res: Response) => {
    const schema = z.object({
      title: z.string().min(5),
      description: z.string().min(10),
      type: z.enum(['bug', 'nova_funcionalidade']),
    });

    // Isto irá lançar um ZodError se for inválido, que deve ser capturado pelo asyncHandler
    const payload = schema.parse(req.body);

    res.json({ success: true, payload });
  }),
);

// Rota simulando erro de negócio com AppError
app.post(
  '/api/demands/test-app-error',
  asyncHandler(async (_req: Request, _res: Response) => {
    const { AppError } = await import('../../server/middleware/error-handler');
    throw new AppError('Regra de negócio violada', 422, 'BUSINESS_RULE_VIOLATION');
  }),
);

// Rota simulando erro genérico (500)
app.post(
  '/api/demands/test-generic-error',
  asyncHandler(async (_req: Request, _res: Response) => {
    throw new Error('Erro interno não tratado');
  }),
);

// Adiciona o middleware de erro global no final
app.use(errorHandler);

describe('Rotas - Validação Zod e Error Handler', () => {
  it('Deve retornar 400 (Bad Request) para payload inválido (ZodError)', async () => {
    const response = await request(app).post('/api/demands/test-validation').send({
      title: 'Cur', // inválido: min 5
      description: 'Pequena', // inválido: min 10
      type: 'invalido', // inválido: enum
    });

    expect(response.status).toBe(400);
    expect(response.body).toHaveProperty('errorCode', 'VALIDATION_ERROR');
    expect(response.body.issues).toBeDefined();
    expect(response.body.issues.length).toBeGreaterThan(0);
  });

  it('Deve retornar 200 para payload válido', async () => {
    const response = await request(app).post('/api/demands/test-validation').send({
      title: 'Título válido',
      description: 'Descrição válida que tem mais de 10 caracteres',
      type: 'bug',
    });
    console.log('Body:', response.body);
    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
  });

  it('Deve retornar 422 para erro de negócio (AppError)', async () => {
    const response = await request(app).post('/api/demands/test-app-error').send({});

    expect(response.status).toBe(422);
    expect(response.body).toHaveProperty('errorCode', 'BUSINESS_RULE_VIOLATION');
    expect(response.body).toHaveProperty('message', 'Regra de negócio violada');
  });

  it('Deve retornar 500 sem vazar stack trace no ambiente de produção', async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production'; // Simula produção

    const response = await request(app).post('/api/demands/test-generic-error').send({});

    expect(response.status).toBe(500);
    expect(response.body).toHaveProperty('errorCode', 'INTERNAL_ERROR');
    expect(response.body).toHaveProperty('message', 'Internal Server Error');
    expect(response.body).not.toHaveProperty('stack'); // Não deve vazar stack

    process.env.NODE_ENV = originalEnv; // Restaura environment original
  });
});
