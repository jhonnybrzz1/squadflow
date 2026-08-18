import { useState, useEffect, useCallback } from 'react';
import { getFriendlyErrorFromException } from '@/lib/friendly-error';
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ShieldCheck,
  ChevronDown,
  ChevronUp,
  Loader2,
  RefreshCw,
  WifiOff,
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

interface GatingStatus {
  structural: {
    valid: boolean;
    errors: string[];
  };
  coverage: {
    omittedItems: { category: string; item: string; criticality: 'HIGH' | 'MEDIUM' | 'LOW' }[];
    score: number;
  };
  interactionsCount: number;
  documentAvailable?: boolean;
}

interface GovernanceGatingPanelProps {
  demandId: number;
  onStatusChange?: (passed: boolean) => void;
  onSubmitted?: () => void;
}

export function GovernanceGatingPanel({
  demandId,
  onStatusChange,
  onSubmitted,
}: GovernanceGatingPanelProps) {
  const { toast } = useToast();
  const [status, setStatus] = useState<GatingStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [overrideJustification, setOverrideJustification] = useState('');
  const [isOverriding, setIsOverriding] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const fetchStatus = useCallback(async () => {
    setIsLoading(true);
    setHasError(false);
    try {
      const response = await fetch(`/api/governance/demands/${demandId}/gating-status`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();

      // Validate response shape
      if (!data?.structural || typeof data.structural.valid !== 'boolean') {
        throw new Error('Invalid response format');
      }

      setStatus(data);
      onStatusChange?.(data.structural.valid);
    } catch (e) {
      setHasError(true);
      setStatus(null);
      onStatusChange?.(false);
      console.warn(
        JSON.stringify({
          event: 'gating_status_error',
          timestamp: new Date().toISOString(),
          statusCode: e instanceof Error ? e.message : 'unknown',
          demandId,
        }),
      );
    } finally {
      setIsLoading(false);
    }
  }, [demandId, onStatusChange]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Loading state
  if (isLoading) {
    return (
      <div className="neo-card border-2 border-[var(--border)] overflow-hidden mb-6">
        <div className="flex items-center gap-3 p-4 bg-[var(--muted)]">
          <Loader2 className="w-5 h-5 text-[var(--foreground-muted)] animate-spin" />
          <span className="font-mono text-xs text-[var(--foreground-muted)]">
            Verificando status de governança...
          </span>
        </div>
      </div>
    );
  }

  // Error state
  if (hasError || !status) {
    return (
      <div className="neo-card border-2 border-[var(--border)] overflow-hidden mb-6">
        <div className="flex items-center justify-between p-4 bg-[var(--muted)]">
          <div className="flex items-center gap-3">
            <WifiOff className="w-5 h-5 text-[var(--foreground-muted)]" />
            <div>
              <p className="font-mono text-xs font-bold text-[var(--foreground-muted)]">
                Status temporariamente indisponível
              </p>
              <p className="font-mono text-[10px] text-[var(--foreground-muted)]">
                Não foi possível verificar o status de governança. Tente novamente.
              </p>
            </div>
          </div>
          <button
            onClick={fetchStatus}
            className="flex items-center gap-1.5 px-3 py-1.5 border-2 border-[var(--border)] font-mono text-xs font-bold hover:border-[var(--accent-cyan)] hover:text-[var(--accent-cyan)] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
            aria-label="Tentar verificar governança novamente"
          >
            <RefreshCw className="w-3 h-3" aria-hidden="true" />
            Tentar novamente
          </button>
        </div>
      </div>
    );
  }

  const { structural, coverage } = status;
  const passed = structural.valid;
  const documentAvailable = status.documentAvailable !== false;
  const canSubmit = documentAvailable && (passed || overrideJustification.trim().length >= 10);

  const handleSubmitForApproval = async () => {
    setIsSubmitting(true);
    setIsOverriding(!passed);

    try {
      const response = await fetch(`/api/governance/demands/${demandId}/submit-for-approval`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          passed
            ? {}
            : {
                override: true,
                overrideJustification: overrideJustification.trim(),
              },
        ),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Falha ao submeter documento para revisão');
      }

      toast({
        title: 'Snapshot criado para revisão',
        description: 'O PRD foi congelado e enviado para aprovação humana.',
      });
      onSubmitted?.();
    } catch (error) {
      console.error('Erro ao submeter para revisão:', error);
      toast({
        title: 'Erro ao submeter para revisão',
        description: getFriendlyErrorFromException(error).message,
        variant: 'destructive',
      });
    } finally {
      setIsSubmitting(false);
      setIsOverriding(false);
    }
  };

  return (
    <div className="neo-card border-2 border-[var(--border)] overflow-hidden mb-6">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between p-4 bg-[var(--muted)] hover:bg-[var(--border)] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
      >
        <div className="flex items-center gap-3">
          {passed ? (
            <ShieldCheck className="w-6 h-6 text-[var(--success)]" />
          ) : (
            <AlertTriangle className="w-6 h-6 text-[var(--warning)]" />
          )}
          <div className="text-left">
            <h3 className="font-mono text-sm font-bold">
              GOVERNANCE GATE: {passed ? 'APROVADO' : 'PENDENTE'}
            </h3>
            <p className="font-mono text-[10px] text-[var(--foreground-muted)] uppercase">
              Checklist Estrutural • Cobertura ({coverage.score}%) • {status.interactionsCount}{' '}
              Interações
            </p>
          </div>
        </div>
        {isExpanded ? <ChevronUp className="w-5 h-5" /> : <ChevronDown className="w-5 h-5" />}
      </button>

      {isExpanded && (
        <div className="p-4 border-t-2 border-[var(--border)] space-y-4">
          {/* Structural Errors */}
          {!passed && documentAvailable && (
            <div className="space-y-2">
              <h4 className="font-mono text-xs font-bold flex items-center gap-2">
                <XCircle className="w-4 h-4 text-[var(--destructive)]" />
                BLOQUEIOS ESTRUTURAIS
              </h4>
              <ul className="space-y-1">
                {structural.errors.map((error, idx) => (
                  <li
                    key={idx}
                    className="font-mono text-[11px] p-2 bg-[var(--destructive)]/10 text-[var(--destructive)] border border-[var(--destructive)]/20"
                  >
                    {error}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {!documentAvailable && (
            <div className="p-3 bg-[var(--warning)]/10 border border-[var(--warning)]/20 text-[var(--warning)] font-mono text-xs flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" />
              Aguarde a geração e persistência do PRD antes de submeter para aprovação.
            </div>
          )}

          {/* Coverage Warnings */}
          {coverage.omittedItems.length > 0 && (
            <div className="space-y-2">
              <h4 className="font-mono text-xs font-bold flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-[var(--warning)]" />
                ANÁLISE DE COBERTURA (OMISSÕES DETECTADAS)
              </h4>
              <ul className="space-y-1">
                {coverage.omittedItems.map((omit, idx) => (
                  <li
                    key={idx}
                    className="font-mono text-[11px] p-2 border-l-4 bg-[var(--warning)]/5 border-[var(--warning)]"
                  >
                    <span className="font-bold">[{omit.category}]</span> {omit.item}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {passed && (
            <div className="p-3 bg-[var(--success)]/10 border border-[var(--success)]/20 text-[var(--success)] font-mono text-xs flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4" />
              Documento atende a todos os critérios estruturais para submissão.
            </div>
          )}

          {/* Override Panel */}
          {!passed && documentAvailable && (
            <div className="pt-4 border-t border-[var(--border)] border-dashed">
              <label
                htmlFor="override-justification"
                className="block font-mono text-[10px] font-bold mb-2 uppercase"
              >
                Justificativa de Override (PM/TL)
              </label>
              <textarea
                id="override-justification"
                name="overrideJustification"
                value={overrideJustification}
                onChange={(e) => setOverrideJustification(e.target.value)}
                className="w-full h-20 bg-[var(--background)] border border-[var(--border)] p-2 font-mono text-xs focus:outline-none focus:ring-2 focus:ring-[var(--accent-cyan)] focus:border-[var(--foreground)]"
                placeholder="Explique por que avançar mesmo com falhas no gate..."
              />
              <p className="font-mono text-[9px] text-[var(--foreground-muted)] mt-1 italic">
                * O override permite avançar para UNDER_REVIEW, mas registra o desvio para
                auditoria.
              </p>
            </div>
          )}

          <div className="pt-4 border-t border-[var(--border)] border-dashed">
            <button
              onClick={handleSubmitForApproval}
              disabled={!canSubmit || isSubmitting}
              className="flex items-center justify-center gap-2 min-h-[44px] w-full px-4 py-2 border-2 border-[var(--accent-cyan)] bg-[var(--accent-cyan)] text-[var(--background)] font-mono text-xs font-bold transition-all hover:-translate-x-0.5 hover:-translate-y-0.5 active:scale-95 motion-reduce:transform-none disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
            >
              {isSubmitting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <ShieldCheck className="w-4 h-4" />
              )}
              {isSubmitting
                ? isOverriding
                  ? 'ENVIANDO COM OVERRIDE...'
                  : 'CRIANDO SNAPSHOT...'
                : passed
                  ? 'SUBMETER SNAPSHOT PARA APROVAÇÃO'
                  : 'SUBMETER COM OVERRIDE JUSTIFICADO'}
            </button>
            {!documentAvailable && (
              <p className="mt-2 font-mono text-[10px] text-[var(--foreground-muted)]">
                Submissão indisponível enquanto o PRD não puder ser carregado.
              </p>
            )}
            {documentAvailable && !passed && !canSubmit && (
              <p className="mt-2 font-mono text-[10px] text-[var(--foreground-muted)]">
                Informe uma justificativa com pelo menos 10 caracteres para avançar com override.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
