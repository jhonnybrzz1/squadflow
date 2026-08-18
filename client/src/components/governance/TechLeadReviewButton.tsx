/**
 * Spec "Ajustes claude" F2 — botão OPCIONAL "Solicitar parecer do TechLead".
 *
 * Chama o endpoint síncrono e renderiza o parecer como markdown (F1). É
 * independente do fluxo de relatório: uma falha aqui apenas mostra um erro
 * inline (fallback) — nada mais é bloqueado.
 */
import { useState } from 'react';
import { ClipboardCheck, Loader2, AlertCircle } from 'lucide-react';
import type { TechLeadReview } from '@shared/tech-lead-review';
import { AgentMarkdown } from './AgentMarkdown';

interface TechLeadReviewButtonProps {
  jobId: string;
}

export function TechLeadReviewButton({ jobId }: TechLeadReviewButtonProps) {
  const [loading, setLoading] = useState(false);
  const [review, setReview] = useState<TechLeadReview | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function requestReview() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/agent-jobs/${jobId}/tech-lead-review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!response.ok) {
        let message = 'Não foi possível gerar o parecer do TechLead.';
        try {
          const body = await response.json();
          if (body?.message) message = String(body.message);
        } catch (_) {
          // resposta sem corpo JSON — mantém a mensagem padrão.
        }
        throw new Error(message);
      }
      setReview((await response.json()) as TechLeadReview);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha inesperada ao solicitar parecer.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mt-2 flex flex-col gap-2" data-testid="tech-lead-review">
      <button
        type="button"
        onClick={requestReview}
        disabled={loading}
        data-testid="tech-lead-review-button"
        className="inline-flex items-center gap-2 self-start border border-[var(--border)] px-2 py-1 font-mono text-[10px] uppercase hover:bg-[var(--accent-gold)]/10 disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
      >
        {loading ? (
          <Loader2 className="w-3 h-3 animate-spin" />
        ) : (
          <ClipboardCheck className="w-3 h-3" />
        )}
        {review ? 'Atualizar parecer do TechLead' : 'Solicitar parecer do TechLead'}
      </button>

      {error && (
        <div
          className="flex items-start gap-2 font-mono text-[10px] text-red-500"
          data-testid="tech-lead-review-error"
        >
          <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {review && (
        <div className="border border-[var(--border)] p-2" data-testid="tech-lead-review-content">
          <p className="font-mono text-[10px] uppercase text-[var(--foreground-muted)] mb-1">
            Parecer do TechLead{review.model ? ` · ${review.model}` : ''}
          </p>
          <AgentMarkdown content={review.parecer} />
        </div>
      )}
    </div>
  );
}
