import { useState } from 'react';
import { cn } from '@/lib/utils';
import { useQuery } from '@tanstack/react-query';
import {
  ChevronDown,
  ChevronUp,
  DollarSign,
  Cpu,
  Wrench,
  Users,
  Loader2,
  AlertCircle,
} from 'lucide-react';

import {
  isCostReconciled,
  type CostBreakdownResponse,
  type CostGroup,
} from '@shared/cost-breakdown';

type CostBreakdownData = CostBreakdownResponse;

interface DemandCostBreakdownProps {
  demandId: number;
}

function formatCost(cost: number): string {
  if (cost < 0.0001) return '<$0.0001';
  return `$${cost.toFixed(4)}`;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1000000) return `${(tokens / 1000000).toFixed(1)}M`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}K`;
  return tokens.toString();
}

function CostBar({
  value,
  total,
  colorClass,
}: {
  value: number;
  total: number;
  colorClass: string;
}) {
  const percentage = total > 0 ? (value / total) * 100 : 0;
  return (
    <div className="w-full h-1.5 bg-[var(--muted)] rounded-sm overflow-hidden">
      <div
        className={cn('h-full transition-all duration-300', colorClass)}
        style={{ width: `${percentage}%` }}
      />
    </div>
  );
}

function CostSection({
  title,
  icon,
  data,
  totalCost,
  colorClass,
}: {
  title: string;
  icon: React.ReactNode;
  data: Record<string, CostGroup>;
  totalCost: number;
  colorClass: string;
}) {
  const entries = Object.entries(data).sort((a, b) => b[1].cost - a[1].cost);

  if (entries.length === 0) {
    return null;
  }

  return (
    <div className="space-y-2">
      <h5 className="font-mono text-[10px] font-bold text-[var(--foreground-muted)] flex items-center gap-1.5">
        {icon}
        {title}
      </h5>
      <div className="space-y-1.5">
        {entries.map(([name, stats]) => {
          const percentage = totalCost > 0 ? (stats.cost / totalCost) * 100 : 0;
          return (
            <div key={name} className="space-y-0.5">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[11px] truncate max-w-[60%]" title={name}>
                  {name}
                </span>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[10px] text-[var(--foreground-muted)]">
                    {formatTokens(stats.tokens)} tok
                  </span>
                  <span className={cn('font-mono text-[11px] font-bold', colorClass)}>
                    {formatCost(stats.cost)} ({percentage.toFixed(0)}%)
                  </span>
                </div>
              </div>
              <CostBar value={stats.cost} total={totalCost} colorClass={colorClass} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function DemandCostBreakdown({ demandId }: DemandCostBreakdownProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  const { data, isLoading, error } = useQuery<CostBreakdownData>({
    queryKey: [`/api/demands/${demandId}/costs`],
    queryFn: async () => {
      const response = await fetch(`/api/demands/${demandId}/costs`);
      if (!response.ok) {
        throw new Error('Failed to fetch cost breakdown');
      }
      return response.json();
    },
    enabled: isExpanded,
    staleTime: 30000, // 30 seconds
  });

  const hasData = data && data.totalCost > 0;

  return (
    <div className="neo-card border-2 border-[var(--border)] overflow-hidden mb-4">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between p-3 bg-[var(--muted)] hover:bg-[var(--border)] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
      >
        <div className="flex items-center gap-2">
          <DollarSign className="w-5 h-5 text-[var(--accent-gold)]" />
          <div className="text-left">
            <h4 className="font-mono text-xs font-bold">CUSTO DA DEMANDA</h4>
            {hasData && (
              <p className="font-mono text-[10px] text-[var(--foreground-muted)]">
                Total: {formatCost(data.totalCost)} ({formatTokens(data.tokensIn + data.tokensOut)}{' '}
                tokens)
              </p>
            )}
            {!hasData && !isLoading && (
              <p className="font-mono text-[10px] text-[var(--foreground-muted)]">
                Clique para ver detalhes
              </p>
            )}
          </div>
        </div>
        {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
      </button>

      {isExpanded && (
        <div className="p-3 border-t-2 border-[var(--border)] space-y-4">
          {isLoading && (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="w-5 h-5 animate-spin text-[var(--foreground-muted)]" />
              <span className="ml-2 font-mono text-xs text-[var(--foreground-muted)]">
                Carregando...
              </span>
            </div>
          )}

          {error && (
            <div className="flex items-center gap-2 p-2 bg-[var(--destructive)]/10 border border-[var(--destructive)]/20 text-[var(--destructive)]">
              <AlertCircle className="w-4 h-4" />
              <span className="font-mono text-xs">Erro ao carregar custos</span>
            </div>
          )}

          {hasData && (
            <>
              {/* Summary */}
              <div className="grid grid-cols-3 gap-2">
                <div className="p-2 bg-[var(--background)] border border-[var(--border)] text-center">
                  <p className="font-mono text-lg font-bold text-[var(--accent-gold)]">
                    {formatCost(data.totalCost)}
                  </p>
                  <p className="font-mono text-[10px] text-[var(--foreground-muted)]">TOTAL</p>
                </div>
                <div className="p-2 bg-[var(--background)] border border-[var(--border)] text-center">
                  <p className="font-mono text-lg font-bold">{formatTokens(data.tokensIn)}</p>
                  <p className="font-mono text-[10px] text-[var(--foreground-muted)]">INPUT</p>
                </div>
                <div className="p-2 bg-[var(--background)] border border-[var(--border)] text-center">
                  <p className="font-mono text-lg font-bold">{formatTokens(data.tokensOut)}</p>
                  <p className="font-mono text-[10px] text-[var(--foreground-muted)]">OUTPUT</p>
                </div>
              </div>

              {/* By Agent */}
              <CostSection
                title="POR AGENTE"
                icon={<Users className="w-3 h-3" />}
                data={data.byAgent}
                totalCost={data.totalCost}
                colorClass="bg-[var(--accent-cyan)] text-[var(--accent-cyan)]"
              />

              {/* By Model */}
              <CostSection
                title="POR MODELO"
                icon={<Cpu className="w-3 h-3" />}
                data={data.byModel}
                totalCost={data.totalCost}
                colorClass="bg-[var(--accent-orange)] text-[var(--accent-orange)]"
              />

              {/* By Tool */}
              {Object.keys(data.byTool).length > 0 && (
                <CostSection
                  title="POR FERRAMENTA"
                  icon={<Wrench className="w-3 h-3" />}
                  data={data.byTool}
                  totalCost={data.totalCost}
                  colorClass="bg-[var(--accent-lime)] text-[var(--accent-lime)]"
                />
              )}

              {/* Não atribuído — spec 014 S2 / H-09: o total nunca excede as
                  categorias visíveis sem explicação */}
              {data.unattributed && data.unattributed.cost > 0 && (
                <CostSection
                  title="NÃO ATRIBUÍDO"
                  icon={<AlertCircle className="w-3 h-3" />}
                  data={{ unattributed: data.unattributed }}
                  totalCost={data.totalCost}
                  colorClass="bg-[var(--accent-gold)] text-[var(--accent-gold)]"
                />
              )}

              {/* Chamadas sem preço (spec 10056): lacuna de custo visível. */}
              {data.unpriced && data.unpriced.count > 0 && (
                <div
                  className="font-mono text-[10px] text-[var(--foreground-muted)] text-right"
                  data-testid="cost-unpriced"
                >
                  {data.unpriced.count} chamada(s) sem preço ({formatTokens(data.unpriced.tokens)}{' '}
                  tokens) — não somadas ao custo.
                </div>
              )}

              {/* Linha de reconciliação */}
              <div
                className="font-mono text-[10px] text-[var(--foreground-muted)] text-right"
                data-testid="cost-reconciliation"
              >
                {isCostReconciled(data)
                  ? 'Σ agentes + ferramentas + não atribuído = total ✓'
                  : 'Atenção: soma das categorias difere do total além da tolerância'}
              </div>
            </>
          )}

          {!isLoading && !error && !hasData && (
            <div className="text-center py-4">
              <p className="font-mono text-xs text-[var(--foreground-muted)]">
                Nenhum dado de custo disponível
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
