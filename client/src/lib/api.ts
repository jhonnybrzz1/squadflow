import { safeWindowOpen } from './safe-window-open';
import { apiRequest } from './queryClient';
import { apiErrorFromResponse } from './api-error';
import { type Demand, type InsertDemand, type ChatMessage } from '@shared/schema';
import type { SkillsLockfileResponse } from '@shared/skills-lock';
import type { BalanceResponse } from '@shared/billing-balance';
import type { DemandListItem, RestSafeDemand } from '@shared/demand-list';
import type { ReformulationResult, ReformulateRequest } from '@shared/reformulation';
import type { RetentionJobLogDto } from '@shared/retention';
import type {
  RetrospectiveSessionDto,
  RetroSnapshotDto,
  RetroActionDto,
  CreateRetroActionDto,
  UpdateRetroActionDto,
} from '@shared/retrospective';

// ── Tipos de API administrativa ──

interface ApiErrorWithStatus extends Error {
  status?: number;
}

interface AdminDashboard {
  aiUsage: {
    estimatedCostUsd: number;
    byModel: Record<string, { totalTokens: number }>;
    totalTokens: number;
    requestCount: number;
  };
  system: Record<string, unknown>;
  rag: {
    avgPrecision: number;
    avgRecall: number;
    f1Score: number;
    avgContextRelevance: number;
    avgLatencyMs?: number;
  } | null;
  rerank: Record<string, unknown> | null;
  demands: {
    total: number;
    completed: number;
    processing: number;
    error: number;
  };
  governance: {
    reviewAdoptionRate: number;
    approvedCount: number;
    finalizedCount: number;
    avgComments: number;
  };
  validation: {
    invalidFilesBlocked: number;
    totalFilesValidated: number;
  };
  timestamp: string;
}

interface AdminCosts {
  summary: {
    totalCostUsd: number;
    totalRequests: number;
    totalTokens: number;
    avgCostPerRequest: number;
    costSavedUsd: number;
  };
  costByModel: Array<{
    model: string;
    requestCount: number;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    estimatedCostUsd: number;
    avgCostPerRequest: number;
  }>;
  timeline: Array<{ bucket: string; cost: number; requests: number }>;
  cacheSavings: {
    exactHits: number;
    semanticCacheStats: Record<string, unknown>;
    tokensSaved: number;
    costSavedUsd: number;
    cacheHitRate: number;
  };
  routingEfficiency: {
    economicRequests: number;
    safeRequests: number;
    fallbackRate: number;
    economicRatio: number;
  };
  timestamp: string;
}

interface AdminTracingStats {
  tracing: {
    activeSpans: number;
    completedSpans: number;
    errorRate: number;
    avgDurationMs: number;
    traceCount: number;
  };
  exporter: { totalExported: number };
  sampling: { effectiveSampleRate: number };
  timestamp: string;
}

interface AdminCacheStats {
  exactCache: {
    size: number;
    hitRate: number;
    totalHits: number;
    totalMisses: number;
  };
  semanticCache: {
    size: number;
    hitRate: number;
    similarityThreshold: number;
    totalEmbeddingFailures: number;
  };
  timestamp: string;
}

interface AdminTracingSpan {
  id: string;
  operation: string;
  model?: string;
  agentName?: string;
  status: string;
  startTime: string;
  endTime?: string;
  durationMs?: number;
}

