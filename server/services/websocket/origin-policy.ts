import { logger } from '../../utils/logger';

/**
 * Spec 012 (H-05): allowlist de origens locais para o upgrade WebSocket.
 *
 * A allowlist default depende da porta REAL do processo, que pode ser
 * dinâmica (PORT ausente => listen(0)), então ela é construída via
 * setActualPort() após o server.listen — nunca na carga do módulo.
 */
export type UpgradeDecision = 'accept' | 'reject';

function normalizeOrigin(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    // URL.origin já normaliza host lowercase e omite porta default do scheme.
    return url.origin.toLowerCase();
  } catch (_) {
    return null;
  }
}

export class WebSocketOriginPolicy {
  private overrideOrigins: Set<string> | null = null;
  private defaultOrigins: Set<string> = new Set();

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const csv = env.WS_ALLOWED_ORIGINS;
    if (typeof csv === 'string' && csv.trim().length > 0) {
      const parsed = new Set<string>();
      for (const entry of csv.split(',')) {
        if (entry.trim().length === 0) continue;
        const normalized = normalizeOrigin(entry);
        if (normalized) {
          parsed.add(normalized);
        } else {
          logger.warn('WS_ALLOWED_ORIGINS contém origem inválida — entrada descartada', {
            context: { entry: entry.trim() },
          });
        }
      }
      // Lista vazia resultante recai no default seguro (localhost).
      this.overrideOrigins = parsed.size > 0 ? parsed : null;
      if (parsed.size === 0) {
        logger.warn('WS_ALLOWED_ORIGINS sem origem válida — usando allowlist local default');
      }
    }
  }

  /** Deve ser chamado após server.listen com a porta real do processo. */
  setActualPort(port: number): void {
    if (!Number.isInteger(port) || port <= 0) return;
    this.defaultOrigins = new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`]);
  }

  get allowedOrigins(): ReadonlySet<string> {
    return this.overrideOrigins ?? this.defaultOrigins;
  }

  decide(originHeader: string | undefined): UpgradeDecision {
    if (!originHeader) return 'reject';
    const normalized = normalizeOrigin(originHeader);
    if (!normalized) return 'reject';
    return this.allowedOrigins.has(normalized) ? 'accept' : 'reject';
  }
}

export const webSocketOriginPolicy = new WebSocketOriginPolicy();
