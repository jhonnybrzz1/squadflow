/**
 * Demanda 10091 — menu "Discovery".
 *
 * Workspace no padrão do app: sidebar com os frameworks importados
 * (GET /api/pm-frameworks) + área principal. Estado inicial mostra o card de
 * boas-vindas explicando o agente PM; ao selecionar um framework, carrega o
 * conteúdo (GET /api/pm-frameworks/:slug) que serve de contexto ao agente.
 *
 * Os frameworks vêm de um clone local do repositório PMframeworks, importado
 * por `scripts/import-pmframeworks.ts` — sem GitHub API em runtime.
 */
import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { Compass, BookOpen, Send, Loader2, Plus } from 'lucide-react';
import { AgentMarkdown } from '@/components/governance/AgentMarkdown';
import { useToast } from '@/hooks/use-toast';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

interface FrameworkSummary {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  version: string | null;
  /** 'framework' (método de discovery) x 'report' (relatório do projeto). */
  category?: string;
}

interface Framework extends FrameworkSummary {
  content: string;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

function WelcomeCard() {
  return (
    <div className="rounded-lg border border-[var(--border)] p-6" data-testid="discovery-welcome">
      <Compass className="mb-3 h-7 w-7 text-[var(--accent-cyan)]" aria-hidden="true" />
      <h2 className="mb-2 text-base font-semibold">Agente de Product Discovery</h2>
      <p className="max-w-prose text-sm text-[var(--foreground-muted)]">
        Selecione um framework na barra lateral. O agente PM conduz você pelas etapas do método
        escolhido — uma pergunta por vez — para revelar o problema real antes de discutir solução.
      </p>
    </div>
  );
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface DiscoverySummary {
  problema_central: string;
  framework_aplicado: string;
  proximo_passo: string;
  contexto: string;
}

interface CompileHistResponse {
  summary: DiscoverySummary;
  framework: { slug: string; name: string };
  sessionId?: string;
  truncated: boolean;
  retried: boolean;
}

function formatHandoffDescription(summary: DiscoverySummary): string {
  return [
    `## Problema central`,
    summary.problema_central,
    ``,
    `## Framework aplicado`,
    summary.framework_aplicado,
    ``,
    `## Próximo passo`,
    summary.proximo_passo,
    ``,
    `## Contexto`,
    summary.contexto,
  ].join('\n');
}

export default function DiscoveryPage() {
  const [slug, setSlug] = useState<string | null>(null);
  // Demanda 10091: conversa com o agente PM sobre o framework selecionado.
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [pendingSummary, setPendingSummary] = useState<CompileHistResponse | null>(null);

  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const list = useQuery({
    queryKey: ['pm-frameworks'],
    queryFn: () => getJson<{ frameworks: FrameworkSummary[] }>('/api/pm-frameworks'),
    retry: false,
  });

  const selected = useQuery({
    queryKey: ['pm-framework', slug],
    queryFn: () => getJson<Framework>(`/api/pm-frameworks/${slug}`),
    enabled: !!slug,
    retry: false,
  });

  const frameworks = list.data?.frameworks ?? [];

  const chat = useMutation({
    mutationFn: async (message: string) => {
      const res = await fetch(`/api/pm-frameworks/${slug}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Envia só as últimas trocas: o histórico inteiro estoura o prompt.
        body: JSON.stringify({ message, history: messages.slice(-8) }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as { reply: string };
    },
    onSuccess: (data) => {
      setMessages((prev) => [...prev, { role: 'assistant', content: data.reply }]);
    },
  });

  const compile = useMutation({
    mutationFn: async (): Promise<CompileHistResponse> => {
      const res = await fetch('/api/discovery/compile-hist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages,
          framework: { slug: selected.data?.slug ?? '', name: selected.data?.name ?? '' },
          sessionId: crypto.randomUUID(),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `HTTP ${res.status}`);
      }
      return (await res.json()) as CompileHistResponse;
    },
    onSuccess: (data) => {
      if (!data.summary.problema_central?.trim() || !data.summary.proximo_passo?.trim()) {
        setPendingSummary(data);
        toast({
          title: 'Resumo incompleto',
          description:
            'A síntese gerada não contém todos os campos obrigatórios. Reveja antes de continuar.',
          variant: 'destructive',
        });
        return;
      }
      doHandoff(data);
    },
    onError: (error) => {
      toast({
        title: 'Falha ao compilar histórico',
        description: error instanceof Error ? error.message : 'Tente novamente.',
        variant: 'destructive',
      });
    },
  });

  const doHandoff = (data: CompileHistResponse) => {
    if (data.truncated) {
      toast({
        title: 'Histórico longo',
        description: 'A conversa foi resumida com as 10 mensagens mais recentes.',
      });
    } else {
      toast({
        title: 'Resumo gerado!',
        description: 'Redirecionando para Refinamento…',
      });
    }

    const payload = {
      description: formatHandoffDescription(data.summary),
      originMetadata: {
        frameworkName: data.framework.name,
        frameworkId: data.framework.slug,
        sessionId: data.sessionId,
      },
    };
    sessionStorage.setItem('discovery_handoff', JSON.stringify(payload));
    setLocation('/');
  };

  const send = () => {
    const text = input.trim();
    if (!text || chat.isPending) return;
    setMessages((prev) => [...prev, { role: 'user', content: text }]);
    setInput('');
    chat.mutate(text);
  };

  // Trocar de framework reinicia a conversa — o método mudou.
  const selectFramework = (next: string) => {
    setSlug(next);
    setMessages([]);
    setInput('');
  };

  return (
    <section className="mx-auto flex max-w-5xl gap-6 px-6 py-8" data-testid="discovery-page">
      <aside className="w-56 shrink-0">
        {/* Título da sidebar: deve ser <h2> para não outranciar o conteúdo principal (<h2>) */}
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--foreground-muted)]">
          Discovery
        </h2>
        {list.isLoading && <p className="text-xs text-[var(--foreground-muted)]">Carregando…</p>}
        {list.isError && (
          <p className="text-xs text-[var(--foreground-muted)]">
            Não foi possível carregar os frameworks.
          </p>
        )}
        {!list.isLoading && !list.isError && frameworks.length === 0 && (
          <p className="text-xs text-[var(--foreground-muted)]">
            Nenhum framework importado. Rode{' '}
            <code className="text-[11px]">scripts/import-pmframeworks.ts</code>.
          </p>
        )}
        {/* Agrupa por categoria: método de discovery x relatório do projeto. */}
        {(['framework', 'report'] as const).map((cat) => {
          const group = frameworks.filter((f) => (f.category ?? 'framework') === cat);
          if (group.length === 0) return null;
          return (
            <div key={cat} className="mb-3">
              <p className="mb-1 text-[10px] uppercase tracking-wide text-[var(--foreground-muted)] opacity-70">
                {cat === 'framework' ? 'Frameworks' : 'Relatórios'} ({group.length})
              </p>
              <ul className="space-y-1">
                {group.map((f) => (
                  <li key={f.slug}>
                    <button
                      type="button"
                      onClick={() => selectFramework(f.slug)}
                      className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm ${
                        slug === f.slug
                          ? 'bg-[var(--accent-cyan)]/15 text-[var(--foreground)]'
                          : 'text-[var(--foreground-muted)] hover:bg-white/5'
                      }`}
                    >
                      <BookOpen className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      {f.name}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </aside>

      <main className="min-w-0 flex-1">
        {!slug && <WelcomeCard />}
        {slug && selected.isLoading && (
          <p className="text-sm text-[var(--foreground-muted)]">Carregando framework…</p>
        )}
        {slug && selected.isError && (
          <p className="text-sm text-[var(--foreground-muted)]">
            Não foi possível carregar este framework.
          </p>
        )}
        {slug && selected.data && (
          <article>
            <h2 className="mb-1 text-lg font-semibold">{selected.data.name}</h2>
            {selected.data.description && (
              <p className="mb-4 text-sm text-[var(--foreground-muted)]">
                {selected.data.description}
              </p>
            )}
            <details className="mb-4">
              <summary className="cursor-pointer text-xs uppercase text-[var(--foreground-muted)]">
                Ver o método completo
              </summary>
              <div className="mt-2">
                <AgentMarkdown content={selected.data.content} />
              </div>
            </details>

            {/* Conversa com o agente PM usando este framework como método. */}
            <div className="rounded-lg border border-[var(--border)] p-3">
              <p className="mb-2 text-xs uppercase text-[var(--foreground-muted)]">
                Conversa com o agente PM
              </p>
              <ul className="mb-3 flex max-h-80 flex-col gap-3 overflow-y-auto" aria-live="polite">
                {messages.length === 0 && (
                  <li className="text-sm text-[var(--foreground-muted)]">
                    Descreva o problema que você quer investigar. O agente conduz pelas etapas do
                    método — uma pergunta por vez.
                  </li>
                )}
                {messages.map((m, i) => (
                  <li key={i} className={m.role === 'user' ? 'text-right' : ''}>
                    <span className="mb-0.5 block text-[10px] uppercase text-[var(--foreground-muted)]">
                      {m.role === 'user' ? 'Você' : 'Agente PM'}
                    </span>
                    {m.role === 'assistant' ? (
                      <AgentMarkdown content={m.content} />
                    ) : (
                      <span className="inline-block rounded bg-white/5 px-2 py-1 text-sm">
                        {m.content}
                      </span>
                    )}
                  </li>
                ))}
                {chat.isPending && (
                  <li className="flex items-center gap-2 text-sm text-[var(--foreground-muted)]">
                    <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" /> pensando…
                  </li>
                )}
                {chat.isError && (
                  <li className="text-sm text-[var(--foreground-muted)]">
                    Não foi possível falar com o agente agora. Tente de novo.
                  </li>
                )}
              </ul>
              <div className="flex gap-2">
                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      send();
                    }
                  }}
                  placeholder="Descreva o problema…"
                  aria-label="Mensagem para o agente PM"
                  className="min-w-0 flex-1 rounded border border-[var(--border)] bg-transparent px-2 py-1 text-sm"
                />
                <button
                  type="button"
                  onClick={send}
                  disabled={!input.trim() || chat.isPending}
                  className="inline-flex items-center gap-1 rounded border border-[var(--border)] px-2 py-1 text-sm disabled:opacity-50"
                  data-testid="discovery-send"
                >
                  <Send className="h-3.5 w-3.5" aria-hidden="true" /> Enviar
                </button>
              </div>
            </div>

            {/* Demanda 10196: FAB de handoff Discovery → Refinement. */}
            {messages.length > 0 && (
              <div className="fixed bottom-6 right-6 z-40 flex flex-col items-end gap-2">
                <button
                  type="button"
                  onClick={() => compile.mutate()}
                  disabled={compile.isPending}
                  title="Cria uma demanda com tag Discovery"
                  className="inline-flex items-center gap-2 rounded-full bg-[var(--accent-cyan)] px-4 py-3 text-sm font-medium text-[var(--background)] shadow-lg transition-opacity hover:opacity-90 disabled:opacity-50"
                  data-testid="discovery-handoff-fab"
                >
                  {compile.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  ) : (
                    <Plus className="h-4 w-4" aria-hidden="true" />
                  )}
                  Criar Demanda a partir desta Análise
                </button>
              </div>
            )}
          </article>
        )}
      </main>

      {/* Modal de confirmação quando o summary está incompleto. */}
      <Dialog open={!!pendingSummary} onOpenChange={() => setPendingSummary(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Resumo incompleto</DialogTitle>
            <DialogDescription>
              A síntese gerada não contém <strong>problema_central</strong> ou{' '}
              <strong>proximo_passo</strong>. Deseja continuar mesmo assim?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setPendingSummary(null)}>
              Cancelar
            </Button>
            <Button
              onClick={() => {
                if (pendingSummary) {
                  const data = pendingSummary;
                  setPendingSummary(null);
                  doHandoff(data);
                }
              }}
            >
              Continuar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
