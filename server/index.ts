import 'dotenv/config';
import express from 'express';
import { registerRoutes } from './routes';
import { setupVite, serveStatic, log } from './vite';
import { errorHandler } from './middleware/error-handler';
import { setupSwagger } from './swagger';
import { logger, traceIdMiddleware } from './utils/logger';
import { securityHeaders } from './middleware/security-headers';
import { register, httpRequestDurationMicroseconds } from './metrics';
import { initializeDocumentWorker } from './workers/document-worker';
import { initializeRetentionWorker } from './workers/retention-worker';
import { modelDiscoveryScheduler } from './services/model-discovery-scheduler';
import { registerOrchestrationRuntimeSubscriber } from './services/orchestration-runtime-subscriber';
import { registerHandoffAutoCommitSubscriber } from './services/handoff-auto-commit-subscriber';
import { registerBacklogActivitySubscriber } from './services/backlog-activity-subscriber';
import { deadLetterService } from './services/dead-letter-service';
import { registerBacklogStepSubscriber } from './services/backlog-step-subscriber';
import { registerSpecMaterializerSubscriber } from './services/spec-materializer-subscriber';
import { registerDocumentGeneratedSubscriber } from './services/document-generated-subscriber';
import { registerDemandAnalysisCompletedSubscriber } from './services/demand-analysis-completed-subscriber';
import { initializeCodeAgentWorker } from './workers/code-agent-worker';
import { registerSpeckitCodeAgentSubscriber } from './services/speckit-code-agent-subscriber';
import { recoverDemandGenerationJobsOnStartup } from './workers/demand-generation-worker';
import { aiResponseCache } from './services/ai-cache';
import { semanticCacheService } from './services/semantic-cache';
import { assertSchemaHealth } from './services/schema-health-check';
import { reportModelConfigAtBoot } from './services/model-config-validation';
import { ensureGovernanceSchema } from './services/governance-schema';
import { ensureIdempotencySchema } from './services/idempotency-schema';
import { ensureDlqSchema } from './services/dlq-schema';
import { validateBackoffConfig } from './services/backoff-validation';
import { validateAdminApiKey } from './utils/admin-api-key';
import { adminFailClosedMiddleware, setAdminLoopbackFlag } from './middleware/admin-fail-closed';
import { isLoopbackAddress } from './utils/loopback';
import { validatePlatformSecret } from './utils/platform-secrets';

const app = express();

// Demanda 10217: o gate de startup foi transformado em log educativo.
// A proteção real é o middleware fail-closed, que detecta bind não-loopback
// e exige ADMIN_API_KEY nas rotas administrativas.
const adminApiKeyCheck = validateAdminApiKey(process.env.ADMIN_API_KEY);
if (!adminApiKeyCheck.ok) {
  logger.warn(
    'ADMIN_API_KEY não configurada ou inválida. Rotas administrativas ficarão protegidas por fail-closed quando bind não-loopback.',
    {
      context: { reason: adminApiKeyCheck.reason },
    },
  );
}

// Demanda #10358: mesmo padrão de log educativo (não fatal) para os segredos
// da plataforma pública — as rotas de auth/git falham fail-closed por
// requisição via server/utils/platform-secrets.ts quando ausentes/inválidos.
for (const envVar of ['JWT_SECRET', 'GIT_TOKEN_SECRET'] as const) {
  const check = validatePlatformSecret(process.env[envVar]);
  if (!check.ok) {
    logger.warn(
      `${envVar} não configurado ou inválido. Rotas da plataforma pública (auth/git) retornarão erro até que seja configurado.`,
      { context: { reason: check.reason } },
    );
  }
}

