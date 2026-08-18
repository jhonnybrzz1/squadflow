import { useState } from 'react';
import { Users, ChevronDown } from 'lucide-react';

// Spec 10013 US4 (FR-008/013): reflete o roster real de agentes (agents/*.yaml).
// Faltavam Arquiteto, Analista Financeiro e Especialista em Segurança (já
// adicionados). Verificação de 2026-07-26: também faltavam Anti-overengineering,
// DevOps, PM Innovation e PM Discovery — 4 dos 14 agentes reais nunca apareciam
// aqui, apesar de ativos em produção.
// Exportado para a seção "Agentes da squad" do Dashboard (demanda 10024).
export const squadRoster = [
  { name: 'Product Owner', icon: '👑', color: 'var(--accent-violet)', code: 'PO' },
  { name: 'Product Manager', icon: '📋', color: 'var(--accent-gold)', code: 'PM' },
  { name: 'Tech Lead', icon: '💧', color: 'var(--accent-cyan)', code: 'TECH' },
  { name: 'Arquiteto', icon: '🏛️', color: 'var(--accent-cyan)', code: 'ARCH' },
  { name: 'UX Designer', icon: '🎨', color: 'var(--accent-magenta)', code: 'UX' },
  { name: 'QA', icon: '✅', color: 'var(--success)', code: 'QA' },
  { name: 'Scrum Master', icon: '🧝', color: 'var(--accent-lime)', code: 'SM' },
  { name: 'Analista de Dados', icon: '📈', color: 'var(--accent-orange)', code: 'DATA' },
  { name: 'Analista Financeiro', icon: '💰', color: 'var(--accent-gold)', code: 'FIN' },
  { name: 'Especialista em Segurança', icon: '🛡️', color: 'var(--destructive)', code: 'SEC' },
  { name: 'Anti-overengineering', icon: '✂️', color: 'var(--accent-lime)', code: 'AOE' },
  { name: 'DevOps', icon: '🔧', color: 'var(--accent-cyan)', code: 'OPS' },
  { name: 'PM Innovation', icon: '💡', color: 'var(--accent-gold)', code: 'PMI' },
  { name: 'PM Discovery', icon: '🧭', color: 'var(--accent-violet)', code: 'PMD' },
];

export function SquadMembers() {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className="neo-card">
      {/* Header - Clickable to toggle */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between gap-3 p-4 border-b-2 border-[var(--border)] bg-[var(--muted)] hover:bg-[var(--muted)]/80 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
        aria-expanded={isExpanded}
        aria-controls="squad-content"
      >
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-[var(--accent-violet)] flex items-center justify-center">
            <Users className="w-4 h-4 text-[var(--background)]" />
          </div>
          <span className="font-mono text-sm font-bold">SQUAD ATIVA</span>
          <span className="brutal-badge cyan text-[10px]">{squadRoster.length}</span>
        </div>
        <ChevronDown
          className={`w-4 h-4 text-[var(--foreground-muted)] transition-transform ${
            isExpanded ? 'rotate-180' : ''
          }`}
        />
      </button>

      {/* Collapsible Content */}
      {isExpanded && (
        <div id="squad-content" className="p-4">
          {/* Info Banner */}
          <div className="border-l-4 border-[var(--accent-violet)] bg-[var(--muted)] p-3 mb-4">
            <p className="font-mono text-xs text-[var(--foreground-muted)]">
              Cada agente contribui com expertise especializada para o refinamento da sua demanda.
            </p>
          </div>

          {/* Agent Grid (US4 AC2: empty-state em vez de container vazio) */}
          {squadRoster.length === 0 ? (
            <p className="font-mono text-xs text-[var(--foreground-muted)] text-center py-6">
              Novos agentes em breve
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {squadRoster.map((member, index) => (
                <div
                  key={index}
                  className="group min-h-[72px] p-4 sm:p-5 border border-[var(--border)] hover:border-current transition-colors cursor-default"
                >
                  <div className="flex min-h-[44px] items-center gap-3">
                    {/* Avatar */}
                    <div
                      className="flex min-h-[44px] min-w-[44px] items-center justify-center border-2 text-lg"
                      style={{ borderColor: member.color }}
                    >
                      {member.icon}
                    </div>

                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <p
                        className="font-mono text-[10px] font-bold truncate"
                        style={{ color: member.color }}
                      >
                        {member.code}
                      </p>
                      <div className="flex items-center gap-1">
                        <div className="status-dot online w-1.5 h-1.5" />
                        <span className="font-mono text-[11px] text-[var(--foreground-muted)]">
                          ONLINE
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