interface RetentionPolicy {
  id: number;
  dataType: string;
  ttlDays: number;
  action: string;
  isActive: boolean;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RetentionSimulateAllResult {
  simulations: Array<{
    dataType: string;
    ttlDays: number;
    affectedRows: number;
    cutoffDate: string;
  }>;
  dbMetrics: {
    totalSizeBytes: number;
    tableCount: number;
  };
}

interface RetentionCleanupResult {
  success: boolean;
  result: {
    startedAt: string;
    completedAt: string;
    durationMs: number;
    dbSizeBeforeMb: number;
    dbSizeAfterMb: number;
    sizeReductionMb: number;
    policiesProcessed: number;
    totalRowsDeleted: number;
    results: Record<string, unknown>;
    errors: string[];
  };
}

interface RetentionSchedulerStatus {
  schedulerRunning: boolean;
  jobRunning: boolean;
  enabled: boolean;
  intervalHours: number;
}

interface GithubRepo {
  id: number;
  name: string;
  fullName: string;
  owner: { login: string } | null;
  description: string | null;
  url: string;
  isPrivate: boolean;
  stars: number;
  language: string | null;
  updatedAt: string;
}

type RepoContent =
  | { type: 'file'; name: string; path: string; content: string; sha: string }
  | { type: 'dir'; name: string; path: string; entries: RepoContent[] }
  | { type: 'unknown'; name: string; path: string };

interface FeatureFlag {
  key: string;
  label: string;
  description: string;
  enabled: boolean;
  overridden: boolean;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Eventos SSE da mesa redonda registrados no EventSource (spec 014 S3 / M-01).
 * Todo tipo ativo do protocolo do servidor precisa constar aqui (SC-004) —
 * inclusive `roundtable_agent_token`, que transmite chunks de streaming.
 */
export const SSE_ROUNDTABLE_EVENTS = [
  'roundtable_round_start',
  'roundtable_agent_start',
  'roundtable_agent_token',
  'roundtable_agent_message',
  'roundtable_agent_done',
  'roundtable_divergence',
  'roundtable_complete',
  'agent_failed',
  // Demanda 10081 parte B: agente acionado no meio do refinamento (atrás de
  // enableDynamicAgentEscalation).
  'roundtable_agent_joined',
] as const;

async function fetchJsonWithTimeout<T>(url: string, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      credentials: 'include',
      cache: 'no-store',
      signal: controller.signal,
    });

    if (!response.ok) {
      throw await apiErrorFromResponse(response);
    }

