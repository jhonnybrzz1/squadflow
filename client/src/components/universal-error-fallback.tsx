/**
 * UniversalErrorFallback - Componente de erro acessível WCAG 2.1 AA
 *
 * Exibe mensagem de erro amigável com opções de recuperação.
 * Usado como fallback em ErrorBoundaries.
 */

import { AlertTriangle, AlertCircle, RefreshCw, ArrowLeft, MessageSquare } from 'lucide-react';
import { cn } from '@/lib/utils';
import { CATEGORY_TEXTS, type FriendlyErrorCategory } from '@/lib/friendly-error';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ErrorType = FriendlyErrorCategory;

export interface UniversalErrorFallbackProps {
  /** Tipo de erro para determinar ícone e estilo */
  errorType?: ErrorType;
  /** Título do erro (default: "Ocorreu um erro") */
  title?: string;
  /** Mensagem descritiva do erro */
  message?: string;
  /** Detalhes técnicos (exibidos em modo dev) */
  technicalDetails?: string;
  /** Callback para tentar novamente */
  onRetry?: () => void;
  /** Callback para voltar */
  onBack?: () => void;
  /** Callback para relatar problema */
  onReport?: () => void;
  /** Se true, mostra detalhes técnicos */
  showTechnicalDetails?: boolean;
  /** Classes CSS adicionais */
  className?: string;
  /** Identificador do componente que falhou */
  componentName?: string;
  /** Data source que causou o erro */
  dataSource?: 'gov_api' | 'internal' | 'ai_model' | 'unknown';
}

// ─── Constants ────────────────────────────────────────────────────────────────

// Textos padrão vêm de CATEGORY_TEXTS (client/src/lib/friendly-error.ts) —
// única fonte de verdade compartilhada com os toasts (getFriendlyError).
const ERROR_CONFIG: Record<
  ErrorType,
  {
    icon: typeof AlertTriangle;
    iconColor: string;
    bgColor: string;
    borderColor: string;
    defaultTitle: string;
    defaultMessage: string;
  }
> = {
  system: {
    icon: AlertTriangle,
    iconColor: 'text-red-600 dark:text-red-400',
    bgColor: 'bg-red-50 dark:bg-red-950/30',
    borderColor: 'border-red-200 dark:border-red-800',
    defaultTitle: CATEGORY_TEXTS.system.title,
    defaultMessage: CATEGORY_TEXTS.system.message,
  },
  unavailable: {
    icon: AlertCircle,
    iconColor: 'text-yellow-600 dark:text-yellow-400',
    bgColor: 'bg-yellow-50 dark:bg-yellow-950/30',
    borderColor: 'border-yellow-200 dark:border-yellow-800',
    defaultTitle: CATEGORY_TEXTS.unavailable.title,
    defaultMessage: CATEGORY_TEXTS.unavailable.message,
  },
  validation: {
    icon: AlertCircle,
    iconColor: 'text-orange-600 dark:text-orange-400',
    bgColor: 'bg-orange-50 dark:bg-orange-950/30',
    borderColor: 'border-orange-200 dark:border-orange-800',
    defaultTitle: CATEGORY_TEXTS.validation.title,
    defaultMessage: CATEGORY_TEXTS.validation.message,
  },
  route: {
    icon: AlertCircle,
    iconColor: 'text-blue-600 dark:text-blue-400',
    bgColor: 'bg-blue-50 dark:bg-blue-950/30',
    borderColor: 'border-blue-200 dark:border-blue-800',
    defaultTitle: CATEGORY_TEXTS.route.title,
    defaultMessage: CATEGORY_TEXTS.route.message,
  },
  unknown: {
    icon: AlertTriangle,
    iconColor: 'text-gray-600 dark:text-gray-400',
    bgColor: 'bg-gray-50 dark:bg-gray-950/30',
    borderColor: 'border-gray-200 dark:border-gray-800',
    defaultTitle: CATEGORY_TEXTS.unknown.title,
    defaultMessage: CATEGORY_TEXTS.unknown.message,
  },
};

// ─── Component ────────────────────────────────────────────────────────────────

