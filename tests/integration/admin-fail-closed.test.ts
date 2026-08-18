import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';
import {
  adminFailClosedMiddleware,
  setAdminLoopbackFlag,
} from '../../server/middleware/admin-fail-closed';

describe('adminFailClosedMiddleware', () => {
  let app: Express;

  beforeEach(() => {
    setAdminLoopbackFlag(null);
    app = express();
    app.use(adminFailClosedMiddleware);
    app.get('/api/admin/health', (_req, res) => res.json({ ok: true }));
    app.get('/api/billing/status', (_req, res) => res.json({ ok: true }));
    app.get('/api/governance/policies', (_req, res) => res.json({ ok: true }));
    app.get('/admin/guardrails-logs', (_req, res) => res.json({ ok: true }));
    app.get('/public/ok', (_req, res) => res.json({ ok: true }));
  });

  afterEach(() => {
    delete process.env.ADMIN_API_KEY;
  });

  it('blocks admin routes when loopback flag is still null (pre-listening)', async () => {
    const res = await request(app).get('/api/admin/health');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'ADMIN_API_KEY_REQUIRED' });
  });

  it('allows admin routes on loopback without ADMIN_API_KEY', async () => {
    setAdminLoopbackFlag(true);
    const res = await request(app).get('/api/admin/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('blocks all admin prefixes when non-loopback without key', async () => {
    setAdminLoopbackFlag(false);

    for (const path of [
      '/api/admin/health',
      '/api/billing/status',
      '/api/governance/policies',
      '/admin/guardrails-logs',
    ]) {
      const res = await request(app).get(path);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'ADMIN_API_KEY_REQUIRED' });
    }
  });

  it('allows public routes on non-loopback without key', async () => {
    setAdminLoopbackFlag(false);
    const res = await request(app).get('/public/ok');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('allows admin routes on non-loopback with valid Bearer key', async () => {
    process.env.ADMIN_API_KEY = 'chave-admin-segura-16';
    setAdminLoopbackFlag(false);
    const res = await request(app)
      .get('/api/admin/health')
      .set('Authorization', 'Bearer chave-admin-segura-16');
    expect(res.status).toBe(200);
  });

  it('blocks admin routes on non-loopback with invalid key', async () => {
    process.env.ADMIN_API_KEY = 'chave-admin-segura-16';
    setAdminLoopbackFlag(false);
    const res = await request(app)
      .get('/api/admin/health')
      .set('Authorization', 'Bearer chave-invalida-16-');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'ADMIN_API_KEY_REQUIRED' });
  });
});
