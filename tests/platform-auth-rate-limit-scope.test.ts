import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import platformAuthRouter from '../server/routes/platform-auth-routes';

function createApp() {
  const app = express();
  app.use(platformAuthRouter);
  app.get('/', (_req, res) => res.status(200).send('front'));
  return app;
}

describe('platform auth rate-limit scope', () => {
  it('does not consume the auth limit for frontend requests', async () => {
    const app = createApp();
    const ip = `front-${Date.now()}-${Math.random()}`;

    for (let index = 0; index < 11; index++) {
      await request(app).get('/').set('x-forwarded-for', ip).expect(200, 'front');
    }
  });

  it('continues to limit requests under /api/auth', async () => {
    const app = createApp();
    const ip = `auth-${Date.now()}-${Math.random()}`;

    for (let index = 0; index < 10; index++) {
      await request(app).get('/api/auth/not-a-route').set('x-forwarded-for', ip).expect(404);
    }

    const response = await request(app)
      .get('/api/auth/not-a-route')
      .set('x-forwarded-for', ip)
      .expect(429);

    expect(response.body).toMatchObject({
      error: 'Too Many Requests',
      message: 'Rate limit exceeded: max 10 requests per 60s.',
    });
  });
});