export function UniversalErrorFallback({
  errorType = 'unknown',
  title,
  message,
  technicalDetails,
  onRetry,
  onBack,
  onReport,
  showTechnicalDetails = false,
  className,
  componentName,
  dataSource,
}: UniversalErrorFallbackProps) {
  const config = ERROR_CONFIG[errorType];
  const Icon = config.icon;

  const displayTitle = title || config.defaultTitle;
  const displayMessage = message || config.defaultMessage;

  // Ajusta mensagem para APIs governamentais (BCB 277/2022 compliance)
  const isGovApi = dataSource === 'gov_api';
  const adjustedMessage = isGovApi
    ? 'O serviço de consulta está temporariamente indisponível. Os dados serão atualizados assim que a conexão for restabelecida.'
    : displayMessage;

  return (
    <div
      role="alert"
      aria-live="assertive"
      aria-atomic="true"
      className={cn(
        'rounded-lg border-2 p-6',
        config.bgColor,
        config.borderColor,
        'focus-within:ring-2 focus-within:ring-offset-2 focus-within:ring-blue-500',
        className,
      )}
    >
      {/* Header com ícone e título */}
      <div className="flex items-start gap-4">
        <div
          className={cn(
            'flex-shrink-0 w-12 h-12 rounded-full flex items-center justify-center',
            errorType === 'system' ? 'bg-red-100 dark:bg-red-900/50' : '',
            errorType === 'unavailable' ? 'bg-yellow-100 dark:bg-yellow-900/50' : '',
            errorType === 'validation' ? 'bg-orange-100 dark:bg-orange-900/50' : '',
            errorType === 'unknown' ? 'bg-gray-100 dark:bg-gray-900/50' : '',
          )}
          aria-hidden="true"
        >
          <Icon className={cn('w-6 h-6', config.iconColor)} />
        </div>

        <div className="flex-1 min-w-0">
          <h2
            className={cn(
              'text-lg font-semibold mb-2',
              'text-gray-900 dark:text-gray-100',
              // Contraste mínimo 4.5:1 garantido
            )}
          >
            {displayTitle}
          </h2>

          <p
            className={cn(
              'text-sm leading-relaxed',
              'text-gray-700 dark:text-gray-300',
              // Contraste mínimo 4.5:1 garantido
            )}
          >
            {adjustedMessage}
          </p>

          {/* Indicador de API Gov (BCB compliance) */}
          {isGovApi && (
            <p className="mt-2 text-xs text-gray-500 dark:text-gray-400 italic">
              Fonte: API Governamental • BCB 277/2022
            </p>
          )}

          {/* Detalhes técnicos (modo dev) */}
          {showTechnicalDetails && technicalDetails && (
            <details className="mt-4">
              <summary
                className={cn(
                  'cursor-pointer text-xs font-mono',
                  'text-gray-500 dark:text-gray-400',
                  'hover:text-gray-700 dark:hover:text-gray-200',
                  'focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1',
                )}
              >
                Detalhes técnicos
              </summary>
              <pre
                className={cn(
                  'mt-2 p-3 rounded text-xs font-mono overflow-x-auto',
                  'bg-gray-100 dark:bg-gray-900',
                  'text-gray-800 dark:text-gray-200',
                  'border border-gray-200 dark:border-gray-700',
                )}
              >
                {componentName && `Componente: ${componentName}\n`}
                {dataSource && `Data Source: ${dataSource}\n`}
                {technicalDetails}
              </pre>
            </details>
          )}
        </div>
      </div>

      {/* Botões de ação */}
      <div className="mt-6 flex flex-wrap gap-3" role="group" aria-label="Ações de recuperação">
        {onRetry && (
          <button
            onClick={onRetry}
            className={cn(
              'inline-flex items-center gap-2 px-4 py-2 rounded-md',
              'text-sm font-medium',
              'bg-blue-600 text-white',
              'hover:bg-blue-700',
              'focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2',
              'transition-colors duration-200',
            )}
            aria-label="Tentar novamente"
          >
            <RefreshCw className="w-4 h-4" aria-hidden="true" />
            Tentar novamente
          </button>
        )}

        {onBack && (
          <button
            onClick={onBack}
            className={cn(
              'inline-flex items-center gap-2 px-4 py-2 rounded-md',
              'text-sm font-medium',
              'bg-gray-100 dark:bg-gray-800',
              'text-gray-700 dark:text-gray-300',
              'border border-gray-300 dark:border-gray-600',
              'hover:bg-gray-200 dark:hover:bg-gray-700',
              'focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-2',
              'transition-colors duration-200',
            )}
            aria-label="Voltar à página anterior"
          >
            <ArrowLeft className="w-4 h-4" aria-hidden="true" />
            Voltar
          </button>
        )}

        {onReport && (
          <button
            onClick={onReport}
            className={cn(
              'inline-flex items-center gap-2 px-4 py-2 rounded-md',
              'text-sm font-medium',
              'text-gray-600 dark:text-gray-400',
              'hover:text-gray-800 dark:hover:text-gray-200',
              'hover:bg-gray-100 dark:hover:bg-gray-800',
              'focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-2',
              'transition-colors duration-200',
            )}
            aria-label="Relatar este problema"
          >
            <MessageSquare className="w-4 h-4" aria-hidden="true" />
            Relatar problema
          </button>
        )}
      </div>
    </div>
  );
}
