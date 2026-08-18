import { CheckCircle, AlertTriangle, Code, Briefcase, Info } from 'lucide-react';
import { cn } from '@/lib/utils';

const typeColorClasses = {
  cyan: {
    border: 'border-[var(--accent-cyan)]',
    bg: 'bg-[var(--accent-cyan)]/10',
    bgSolid: 'bg-[var(--accent-cyan)]',
    text: 'text-[var(--accent-cyan)]',
  },
  lime: {
    border: 'border-[var(--accent-lime)]',
    bg: 'bg-[var(--accent-lime)]/10',
    bgSolid: 'bg-[var(--accent-lime)]',
    text: 'text-[var(--accent-lime)]',
  },
};

interface TypeAdherenceResult {
  isAdherent: boolean;
  type: 'technical' | 'business' | null;
  sectionsFound: string[];
  sectionsRequired: number;
  sectionsMet: number;
  score: number;
  feedback: string;
}

interface TypeAdherenceBadgeProps {
  typeAdherence?: TypeAdherenceResult | null;
  refinementType?: 'technical' | 'business' | null;
  className?: string;
}

export function TypeAdherenceBadge({
  typeAdherence,
  refinementType,
  className,
}: TypeAdherenceBadgeProps) {
  // Handle legacy refinements without type
  if (!refinementType && !typeAdherence) {
    return (
      <div
        className={cn(
          'flex items-center gap-2 px-3 py-2 border-2 border-[var(--foreground-muted)]/30 bg-[var(--muted)]',
          className,
        )}
        role="status"
        aria-label="Tipo não definido (legado)"
      >
        <Info className="w-4 h-4 text-[var(--foreground-muted)]" aria-hidden="true" />
        <span className="font-mono text-xs text-[var(--foreground-muted)]">
          Tipo não definido (legado)
        </span>
      </div>
    );
  }

  // Handle case where we have type but no adherence result yet
  if (refinementType && !typeAdherence) {
    const TypeIcon = refinementType === 'technical' ? Code : Briefcase;
    const typeColor = refinementType === 'technical' ? 'cyan' : 'lime';
    const classes = typeColorClasses[typeColor];
    const typeLabel = refinementType === 'technical' ? 'Técnico' : 'Negócios';

    return (
      <div
        className={cn(
          'flex items-center gap-2 px-3 py-2 border-2',
          classes.border,
          classes.bg,
          className,
        )}
        role="status"
        aria-label={`Tipo: ${typeLabel}`}
      >
        <TypeIcon className={cn('w-4 h-4', classes.text)} aria-hidden="true" />
        <span className={cn('font-mono text-xs font-bold', classes.text)}>{typeLabel}</span>
      </div>
    );
  }

  if (!typeAdherence) return null;

  const isAdherent = typeAdherence.isAdherent;
  const score = typeAdherence.score;
  const type = typeAdherence.type;

  const TypeIcon = type === 'technical' ? Code : Briefcase;
  const StatusIcon = isAdherent ? CheckCircle : AlertTriangle;
  const typeLabel = type === 'technical' ? 'Técnico' : 'Negócios';
  const typeColor = type === 'technical' ? 'cyan' : 'lime';
  const classes = typeColorClasses[typeColor];

  return (
    <div className={cn('space-y-2', className)}>
      {/* Main Badge */}
      <div
        className={cn(
          'flex items-center justify-between gap-3 px-3 py-2 border-2',
          isAdherent
            ? 'border-[var(--success)] bg-[var(--success)]/10'
            : 'border-[var(--accent-orange)] bg-[var(--accent-orange)]/10',
        )}
        role="status"
        aria-label={
          isAdherent
            ? `Tipo ${typeLabel}: Aderente ao contrato, ${score}%`
            : `Tipo ${typeLabel}: Estrutura incompleta, ${score}%`
        }
      >
        <div className="flex items-center gap-2">
          <div
            className={cn(
              'w-8 h-8 flex items-center justify-center',
              isAdherent ? 'bg-[var(--success)]' : 'bg-[var(--accent-orange)]',
            )}
          >
            <StatusIcon className="w-4 h-4 text-[var(--background)]" aria-hidden="true" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <TypeIcon className={cn('w-4 h-4', classes.text)} aria-hidden="true" />
              <span className="font-mono text-xs font-bold">{typeLabel}</span>
              <span
                className={cn(
                  'font-mono text-xs',
                  isAdherent ? 'text-[var(--success)]' : 'text-[var(--accent-orange)]',
                )}
              >
                {score}%
              </span>
            </div>
            <p
              className={cn(
                'font-mono text-[10px]',
                isAdherent ? 'text-[var(--success)]' : 'text-[var(--accent-orange)]',
              )}
            >
              {isAdherent ? 'Aderente ao contrato' : 'Estrutura incompleta'}
            </p>
          </div>
        </div>
      </div>

      {/* Feedback Message */}
      <div
        className={cn(
          'px-3 py-2 border-l-4 font-mono text-xs',
          isAdherent
            ? 'border-[var(--success)] bg-[var(--success)]/5 text-[var(--foreground)]'
            : 'border-[var(--accent-orange)] bg-[var(--accent-orange)]/5 text-[var(--foreground)]',
        )}
      >
        <p>{typeAdherence.feedback}</p>

        {typeAdherence.sectionsFound.length > 0 && (
          <div className="mt-2">
            <span className="text-[var(--foreground-muted)]">Seções encontradas: </span>
            <span className="text-[var(--foreground)]">
              {typeAdherence.sectionsFound.join(', ')}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

// Compact version for use in headers/lists
export function TypeAdherenceBadgeCompact({
  typeAdherence,
  refinementType,
  className,
}: TypeAdherenceBadgeProps) {
  if (!refinementType && !typeAdherence?.type) {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1 px-2 py-0.5 font-mono text-[10px] border border-[var(--foreground-muted)]/30 text-[var(--foreground-muted)]',
          className,
        )}
        role="status"
        aria-label="Tipo: Legado"
      >
        <Info className="w-3 h-3" aria-hidden="true" />
        LEGADO
      </span>
    );
  }

  const type = typeAdherence?.type || refinementType;
  const isAdherent = typeAdherence?.isAdherent ?? true;
  const TypeIcon = type === 'technical' ? Code : Briefcase;
  const typeColor = type === 'technical' ? 'cyan' : 'lime';
  const classes = typeColorClasses[typeColor];
  const typeLabel = type === 'technical' ? 'TEC' : 'NEG';

  const fullTypeLabel = type === 'technical' ? 'Técnico' : 'Negócios';

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 font-mono text-[10px] font-bold',
        !isAdherent && 'border border-[var(--accent-orange)]',
        isAdherent ? classes.bgSolid : 'bg-transparent',
        isAdherent ? 'text-[var(--background)]' : 'text-[var(--accent-orange)]',
        className,
      )}
      role="status"
      aria-label={`Tipo: ${fullTypeLabel}${!isAdherent ? ', não aderente' : ''}`}
    >
      <TypeIcon className="w-3 h-3" aria-hidden="true" />
      {typeLabel}
      {typeAdherence && !isAdherent && <AlertTriangle className="w-3 h-3" aria-hidden="true" />}
    </span>
  );
}