// H-4: security headers must be set before any response is sent, including
// the logging middleware below which runs on 'finish'.
app.use(securityHeaders);
app.use(traceIdMiddleware);
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;

  // H-6: response body logging is opt-in via LOG_RESPONSE_BODY=true. Default
  // is off — logging response bodies to console leaks sensitive data (demand
  // descriptions, user info, tokens, error details) into logs that may be
  // persisted or shipped to log aggregators.
  const shouldLogBody = process.env.LOG_RESPONSE_BODY === 'true';
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  if (shouldLogBody) {
    const originalResJson = res.json;
    res.json = function (bodyJson, ...args) {
      capturedJsonResponse = bodyJson;
      return originalResJson.apply(res, [bodyJson, ...args]);
    };
  }

  res.on('finish', () => {
    const duration = Date.now() - start;

    // Track Prometheus metrics for all routes
    httpRequestDurationMicroseconds
      .labels(req.method, req.route ? req.route.path : path, res.statusCode.toString())
      .observe(duration / 1000);

    if (path.startsWith('/api')) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (shouldLogBody && capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      if (logLine.length > 80) {
        logLine = logLine.slice(0, 79) + '…';
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  // Spec 028 (T2): reporta env vars de modelo fora da allowlist (não derruba o boot).
  reportModelConfigAtBoot();

  // Bug 10270: garantir tabelas DLQ e agent_failures no SQLite antes do health check e do cleanup M-2.
  // (PostgreSQL continua migration-managed.)
  await ensureGovernanceSchema();
  await ensureIdempotencySchema();
  await ensureDlqSchema();
  // Demanda #10358/#10364/#10365/#10366/#10367: garantir tabelas da plataforma
  // pública (platform_users, git_connections, subscriptions, db_connections,
  // preview_cache, preview_jobs, etc.) antes do health check — senão o
  // SchemaHealthCheck reporta drift transitório de tabelas ainda não criadas.
  const { ensureVibePlatformSchema } = await import('./services/vibe-platform-schema');
  await ensureVibePlatformSchema();

  // Verificar integridade do schema após ensure de tabelas críticas.
  await assertSchemaHealth();

  // A-2: validar configuração de backoff dos workers no boot.
  validateBackoffConfig();

  // M-2: cleanup de dead letters >30 dias no boot, antes de qualquer subscriber.
  try {
    const removed = await deadLetterService.cleanupOlderThan(30);
    logger.info('M-2: cleanup de dead letters executado', { context: { removed } });
  } catch (error) {
    logger.error('M-2: falha no cleanup de dead letters', {
      error: error instanceof Error ? error : undefined,
    });
  }

  // Inicializar workers event-driven
  initializeDocumentWorker();
  initializeRetentionWorker();
  registerOrchestrationRuntimeSubscriber();
  registerHandoffAutoCommitSubscriber();
  registerBacklogActivitySubscriber(); // Demanda 10096
  registerBacklogStepSubscriber(); // 10096 — steps atualizados após handoff
  registerSpecMaterializerSubscriber(); // FEAT-20260724-001
  registerDocumentGeneratedSubscriber();
  registerDemandAnalysisCompletedSubscriber();
  // Spec 10044: pipeline do agente de código (dormente até AGENT_AUTORUN_ENABLED=true).
  initializeCodeAgentWorker();
  registerSpeckitCodeAgentSubscriber();
  void recoverDemandGenerationJobsOnStartup().catch((error) =>
    log(
      `demand generation jobs recovery failed: ${error instanceof Error ? error.message : 'unknown'}`,
      'startup',
    ),
  );

  // Spec 015 B3 (H-11): nenhum run/turn fica `running` para sempre após crash;
  // shutdown gracioso drena as escritas pendentes da trilha com timeout.
  void (async () => {
    try {
      const { orchestrationRuntimeService: orchestrationRuntime } =
        await import('./services/orchestration-runtime');
      await orchestrationRuntime.reconcileStaleRuns();

      const gracefulShutdown = async (signal: string) => {
        const timeout = new Promise<'timeout'>((resolve) =>
          setTimeout(() => resolve('timeout'), 5000),
        );
        const result = await Promise.race([
          orchestrationRuntime.flush().then(() => 'flushed' as const),
          timeout,
        ]);
        if (result === 'timeout') {
          log(
            `shutdown (${signal}): flush da trilha de orquestração estourou 5s — possível perda registrada`,
            'shutdown',
          );
        }
        process.exit(0);
      };
      process.once('SIGINT', () => void gracefulShutdown('SIGINT'));
      process.once('SIGTERM', () => void gracefulShutdown('SIGTERM'));
    } catch (error) {
      log(
        `orchestration reconcile failed: ${error instanceof Error ? error.message : 'unknown'}`,
        'startup',
      );
    }
  })();

  // Spec 015 B2 (H-10/FR-007): retomar jobs de PDF que sobreviveram a um
  // crash/restart — o conteúdo é recarregado do versionamento durável.
  void (async () => {
    try {
      const { documentJobsService } = await import('./services/document-jobs');
      const { documentVersioningService } = await import('./services/document-versioning');
      const { eventBus } = await import('./events/event-bus');
      const pending = await documentJobsService.recoverOnStartup();
      for (const job of pending) {
        const docType = job.docType.toLowerCase() as 'prd' | 'tasks' | 'tdd';
        const loaded = await documentVersioningService.load(job.demandId, docType).catch((err) => {
          // CRIT-18: log em vez de engolir silenciosamente.
          logger.warn('Failed to load document on startup recovery', {
            error: err instanceof Error ? err : undefined,
            context: { demandId: job.demandId, docType, jobId: job.jobId },
          });
          return null;
        });
        if (!loaded?.content) {
          await documentJobsService.markFailed(job.jobId, 'content_unavailable_after_restart');
          continue;
        }
        eventBus.publish('DOCUMENT_GENERATION_REQUESTED', {
          demandId: job.demandId,
          type: job.docType,
          content: loaded.content,
          targetFilepath: job.targetFilepath,
          jobId: job.jobId,
        });
      }
    } catch (error) {
      log(
        `document jobs recovery failed: ${error instanceof Error ? error.message : 'unknown'}`,
        'startup',
      );
    }
  })();

  // Spec 10148: retomar jobs do agent_jobs que ficaram `running` órfãos
  // após crash/restart — registrado após document-jobs para manter ordem.
  void (async () => {
    try {
      const { agentJobsService } = await import('./services/agent-jobs');
      const pending = await agentJobsService.recoverOnStartup();
      if (pending.length > 0) log(`recovered ${pending.length} agent job(s)`, 'startup');
    } catch (error) {
      log(
        `agent jobs recovery failed: ${error instanceof Error ? error.message : 'unknown'}`,
        'startup',
      );
    }
  })();

  // Bug 3: retomar jobs do agente de código que ficaram `pending`/`processing`
  // no SQLite após um restart — a fila durável é a fonte da verdade.
  void (async () => {
    try {
      const { recoverCodeAgentJobsOnStartup } = await import('./workers/code-agent-worker');
      const count = await recoverCodeAgentJobsOnStartup();
      if (count > 0) log(`recovered ${count} code agent job(s)`, 'startup');
      // Spec 10114: após recovery, marcar como failed jobs `processing` sem
      // heartbeat recente (timeout/heartbeat independente de restart).
      const { codeAgentJobQueueService } = await import('./services/code-agent-job-queue');
      const timedOut = await codeAgentJobQueueService.timeoutStaleProcessingJobs();
      if (timedOut.length > 0)
        log(`timed out ${timedOut.length} stale code agent job(s)`, 'startup');
    } catch (error) {
      log(
        `code agent jobs recovery failed: ${error instanceof Error ? error.message : 'unknown'}`,
        'startup',
      );
    }
  })();

  // Start the model discovery scheduler (seed + periodic catalog fetch).
  // MR-06: Discovery is opt-IN. It only starts when explicitly enabled via
  // MODEL_DISCOVERY_ENABLED=true. This is the safer default for a
  // single-user/local app — discovery hits external APIs on a schedule and
  // should not run without the user's knowledge.
  if (process.env.MODEL_DISCOVERY_ENABLED === 'true') {
    modelDiscoveryScheduler.start();
  }

  // Initialise distributed cache backing stores (Redis when REDIS_URL is set)
  await aiResponseCache.initBackingStore();
  await semanticCacheService.initBackingStore();

  // Expose Prometheus metrics endpoint
  app.get('/metrics', async (req, res) => {
    try {
      res.set('Content-Type', register.contentType);
      res.end(await register.metrics());
    } catch (ex) {
      res.status(500).end(ex);
    }
  });

  setupSwagger(app);

  // Demanda 10217: middleware fail-closed deve ser registrado antes das rotas
  // administrativas para interceptá-las corretamente.
  app.use(adminFailClosedMiddleware);

  const server = await registerRoutes(app);

  // BUG FIX (reformulação 502): evita que o Node feche conexões longas antes
  // de proxies com timeout fixo (nginx/ALB). A camada de aplicação ainda
  // impõe o próprio teto em REFORMULATION_TIMEOUT_MS (55s).
  server.timeout = 120_000;
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 120_000;

  // Centralized error handling middleware (Fase 1 - Item 1.1)
  app.use(errorHandler);

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (app.get('env') === 'development') {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  // Use the PORT environment variable if specified, otherwise let the system assign any available port
  const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 0;
  // Local/dev must not expose the always-admin auth stub to the network.
  // Managed production platforms may still bind publicly behind their proxy.
  const host =
    process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
  // Spec 011 (R-01/US2-AS3): ampliar a superfície de rede é OPT-IN explícito.
  // O perfil local vincula a 127.0.0.1; bind não-local só via HOST/NODE_ENV
  // deliberados — e fica registrado de forma visível.
  if (host !== '127.0.0.1' && host !== 'localhost') {
    log(
      `⚠️  bind NÃO-LOCAL (${host}) — perfil local usa 127.0.0.1; isto expõe o auth-stub sempre-admin à rede. Prossiga apenas se for intencional (HOST/NODE_ENV explícitos).`,
      'security',
    );
  }
  server.listen(port, host, () => {
    // Get the actual port after listening in case it was assigned dynamically
    const address = server.address();
    let boundAddress = '';
    const actualPort = typeof address === 'string' ? address : address?.port;
    if (address && typeof address !== 'string') {
      boundAddress = address.address;
      // Demanda 10217: detectar loopback real no bind para fail-closed.
      setAdminLoopbackFlag(isLoopbackAddress(boundAddress));
    }
    if (typeof actualPort === 'number') {
      // Spec 012 (H-05): allowlist de Origin do WebSocket usa a porta real.
      void import('./services/websocket/origin-policy').then(({ webSocketOriginPolicy }) => {
        webSocketOriginPolicy.setActualPort(actualPort);
      });
    }
    log(`serving on http://${host}:${actualPort} (bound ${boundAddress || 'unknown'})`);
  });
})();