    return response.json();
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(`timeout after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function shouldRetryGitHubRepos(error: unknown): boolean {
  const status = error instanceof Error ? (error as ApiErrorWithStatus).status : undefined;
  if (typeof status === 'number') return status >= 500;
  return error instanceof Error && /timeout|network|failed to fetch/i.test(error.message);
}

async function fetchGitHubReposWithRetry<T>(): Promise<T> {
  const delays = [400, 1000];
  let lastError: unknown;

  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    try {
      return await fetchJsonWithTimeout<T>('/api/github/repos', 8000);
    } catch (error) {
      lastError = error;
      if (!shouldRetryGitHubRepos(error) || attempt === delays.length) break;
      await sleep(delays[attempt]);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Failed to fetch GitHub repos');
}

// ── Tipos do backlog de atividades (10096) ──

export interface BacklogActivity {
  id: string;
  demandId: number;
  title: string;
  status: 'em_desenvolvimento' | 'aguardando_revisao' | 'pronto' | 'em_producao';
  hasPrd: boolean;
  hasTasks: boolean;
  hasChat: boolean;
  createdAt: string;
  updatedAt: string;
}

export const api = {
  billing: {
    getBalance: async (): Promise<BalanceResponse> => {
      const response = await apiRequest('GET', '/api/billing/balance');
      return response.json();
    },
  },
  backlog: {
    list: async (): Promise<{ activities: BacklogActivity[] }> => {
      const response = await apiRequest('GET', '/api/backlog/activities');
      return response.json();
    },
    transition: async (id: string, status: BacklogActivity['status']): Promise<BacklogActivity> => {
      const response = await apiRequest('PATCH', `/api/backlog/activities/${id}`, { status });
      return response.json();
    },
  },
  demands: {
    // Spec 014 S4 (M-03): a listagem retorna a projeção real, não a entidade.
    getAll: async (): Promise<DemandListItem[]> => {
      const response = await apiRequest('GET', '/api/demands');
      return response.json();
    },

    get: async (id: number): Promise<RestSafeDemand> => {
      const response = await apiRequest('GET', `/api/demands/${id}`);
      return response.json();
    },

    create: async (
      demand: InsertDemand,
      files?: FileList,
      githubRepoOwner?: string,
      githubRepoName?: string,
    ): Promise<Demand> => {
      const formData = new FormData();

      // Add demand data
      Object.entries(demand).forEach(([key, value]) => {
        if (value === undefined || value === null) return;
        if (typeof value === 'boolean' || typeof value === 'number') {
          formData.append(key, String(value));
        } else if (typeof value === 'string') {
          formData.append(key, value);
        } else {
          formData.append(key, JSON.stringify(value));
        }
      });

      // Add GitHub repository information if provided
      if (githubRepoOwner && githubRepoName) {
        formData.append('githubRepoOwner', githubRepoOwner);
        formData.append('githubRepoName', githubRepoName);
      }

      // Add files if any
      if (files) {
        Array.from(files).forEach((file) => {
          formData.append('files', file);
        });
      }

      const response = await fetch('/api/demands', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        throw await apiErrorFromResponse(response);
      }

      return response.json();
    },
    createWithFormData: async (formData: FormData): Promise<Demand> => {
      const response = await fetch('/api/demands', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        throw await apiErrorFromResponse(response);
      }

      return response.json();
    },

    getMessages: async (id: number): Promise<ChatMessage[]> => {
      const response = await apiRequest('GET', `/api/demands/${id}/messages`);
      return response.json();
    },

    clearHistory: async (): Promise<{ success: boolean; deleted: number }> => {
      const response = await apiRequest('DELETE', '/api/demands/history');
      return response.json();
    },

    // Spec 10013 (FR-004): exclusão individual de uma demanda.
    deleteById: async (id: number): Promise<{ success: boolean; demandId: number }> => {
      const response = await apiRequest('DELETE', `/api/demands/${id}`);
      return response.json();
    },

    // Spec 10020 US1/US2 + 10028: reformula um rascunho em descrição profissional +
    // contratos, consultando o RAG do repositório e preenchendo título/contractFields.
    reformulate: async (
      input: ReformulateRequest,
      signal?: AbortSignal,
    ): Promise<ReformulationResult> => {
      const response = await apiRequest('POST', '/api/demands/reformulate', input, { signal });
      return response.json();
    },

    submitInteraction: async (
      demandId: number,
      interactionId: string,
      answer: string,
      sequence?: number,
    ): Promise<{ success: boolean }> => {
      // H-16: server expects `response` (not `answer`) and a required
      // `sequence` field. The old payload sent `answer` and omitted
      // `sequence`, causing every call to fail Zod validation with 400.
      const response = await apiRequest('POST', '/api/refinement-response', {
        refinementId: String(demandId),
        interactionId,
        sequence: sequence ?? 0,
        response: answer,
      });
      return response.json();
    },

    subscribeToUpdates: (
      id: number,
      onUpdate: (demand: DemandListItem) => void,
      options?: {
        onAgentChunk?: (agent: string, chunk: string) => void;
        onAgentStreamEnd?: (agent: string) => void;
        /**
         * Delay (ms) before closing the SSE connection after a terminal
         * status arrives. Prevents loss of in-flight `agent_chunk` /
         * `agent_stream_end` events when the backend transitions the
         * demand to completed/error/stopped while a streaming agent is
         * still flushing its tail tokens.
         */
        terminalCloseDelayMs?: number;
        onInputRequired?: (question: string, interactionId: string, agent?: string) => void;
        onAgentReasoningChunk?: (agent: string, chunk: string) => void;
        onAnyEvent?: (type: string, data: Record<string, unknown>) => void;
        onError?: (error: Event) => void;
        signal?: AbortSignal;
      },
    ) => {
      const eventSource = new EventSource(`/api/demands/${id}/events`);
      const TERMINAL_CLOSE_DELAY_MS = options?.terminalCloseDelayMs ?? 1500;
      let closeTimer: ReturnType<typeof setTimeout> | null = null;
      let closed = false;

      const closeSafely = () => {
        if (closed) return;
        closed = true;
        if (closeTimer) {
          clearTimeout(closeTimer);
          closeTimer = null;
        }
        eventSource.close();
      };

      const scheduleTerminalClose = () => {
        if (closed || closeTimer) return;
        closeTimer = setTimeout(closeSafely, TERMINAL_CLOSE_DELAY_MS);
      };

      if (options?.signal) {
        options.signal.addEventListener('abort', closeSafely, { once: true });
      }

      const handleDemandEvent = (event: MessageEvent) => {
        try {
          const payload = JSON.parse(event.data);
          const demand = payload?.data?.demand ?? payload?.demand ?? payload;

          if (event.type === 'input_required' && options?.onInputRequired) {
            const question =
              payload?.data?.question ?? payload?.question ?? 'Agente precisa de sua interação.';
            const interactionId =
              payload?.data?.interactionId ?? payload?.interactionId ?? `inter-${Date.now()}`;
            const agent = payload?.data?.agent_id ?? payload?.agent_id;
            options.onInputRequired(question, interactionId, agent);
          }

          if (demand && typeof demand.id === 'number') {
            onUpdate(demand);
          }
        } catch (e) {
          console.warn('[SSE] Failed to parse demand event data:', event.data, e);
        }
      };

      eventSource.onmessage = handleDemandEvent;
      eventSource.addEventListener('progress', (event: MessageEvent) => {
        handleDemandEvent(event);

        // Auto-close when the demand reaches a terminal state, but defer
        // the actual close so any agent_chunk / agent_stream_end events
        // still in flight have time to arrive.
        try {
          const payload = JSON.parse(event.data);
          const demand = payload?.data?.demand ?? payload?.demand ?? payload;
          // H-17: 'validation_failed' is a terminal status (defined in
          // shared/demand-status.ts and set by agent-orchestrator.ts) but
          // was missing from this list — the SSE stream stayed open
          // forever when validation failed, leaking the connection.
          if (
            demand &&
            ['completed', 'error', 'stopped', 'validation_failed'].includes(demand.status)
          ) {
            scheduleTerminalClose();
          }
        } catch (_) {
          // Ignore parse errors
        }
      });

      // Pass generic events
      if (options?.onAnyEvent) {
        SSE_ROUNDTABLE_EVENTS.forEach((eventType) => {
          eventSource.addEventListener(eventType, (event: MessageEvent) => {
            try {
              const payload = JSON.parse(event.data);
              const data = payload?.data ?? payload;
              options.onAnyEvent!(eventType, data);
            } catch (_) {
              // Ignore parse errors
            }
          });
        });
      }

      // Streaming: listen for agent_chunk events
      if (options?.onAgentChunk) {
        eventSource.addEventListener('agent_chunk', (event: MessageEvent) => {
          try {
            const payload = JSON.parse(event.data);
            const agent = payload?.data?.agent ?? payload?.agent;
            const chunk = payload?.data?.chunk ?? payload?.chunk;
            if (agent && chunk) {
              options.onAgentChunk!(agent, chunk);
            } else {
              console.warn('[SSE] Invalid agent_chunk payload received:', payload);
            }
          } catch (_) {
            console.warn('[SSE] Failed to parse agent_chunk event data:', event.data);
          }
        });
      }

      // Streaming: listen for agent_reasoning_chunk events
      if (options?.onAgentReasoningChunk) {
        eventSource.addEventListener('agent_reasoning_chunk', (event: MessageEvent) => {
          try {
            const payload = JSON.parse(event.data);
            const agent = payload?.data?.agent ?? payload?.agent;
            const chunk = payload?.data?.chunk ?? payload?.chunk;
            if (agent && chunk) {
              options.onAgentReasoningChunk!(agent, chunk);
            }
          } catch (_) {
            // Ignore parse errors
          }
        });
      }

      if (options?.onAgentStreamEnd) {
        eventSource.addEventListener('agent_stream_end', (event: MessageEvent) => {
          try {
            const payload = JSON.parse(event.data);
            const agent = payload?.data?.agent ?? payload?.agent;
            if (agent) {
              options.onAgentStreamEnd!(agent);
            }
          } catch (_) {
            // Ignore parse errors
          }
        });
      }

      if (options?.onInputRequired) {
        eventSource.addEventListener('input_required', (event: MessageEvent) => {
          try {
            const payload = JSON.parse(event.data);
            const metadata = payload?.metadata ?? payload?.data?.metadata;
            const question = typeof metadata?.question === 'string' ? metadata.question : undefined;
            const interactionId =
              typeof metadata?.interactionId === 'string' ? metadata.interactionId : undefined;
            if (question && interactionId) {
              options.onInputRequired!(question, interactionId);
            }
          } catch (_) {
            // Ignore parse errors
          }
        });
      }

      eventSource.onerror = (error) => {
        console.error('SSE error:', error);
        options?.onError?.(error);
      };

      return closeSafely;
    },
  },

  documents: {
    download: (filename: string) => {
      safeWindowOpen(`/api/documents/${filename}`);
    },
    list: async (
      demandId: number,
      prefix: 'PRD' | 'Tasks',
    ): Promise<{ documents: { filename: string; createdAt: string; size: number }[] }> => {
      const response = await apiRequest(
        'GET',
        `/api/documents?demandId=${demandId}&prefix=${prefix}`,
      );
      return response.json();
    },
    getContent: async (filename: string): Promise<string> => {
      const response = await fetch(`/api/documents/${filename}`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return response.text();
    },
    update: async (
      demandId: number,
      type: string,
      content: string,
    ): Promise<{ success: boolean }> => {
      const response = await apiRequest('POST', `/api/demands/${demandId}/documents/${type}`, {
        content,
      });
      return response.json();
    },
  },

  admin: {
    getDashboard: async (): Promise<AdminDashboard> => {
      const response = await apiRequest('GET', '/api/admin/dashboard');
      return response.json();
    },
    getCosts: async (): Promise<AdminCosts> => {
      const response = await apiRequest('GET', '/api/admin/costs');
      return response.json();
    },
    getTracingStats: async (): Promise<AdminTracingStats> => {
      const response = await apiRequest('GET', '/api/admin/tracing/stats');
      return response.json();
    },
    getTracingSpans: async (params?: {
      limit?: number;
      operation?: string;
    }): Promise<{ spans: AdminTracingSpan[]; count: number }> => {
      const query = new URLSearchParams();
      if (params?.limit) query.set('limit', String(params.limit));
      if (params?.operation) query.set('operation', params.operation);
      const response = await apiRequest('GET', `/api/admin/tracing/spans?${query}`);
      return response.json();
    },
    getCacheStats: async (): Promise<AdminCacheStats> => {
      const response = await apiRequest('GET', '/api/admin/cache/stats');
      return response.json();
    },

    // Feature flags (toggles operacionais via UI admin)
    featureFlags: {
      list: async (): Promise<{ flags: FeatureFlag[] }> => {
        const response = await apiRequest('GET', '/api/admin/feature-flags');
        return response.json();
      },
      set: async (key: string, enabled: boolean): Promise<FeatureFlag> => {
        const response = await apiRequest('PUT', `/api/admin/feature-flags/${key}`, { enabled });
        return response.json();
      },
    },

    // Retention Policy Admin APIs
    retention: {
      getPolicies: async (): Promise<{
        policies: RetentionPolicy[];
        // H-23: API returns { value, label } objects, not bare strings.
        availableDataTypes: Array<{ value: string; label: string }>;
      }> => {
        const response = await apiRequest('GET', '/api/admin/retention-policies');
        return response.json();
      },
      getPolicy: async (id: number): Promise<RetentionPolicy> => {
        const response = await apiRequest('GET', `/api/admin/retention-policies/${id}`);
        return response.json();
      },
      createPolicy: async (policy: {
        dataType: string;
        ttlDays: number;
        action: string;
        isActive?: boolean;
        description?: string;
      }): Promise<RetentionPolicy> => {
        const response = await apiRequest('POST', '/api/admin/retention-policies', policy);
        return response.json();
      },
      updatePolicy: async (
        id: number,
        policy: {
          ttlDays?: number;
          action?: string;
          isActive?: boolean;
          description?: string;
        },
      ): Promise<RetentionPolicy> => {
        const response = await apiRequest('PUT', `/api/admin/retention-policies/${id}`, policy);
        return response.json();
      },
      deletePolicy: async (id: number): Promise<void> => {
        await apiRequest('DELETE', `/api/admin/retention-policies/${id}`);
      },
      simulateImpact: async (
        dataType: string,
        ttlDays: number,
      ): Promise<{
        dataType: string;
        ttlDays: number;
        affectedRows: number;
        cutoffDate: string;
      }> => {
        const response = await apiRequest('POST', '/api/admin/retention-policies/simulate', {
          dataType,
          ttlDays,
        });
        return response.json();
      },
      simulateAll: async (): Promise<RetentionSimulateAllResult> => {
        const response = await apiRequest('GET', '/api/admin/retention-policies/simulate-all');
        return response.json();
      },
      getLogs: async (limit?: number): Promise<{ logs: RetentionJobLogDto[] }> => {
        const query = limit ? `?limit=${limit}` : '';
        const response = await apiRequest('GET', `/api/admin/retention-policies/logs${query}`);
        return response.json();
      },
      getDbMetrics: async (): Promise<{ totalSizeBytes: number; tableCount: number }> => {
        const response = await apiRequest('GET', '/api/admin/retention-policies/db-metrics');
        return response.json();
      },
      runCleanup: async (): Promise<RetentionCleanupResult> => {
        const response = await apiRequest('POST', '/api/admin/retention-policies/run-cleanup');
        return response.json();
      },
      getSchedulerStatus: async (): Promise<RetentionSchedulerStatus> => {
        const response = await apiRequest('GET', '/api/admin/retention-policies/scheduler-status');
        return response.json();
      },
      setSchedulerInterval: async (intervalHours: number): Promise<RetentionSchedulerStatus> => {
        const response = await apiRequest('POST', '/api/admin/retention-policies/scheduler/start', {
          intervalHours,
        });
        return response.json();
      },
    },
  },

  // Demanda 10078: módulo de retrospectiva automatizada
  retrospective: {
    start: async (periodStart: string, periodEnd: string): Promise<{ id: string }> => {
      const response = await apiRequest('POST', '/api/retrospective', { periodStart, periodEnd });
      return response.json();
    },
    get: async (id: string): Promise<RetrospectiveSessionDto> => {
      const response = await apiRequest('GET', `/api/retrospective/${id}`);
      return response.json();
    },
    list: async (): Promise<{ sessions: RetrospectiveSessionDto[] }> => {
      const response = await apiRequest('GET', '/api/retrospective');
      return response.json();
    },
    pause: async (id: string): Promise<{ ok: boolean }> => {
      const response = await apiRequest('PATCH', `/api/retrospective/${id}/pause`);
      return response.json();
    },
    resume: async (id: string): Promise<{ ok: boolean }> => {
      const response = await apiRequest('PATCH', `/api/retrospective/${id}/resume`);
      return response.json();
    },
    cancel: async (id: string): Promise<{ ok: boolean }> => {
      const response = await apiRequest('DELETE', `/api/retrospective/${id}`);
      return response.json();
    },
    // Demanda 10195: snapshot de evidência + plano de ações mensuráveis.
    generateSnapshot: async (
      periodStart: string,
      periodEnd: string,
    ): Promise<{ id: string; snapshot: RetroSnapshotDto; actions: RetroActionDto[] }> => {
      const response = await apiRequest('POST', '/api/retrospective/generate', {
        periodStart,
        periodEnd,
      });
      return response.json();
    },
    listActions: async (retroId: string): Promise<{ actions: RetroActionDto[] }> => {
      const response = await apiRequest('GET', `/api/retrospective/${retroId}/actions`);
      return response.json();
    },
    createAction: async (retroId: string, data: CreateRetroActionDto): Promise<RetroActionDto> => {
      const response = await apiRequest('POST', `/api/retrospective/${retroId}/actions`, data);
      return response.json();
    },
    updateAction: async (
      retroId: string,
      actionId: string,
      data: UpdateRetroActionDto,
    ): Promise<RetroActionDto> => {
      const response = await apiRequest(
        'PATCH',
        `/api/retrospective/${retroId}/actions/${actionId}`,
        data,
      );
      return response.json();
    },
  },

  github: {
    listRepos: async (): Promise<GithubRepo[]> => {
      return fetchGitHubReposWithRetry<GithubRepo[]>();
    },
    getCurrentUser: async (): Promise<{ login: string | null }> => {
      const response = await apiRequest('GET', '/api/github/me');
      return response.json();
    },
    searchFiles: async (owner: string, repo: string, query: string): Promise<string[]> => {
      const response = await apiRequest('POST', '/api/github/search-files', { owner, repo, query });
      return response.json();
    },
    getRepoContent: async (
      owner: string,
      repo: string,
      path: string = '',
    ): Promise<RepoContent> => {
      const response = await apiRequest(
        'GET',
        `/api/github/repos/${owner}/${repo}/content?path=${encodeURIComponent(path)}`,
      );
      return response.json();
    },
  },

  // Refinement Interaction API (PRD: Modo Conversacional Interativo)
  refinement: {
    getStatus: async (
      refinementId: string,
    ): Promise<{
      refinementId: string;
      status: 'ACTIVE' | 'PAUSED';
      sequence: number;
      pausedAt: string | null;
      activeInteraction: {
        interactionId: string;
        question: string;
        options?: string[];
        createdAt: string;
      } | null;
      suggestions: Array<{
        id: string;
        text: string;
        type: 'context' | 'correction' | 'enhancement';
      }>;
      history: Array<{
        interactionId: string;
        sequence: number;
        kind: string;
        question?: string;
        answer?: string;
        timestamp: string;
      }>;
    }> => {
      const response = await apiRequest('GET', `/api/refinement-status/${refinementId}`);
      return response.json();
    },

    submitAnswer: async (
      refinementId: string,
      interactionId: string,
      sequence: number,
      response: string,
    ): Promise<{
      applied: boolean;
      interactionId: string;
      newSequence: number;
      status: 'ACTIVE' | 'PAUSED';
    }> => {
      const res = await apiRequest('POST', '/api/refinement-response', {
        refinementId,
        interactionId,
        sequence,
        response,
      });
      return res.json();
    },

    pause: async (refinementId: string): Promise<{ success: boolean }> => {
      const response = await apiRequest('POST', '/api/refinement-pause', { refinementId });
      return response.json();
    },

    resume: async (refinementId: string): Promise<{ success: boolean }> => {
      const response = await apiRequest('POST', '/api/refinement-resume', { refinementId });
      return response.json();
    },

    recordInnovationSuggestionFeedback: async (payload: {
      demandId: number;
      agentMessageId: string;
      accepted: boolean;
      agent?: string;
    }): Promise<{ ok: boolean; eventId: number | null }> => {
      const response = await apiRequest(
        'POST',
        '/api/refinement/innovation-suggestion-feedback',
        payload,
      );
      return response.json();
    },

    recordToneFeedback: async (payload: {
      demandId: number;
      agentMessageId?: string;
      feedbackType: 'like' | 'dislike';
    }): Promise<{ ok: boolean; eventId: number | null }> => {
      const response = await apiRequest('POST', '/api/refinement/tone-feedback', payload);
      return response.json();
    },
  },

  getSkillsLockfile: async (): Promise<SkillsLockfileResponse> => {
    const response = await apiRequest('GET', '/api/skills/lockfile');
    return response.json();
  },
};
