import { useState, useEffect } from 'react';
import { MessageSquarePlus, Check, X, History, User, Clock } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import type { RefinementInteraction, RefinementInteractionInput } from '@shared/schema';

interface RefinementInteractionsProps {
  demandId: number;
}

export function RefinementInteractions({ demandId }: RefinementInteractionsProps) {
  const { toast } = useToast();
  const [interactions, setInteractions] = useState<RefinementInteraction[]>([]);
  const [isProposing, setIsOverposing] = useState(false);
  const [newProposal, setNewProposal] = useState({
    section: 'Requisitos',
    itemKey: '',
    justification: '',
    proposedValue: '',
  });

  const fetchInteractions = async () => {
    try {
      const response = await fetch(`/api/demands/${demandId}`);
      if (!response.ok) throw new Error('Failed to fetch demand');
      const data = await response.json();
      setInteractions(data.refinementInteractions || []);
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    fetchInteractions();
  }, [demandId]);

  const handleAction = async (
    action: RefinementInteractionInput['action'],
    data: Omit<RefinementInteractionInput, 'action'>,
  ) => {
    try {
      const response = await fetch(`/api/governance/demands/${demandId}/interactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...data, action }),
      });

      if (!response.ok) throw new Error('Action failed');

      toast({ title: 'Sucesso', description: `Ação ${action} registrada.` });
      fetchInteractions();
      setIsOverposing(false);
    } catch (_e) {
      toast({
        title: 'Erro',
        description: 'Não foi possível registrar a ação.',
        variant: 'destructive',
      });
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h3 className="font-mono text-xs font-bold flex items-center gap-2">
          <History className="w-4 h-4" />
          INTERAÇÕES DE REFINAMENTO
        </h3>
        <button
          onClick={() => setIsOverposing(true)}
          className="brutal-badge text-[10px] flex items-center gap-1 hover:bg-[var(--accent-cyan)] hover:text-white transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
        >
          <MessageSquarePlus className="w-3 h-3" />
          PROPOR
        </button>
      </div>

      {isProposing && (
        <div className="p-4 border-2 border-[var(--foreground)] bg-[var(--background)] shadow-[4px_4px_0px_var(--border)] space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label
                htmlFor="proposal-section"
                className="block font-mono text-[9px] font-bold uppercase mb-1"
              >
                Seção
              </label>
              <select
                id="proposal-section"
                name="section"
                value={newProposal.section}
                onChange={(e) => setNewProposal({ ...newProposal, section: e.target.value })}
                className="w-full bg-[var(--muted)] border border-[var(--border)] p-1 font-mono text-[10px]"
              >
                <option>Requisitos</option>
                <option>Critérios</option>
                <option>Dependências</option>
                <option>Decisões</option>
              </select>
            </div>
            <div>
              <label
                htmlFor="proposal-item-key"
                className="block font-mono text-[9px] font-bold uppercase mb-1"
              >
                ID do Item
              </label>
              <input
                id="proposal-item-key"
                name="itemKey"
                value={newProposal.itemKey}
                onChange={(e) => setNewProposal({ ...newProposal, itemKey: e.target.value })}
                className="w-full bg-[var(--muted)] border border-[var(--border)] p-1 font-mono text-[10px]"
                placeholder="Ex: RF-01"
              />
            </div>
          </div>
          <div>
            <label
              htmlFor="proposal-justification"
              className="block font-mono text-[9px] font-bold uppercase mb-1"
            >
              Justificativa
            </label>
            <textarea
              id="proposal-justification"
              name="justification"
              value={newProposal.justification}
              onChange={(e) => setNewProposal({ ...newProposal, justification: e.target.value })}
              className="w-full h-16 bg-[var(--muted)] border border-[var(--border)] p-1 font-mono text-[10px]"
            />
          </div>
          <div className="flex gap-2 justify-end">
            <button
              onClick={() => setIsOverposing(false)}
              className="px-3 py-1 font-mono text-[10px] border border-[var(--border)] hover:bg-[var(--muted)] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
            >
              CANCELAR
            </button>
            <button
              onClick={() => handleAction('PROPOSE', newProposal)}
              className="px-3 py-1 font-mono text-[10px] bg-[var(--foreground)] text-[var(--background)] hover:opacity-90 transition-opacity focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
            >
              ENVIAR
            </button>
          </div>
        </div>
      )}

      <div className="space-y-3 max-h-[400px] overflow-y-auto pr-2">
        {interactions.length === 0 && !isProposing && (
          <p className="font-mono text-[10px] text-[var(--foreground-muted)] text-center py-8">
            Nenhuma interação registrada.
          </p>
        )}

        {interactions.map((interaction) => (
          <div
            key={interaction.id}
            className="p-3 border border-[var(--border)] bg-[var(--muted)] relative group"
          >
            <div className="flex items-start justify-between mb-1">
              <span
                className={`text-[9px] font-mono font-bold px-1 py-0.5 border ${
                  interaction.action === 'PROPOSE'
                    ? 'border-[var(--accent-cyan)] text-[var(--accent-cyan)]'
                    : interaction.action === 'ACCEPT'
                      ? 'border-[var(--success)] text-[var(--success)]'
                      : 'border-[var(--destructive)] text-[var(--destructive)]'
                }`}
              >
                {interaction.action}
              </span>
              <div className="flex items-center gap-2 opacity-60">
                <div className="flex items-center gap-1">
                  <User className="w-3 h-3" />
                  <span className="text-[9px] font-mono">{interaction.author}</span>
                </div>
                <div className="flex items-center gap-1">
                  <Clock className="w-3 h-3" />
                  <span className="text-[9px] font-mono">
                    {new Date(interaction.timestamp).toLocaleTimeString([], {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </span>
                </div>
              </div>
            </div>

            <p className="font-mono text-[11px] font-bold mb-1">
              [{interaction.section}] {interaction.itemKey}
            </p>
            <p className="font-mono text-[10px] text-[var(--foreground-muted)] line-clamp-2 italic">
              "{interaction.justification}"
            </p>

            {interaction.action === 'PROPOSE' && (
              <div className="mt-3 flex gap-2">
                <button
                  onClick={() => handleAction('ACCEPT', interaction)}
                  className="flex-1 py-1 flex items-center justify-center gap-1 border border-[var(--success)] text-[var(--success)] hover:bg-[var(--success)] hover:text-white transition-colors font-mono text-[9px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
                >
                  <Check className="w-3 h-3" /> ACEITAR
                </button>
                <button
                  onClick={() => handleAction('REJECT', interaction)}
                  className="flex-1 py-1 flex items-center justify-center gap-1 border border-[var(--destructive)] text-[var(--destructive)] hover:bg-[var(--destructive)] hover:text-white transition-colors font-mono text-[9px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
                >
                  <X className="w-3 h-3" /> REJEITAR
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
