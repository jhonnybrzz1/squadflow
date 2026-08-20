import type { Express } from 'express';
import { createServer, type Server } from 'http';
import { interactiveWebSocketManager } from '../services/websocket/manager';
import { frameworkManager } from '../frameworks';
import { rateLimitLLM } from '../middleware/rate-limiter';

// Modulos Cognitive / Audit / Legacy
import { cognitiveRoutes } from './cognitive';
import { ragRoutes } from './rag';
import governanceRoutes from './governance-routes';
import llmAuditRoutes from './llm-audit-routes';
import guardrailRoutes from './guardrail-routes';
import safetyRoutes from './safety-routes';
import promptVersionRoutes from './prompt-version-routes';

// Domain Routers
import adminRouter from './admin';
import metricsRouter from './metrics';
import githubRouter from './github';
import demandsRouter from './demands';
import refinementsRouter from './refinements';
import systemRouter from './system';
import errorsRouter from './errors';
import orchestrationRuntimeRouter from './orchestration-runtime';
import modelNamesRouter from './model-names';
import modelsRouter from './models';
import skillsRouter from './skills';
import billingRouter from './billing';
import artifactsRouter from './artifacts';
import retrospectiveRouter from './retrospective-routes';
import agentMemoryRouter from './agent-memory-routes';
import pmFrameworksRouter from './pm-frameworks-routes';
import discoveryHandoffRouter from './discovery-handoff-routes';
import backlogRouter from './backlog-routes';

// Demanda #10358 — camada de plataforma pública (Vibe Coders), aditiva ao
// núcleo administrativo local-first acima (ver constituição v1.1.0).
import vibeWaitlistRouter from './vibe-waitlist';
import platformAuthRouter from './platform-auth-routes';
import vibeRefinementsRouter from './vibe-refinements';
import vibeGitRouter from './vibe-git-routes';
import vibeUsageRouter from './vibe-usage-routes';
import vibeAnalyticsRouter from './vibe-analytics-routes';
import vibePlanRouter from './vibe-plan-routes';
import paddleWebhookRouter from './paddle-webhook';
import vibeDbRouter from './vibe-db-routes';
import vibePreviewRouter from './vibe-preview-routes';

export async function registerRoutes(app: Express): Promise<Server> {
  // Spec 013 (H-01/FR-003): frameworks prontos antes de aceitar tráfego.
  await frameworkManager.initialize();

  // H-3: rate-limit LLM-triggering paths without mounting the middleware globally.
  // This keeps the per-IP sliding window on demand/refinement/agent-job endpoints
  // while letting Vite dev module requests through.
  app.use('/api/demands', rateLimitLLM);
  app.use('/api/refinement', rateLimitLLM);
  app.use('/api/agent-jobs', rateLimitLLM);
  // `app.use('/api/refinement')` casa apenas `/api/refinement` e `/api/refinement/*`;
  // os caminhos abaixo sao irmaos, nao filhos, e ficavam sem teto por IP.
  app.use('/api/refinement-response', rateLimitLLM);
  app.use('/api/refinement-pause', rateLimitLLM);
  app.use('/api/refinement-resume', rateLimitLLM);
  app.use('/api/refinements', rateLimitLLM);

  // Legacy / Original Modularized
  app.use('/api', cognitiveRoutes);
  app.use('/api', ragRoutes);
  app.use('/api/governance', governanceRoutes);
  app.use('/debug', llmAuditRoutes);
  app.use('/admin/guardrails-logs', guardrailRoutes);
  app.use('/api/safety', safetyRoutes);
  app.use('/api/prompts', promptVersionRoutes);

  // Domain Routers
  app.use('/api/admin', adminRouter);
  app.use('/api/billing', billingRouter);
  app.use(metricsRouter);
  app.use(githubRouter);

  // Domain Routers: demand/refinement routes already rate-limited above.
  app.use(demandsRouter);
  app.use(refinementsRouter);

  app.use(artifactsRouter);
  app.use(systemRouter);
  app.use(orchestrationRuntimeRouter);
  app.use(modelNamesRouter);
  app.use(modelsRouter);
  app.use(skillsRouter);
  app.use(retrospectiveRouter);
  app.use(agentMemoryRouter);
  app.use(pmFrameworksRouter);
  app.use(discoveryHandoffRouter);
  app.use(backlogRouter);

  // Demanda #10358 — plataforma pública (Vibe Coders): waitlist, auth,
  // refinamento simplificado, integração Git OAuth, free tier e analytics.
  app.use(vibeWaitlistRouter);
  app.use(platformAuthRouter);
  app.use(vibeRefinementsRouter);
  app.use(vibeGitRouter);
  app.use(vibeUsageRouter);
  app.use(vibeAnalyticsRouter);
  // Demanda #10364 (Fatia 2A) — plano do usuário + webhook Paddle
  app.use(vibePlanRouter);
  app.use(paddleWebhookRouter);
  // Demanda #10365 (Fatia 2B) — conexões de banco do usuário
  app.use(vibeDbRouter);
  // Demanda #10366 (Fatia 2C) — preview automático de refinamento
  app.use(vibePreviewRouter);

  // Client Error Reporting
  app.use(errorsRouter);

  const httpServer = createServer(app);
  interactiveWebSocketManager.attach(httpServer);
  return httpServer;
}
