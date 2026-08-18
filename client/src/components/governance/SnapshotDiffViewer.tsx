import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ChevronDown,
  ChevronUp,
  GitCompare,
  Plus,
  Minus,
  Edit3,
  Loader2,
  AlertCircle,
  Clock,
  FileText,
} from 'lucide-react';

interface SnapshotInfo {
  snapshotId: string;
  snapshotType: 'REVIEW' | 'APPROVED';
  snapshotHash: string;
  createdAt: string;
}

interface DiffChange {
  field: string;
  type: 'added' | 'removed' | 'modified';
  from?: string;
  to?: string;
}

interface SnapshotDiffData {
  demandId: number;
  fromSnapshot: SnapshotInfo;
  toSnapshot: SnapshotInfo;
  changes: DiffChange[];
  hasChanges: boolean;
}

interface SnapshotsListData {
  demandId: number;
  snapshots: SnapshotInfo[];
  count: number;
}

interface SnapshotDiffViewerProps {
  demandId: number;
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function ChangeIcon({ type }: { type: DiffChange['type'] }) {
  switch (type) {
    case 'added':
      return <Plus className="w-4 h-4 text-[var(--success)]" />;
    case 'removed':
      return <Minus className="w-4 h-4 text-[var(--destructive)]" />;
    case 'modified':
      return <Edit3 className="w-4 h-4 text-[var(--warning)]" />;
  }
}

function ChangeCard({ change }: { change: DiffChange }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const hasContent = change.from || change.to;

  return (
    <div className="border border-[var(--border)] bg-[var(--background)]">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between p-2 hover:bg-[var(--muted)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
        disabled={!hasContent}
      >
        <div className="flex items-center gap-2">
          <ChangeIcon type={change.type} />
          <span className="font-mono text-xs font-bold">{change.field}</span>
          <span
            className={`font-mono text-[10px] px-1.5 py-0.5 rounded ${
              change.type === 'added'
                ? 'bg-[var(--success)]/10 text-[var(--success)]'
                : change.type === 'removed'
                  ? 'bg-[var(--destructive)]/10 text-[var(--destructive)]'
                  : 'bg-[var(--warning)]/10 text-[var(--warning)]'
            }`}
          >
            {change.type === 'added'
              ? 'ADICIONADO'
              : change.type === 'removed'
                ? 'REMOVIDO'
                : 'MODIFICADO'}
          </span>
        </div>
        {hasContent &&
          (isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />)}
      </button>

      {isExpanded && hasContent && (
        <div className="p-2 border-t border-[var(--border)] space-y-2">
          {change.from && (
            <div className="space-y-1">
              <p className="font-mono text-[10px] text-[var(--foreground-muted)]">ANTES:</p>
              <pre className="font-mono text-[11px] p-2 bg-[var(--destructive)]/5 border-l-2 border-[var(--destructive)] overflow-x-auto whitespace-pre-wrap max-h-40">
                {change.from.slice(0, 1000)}
                {change.from.length > 1000 && '...'}
              </pre>
            </div>
          )}
          {change.to && (
            <div className="space-y-1">
              <p className="font-mono text-[10px] text-[var(--foreground-muted)]">DEPOIS:</p>
              <pre className="font-mono text-[11px] p-2 bg-[var(--success)]/5 border-l-2 border-[var(--success)] overflow-x-auto whitespace-pre-wrap max-h-40">
                {change.to.slice(0, 1000)}
                {change.to.length > 1000 && '...'}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function SnapshotDiffViewer({ demandId }: SnapshotDiffViewerProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [selectedFrom, setSelectedFrom] = useState<string | null>(null);
  const [selectedTo, setSelectedTo] = useState<string | null>(null);

  // Fetch available snapshots
  const {
    data: snapshotsData,
    isLoading: loadingSnapshots,
    error: snapshotsError,
  } = useQuery<SnapshotsListData>({
    queryKey: [`/api/governance/demands/${demandId}/snapshots`],
    queryFn: async () => {
      const response = await fetch(`/api/governance/demands/${demandId}/snapshots`);
      if (!response.ok) {
        throw new Error('Failed to fetch snapshots');
      }
      return response.json();
    },
    enabled: isExpanded,
    staleTime: 30000,
  });

  // Fetch diff when both snapshots are selected
  const {
    data: diffData,
    isLoading: loadingDiff,
    error: diffError,
  } = useQuery<SnapshotDiffData>({
    queryKey: [`/api/governance/demands/${demandId}/snapshots/diff`, selectedFrom, selectedTo],
    queryFn: async () => {
      const response = await fetch(
        `/api/governance/demands/${demandId}/snapshots/diff?from=${selectedFrom}&to=${selectedTo}`,
      );
      if (!response.ok) {
        throw new Error('Failed to fetch diff');
      }
      return response.json();
    },
    enabled: isExpanded && !!selectedFrom && !!selectedTo && selectedFrom !== selectedTo,
    staleTime: 30000,
  });

  const hasSnapshots = snapshotsData && snapshotsData.count >= 2;

  return (
    <div className="neo-card border-2 border-[var(--border)] overflow-hidden mb-4">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between p-3 bg-[var(--muted)] hover:bg-[var(--border)] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
      >
        <div className="flex items-center gap-2">
          <GitCompare className="w-5 h-5 text-[var(--accent-cyan)]" />
          <div className="text-left">
            <h4 className="font-mono text-xs font-bold">COMPARAR VERSÕES</h4>
            <p className="font-mono text-[10px] text-[var(--foreground-muted)]">
              {snapshotsData
                ? `${snapshotsData.count} snapshot(s) disponível(is)`
                : 'Clique para ver histórico'}
            </p>
          </div>
        </div>
        {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
      </button>

      {isExpanded && (
        <div className="p-3 border-t-2 border-[var(--border)] space-y-4">
          {loadingSnapshots && (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="w-5 h-5 animate-spin text-[var(--foreground-muted)]" />
              <span className="ml-2 font-mono text-xs text-[var(--foreground-muted)]">
                Carregando snapshots...
              </span>
            </div>
          )}

          {snapshotsError && (
            <div className="flex items-center gap-2 p-2 bg-[var(--destructive)]/10 border border-[var(--destructive)]/20 text-[var(--destructive)]">
              <AlertCircle className="w-4 h-4" />
              <span className="font-mono text-xs">Erro ao carregar snapshots</span>
            </div>
          )}

          {!loadingSnapshots && !snapshotsError && !hasSnapshots && (
            <div className="text-center py-4">
              <FileText className="w-8 h-8 mx-auto text-[var(--foreground-muted)] mb-2" />
              <p className="font-mono text-xs text-[var(--foreground-muted)]">
                Necessário pelo menos 2 snapshots para comparar
              </p>
            </div>
          )}

          {hasSnapshots && (
            <>
              {/* Snapshot selectors */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label
                    htmlFor="diff-from"
                    className="block font-mono text-[10px] font-bold mb-1 text-[var(--foreground-muted)]"
                  >
                    DE (ANTERIOR)
                  </label>
                  <select
                    id="diff-from"
                    name="diffFrom"
                    value={selectedFrom || ''}
                    onChange={(e) => setSelectedFrom(e.target.value || null)}
                    className="w-full p-2 bg-[var(--background)] border border-[var(--border)] font-mono text-xs focus:outline-none focus:ring-2 focus:ring-[var(--accent-cyan)] focus:border-[var(--accent-cyan)]"
                  >
                    <option value="">Selecionar...</option>
                    {snapshotsData.snapshots.map((s) => (
                      <option
                        key={s.snapshotId}
                        value={s.snapshotId}
                        disabled={s.snapshotId === selectedTo}
                      >
                        {s.snapshotType} - {formatDate(s.createdAt)}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label
                    htmlFor="diff-to"
                    className="block font-mono text-[10px] font-bold mb-1 text-[var(--foreground-muted)]"
                  >
                    PARA (ATUAL)
                  </label>
                  <select
                    id="diff-to"
                    name="diffTo"
                    value={selectedTo || ''}
                    onChange={(e) => setSelectedTo(e.target.value || null)}
                    className="w-full p-2 bg-[var(--background)] border border-[var(--border)] font-mono text-xs focus:outline-none focus:ring-2 focus:ring-[var(--accent-cyan)] focus:border-[var(--accent-cyan)]"
                  >
                    <option value="">Selecionar...</option>
                    {snapshotsData.snapshots.map((s) => (
                      <option
                        key={s.snapshotId}
                        value={s.snapshotId}
                        disabled={s.snapshotId === selectedFrom}
                      >
                        {s.snapshotType} - {formatDate(s.createdAt)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Diff results */}
              {loadingDiff && (
                <div className="flex items-center justify-center py-4">
                  <Loader2 className="w-5 h-5 animate-spin text-[var(--foreground-muted)]" />
                  <span className="ml-2 font-mono text-xs text-[var(--foreground-muted)]">
                    Calculando diferenças...
                  </span>
                </div>
              )}

              {diffError && (
                <div className="flex items-center gap-2 p-2 bg-[var(--destructive)]/10 border border-[var(--destructive)]/20 text-[var(--destructive)]">
                  <AlertCircle className="w-4 h-4" />
                  <span className="font-mono text-xs">Erro ao calcular diff</span>
                </div>
              )}

              {diffData && (
                <div className="space-y-3">
                  {/* Snapshot metadata */}
                  <div className="grid grid-cols-2 gap-2 p-2 bg-[var(--muted)] border border-[var(--border)]">
                    <div className="flex items-center gap-2">
                      <Clock className="w-3 h-3 text-[var(--foreground-muted)]" />
                      <span className="font-mono text-[10px]">
                        {formatDate(diffData.fromSnapshot.createdAt)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Clock className="w-3 h-3 text-[var(--foreground-muted)]" />
                      <span className="font-mono text-[10px]">
                        {formatDate(diffData.toSnapshot.createdAt)}
                      </span>
                    </div>
                  </div>

                  {/* Changes */}
                  {!diffData.hasChanges ? (
                    <div className="text-center py-4 border border-[var(--border)] border-dashed">
                      <p className="font-mono text-xs text-[var(--foreground-muted)]">
                        Sem diferenças entre os snapshots selecionados
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      <p className="font-mono text-[10px] font-bold text-[var(--foreground-muted)]">
                        {diffData.changes.length} ALTERAÇÃO(ÕES)
                      </p>
                      {diffData.changes.map((change, idx) => (
                        <ChangeCard key={idx} change={change} />
                      ))}
                    </div>
                  )}
                </div>
              )}

              {selectedFrom && selectedTo && selectedFrom === selectedTo && (
                <div className="text-center py-2">
                  <p className="font-mono text-xs text-[var(--warning)]">
                    Selecione snapshots diferentes para comparar
                  </p>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
