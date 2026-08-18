/**
 * ErrorBoundary - Captura erros React e envia logs ao servidor
 *
 * Implementa instrumentação de erros para coleta de dados por 48h
 * para validar hipótese sobre objetos não serializáveis (#419)
 */

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { UniversalErrorFallback, type ErrorType } from './universal-error-fallback';
import { safeSerialize } from '@/lib/safe-serialize';
import { safeWindowOpen } from '@/lib/safe-window-open';

// ─── Types ────────────────────────────────────────────────────────────────────

type DataSource = 'gov_api' | 'internal' | 'ai_model' | 'unknown';

interface ErrorBoundaryProps {
  /** Conteúdo a ser renderizado */
  children: ReactNode;
  /** Nome do componente para identificação */
  componentName?: string;
  /** Data source esperada (para categorização de erros) */
  dataSource?: DataSource;
  /** Fallback customizado (opcional) */
  fallback?: ReactNode | ((props: FallbackProps) => ReactNode);
  /** Callback chamado quando erro é capturado */
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
  /** Se true, mostra detalhes técnicos */
  showTechnicalDetails?: boolean;
  /** Tipo de erro para estilização do fallback */
  errorType?: ErrorType;
}

interface FallbackProps {
  error: Error;
  errorInfo: ErrorInfo | null;
  resetErrorBoundary: () => void;
  componentName?: string;
  dataSource?: DataSource;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

// ─── Error Payload ────────────────────────────────────────────────────────────

interface ClientErrorPayload {
  timestamp: string;
  sessionId: string;
  component: string;
  errorMessage: string;
  stackTrace: string;
  payload: Record<string, unknown>;
  dataSource: DataSource;
  userAgent: string;
  url: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getSessionId(): string {
  const key = 'aichatflow_session_id';
  let sessionId = sessionStorage.getItem(key);

  if (!sessionId) {
    sessionId = `session_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    sessionStorage.setItem(key, sessionId);
  }

  return sessionId;
}

function inferDataSource(error: Error, componentName?: string): DataSource {
  const errorStr = `${error.message} ${error.stack || ''} ${componentName || ''}`.toLowerCase();

  // Padrões para APIs governamentais
  if (errorStr.includes('gov') || errorStr.includes('receita')) {
    return 'gov_api';
  }

  // Padrões para modelos de IA
  if (
    errorStr.includes('openai') ||
    errorStr.includes('anthropic') ||
    errorStr.includes('deepseek') ||
    errorStr.includes('model') ||
    errorStr.includes('llm') ||
    errorStr.includes('agent')
  ) {
    return 'ai_model';
  }

  // Padrões internos
  if (
    errorStr.includes('react') ||
    errorStr.includes('component') ||
    errorStr.includes('render') ||
    errorStr.includes('hook')
  ) {
    return 'internal';
  }

  return 'unknown';
}

function extractSerializationError(error: Error): Record<string, unknown> | null {
  const message = error.message.toLowerCase();

  // Detecta erros comuns de serialização
  if (
    message.includes('cannot convert') ||
    message.includes('object object') ||
    message.includes('not valid json') ||
    message.includes('circular structure') ||
    message.includes('bigint') ||
    message.includes('promise') ||
    message.includes('function')
  ) {
    return {
      serializationError: true,
      errorType: message.includes('bigint')
        ? 'bigint'
        : message.includes('promise')
          ? 'promise'
          : message.includes('function')
            ? 'function'
            : message.includes('circular')
              ? 'circular'
              : 'object',
    };
  }

  return null;
}

// Debounce para evitar flood de erros
const errorCache = new Map<string, number>();
const ERROR_DEBOUNCE_MS = 5000; // 5 segundos

function shouldReportError(errorKey: string): boolean {
  const now = Date.now();
  const lastReported = errorCache.get(errorKey);

  if (lastReported && now - lastReported < ERROR_DEBOUNCE_MS) {
    return false;
  }

  errorCache.set(errorKey, now);
  return true;
}

// ─── Error Reporter ───────────────────────────────────────────────────────────

async function reportErrorToServer(payload: ClientErrorPayload): Promise<void> {
  try {
    const response = await fetch('/api/errors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      console.warn('[ErrorBoundary] Failed to report error:', response.status);
    }
  } catch (e) {
    // Silently fail - não queremos causar mais erros ao reportar
    console.warn('[ErrorBoundary] Error reporting failed:', e);
  }
}

// ─── Component ────────────────────────────────────────────────────────────────

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    this.setState({ errorInfo });

    const { componentName, dataSource, onError } = this.props;

    // Callback customizado
    if (onError) {
      onError(error, errorInfo);
    }

    // Inferir data source se não especificado
    const inferredDataSource = dataSource || inferDataSource(error, componentName);

    // Criar chave única para debounce
    const errorKey = `${componentName}:${error.message}:${inferredDataSource}`;

    if (!shouldReportError(errorKey)) {
      console.log('[ErrorBoundary] Error debounced:', errorKey);
      return;
    }

    // Extrair informações de serialização
    const serializationInfo = extractSerializationError(error);

    // Montar payload
    const payload: ClientErrorPayload = {
      timestamp: new Date().toISOString(),
      sessionId: getSessionId(),
      component: componentName || 'unknown',
      errorMessage: error.message,
      stackTrace: error.stack || '',
      payload: safeSerialize({
        componentStack: errorInfo.componentStack,
        serializationInfo,
        errorName: error.name,
        // Snapshot do state/props não disponível no class component
        // mas podemos adicionar via context se necessário
      }),
      dataSource: inferredDataSource,
      userAgent: navigator.userAgent,
      url: window.location.href,
    };

    // Log local
    console.error('[ErrorBoundary] Captured error:', {
      component: componentName,
      dataSource: inferredDataSource,
      error: error.message,
    });

    // Enviar ao servidor
    reportErrorToServer(payload);
  }

  resetErrorBoundary = (): void => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    });
  };

  handleBack = (): void => {
    window.history.back();
  };

  handleReport = (): void => {
    // Abre modal de feedback ou redireciona
    const subject = encodeURIComponent(`Erro: ${this.state.error?.message || 'Desconhecido'}`);
    const body = encodeURIComponent(
      `Componente: ${this.props.componentName || 'N/A'}\n` +
        `URL: ${window.location.href}\n` +
        `Erro: ${this.state.error?.message || 'N/A'}\n\n` +
        `Descreva o que você estava fazendo quando o erro ocorreu:\n`,
    );
    safeWindowOpen(`mailto:suporte@aichatflow.com?subject=${subject}&body=${body}`);
  };

  render(): ReactNode {
    const { hasError, error, errorInfo } = this.state;
    const { children, fallback, componentName, dataSource, showTechnicalDetails, errorType } =
      this.props;

    if (!hasError) {
      return children;
    }

    // Fallback customizado
    if (fallback) {
      if (typeof fallback === 'function') {
        return fallback({
          error: error!,
          errorInfo,
          resetErrorBoundary: this.resetErrorBoundary,
          componentName,
          dataSource,
        });
      }
      return fallback;
    }

    // Fallback padrão
    const inferredDataSource = dataSource || inferDataSource(error!, componentName);
    const inferredErrorType: ErrorType =
      errorType || (inferredDataSource === 'gov_api' ? 'unavailable' : 'system');

    return (
      <UniversalErrorFallback
        errorType={inferredErrorType}
        componentName={componentName}
        dataSource={inferredDataSource}
        technicalDetails={error?.stack}
        showTechnicalDetails={showTechnicalDetails || import.meta.env.DEV}
        onRetry={this.resetErrorBoundary}
        onBack={this.handleBack}
        onReport={this.handleReport}
      />
    );
  }
}

// ─── Specialized ErrorBoundaries ──────────────────────────────────────────────

export function SquadChatErrorBoundary({ children }: { children: ReactNode }) {
  return (
    <ErrorBoundary
      componentName="SquadChat"
      dataSource="ai_model"
      errorType="system"
      showTechnicalDetails={import.meta.env.DEV}
    >
      {children}
    </ErrorBoundary>
  );
}
