/**
 * Demanda #10358 T3/T4/T6 — app principal da plataforma pública.
 * Demanda #10364 T6/T7 — dashboard de plano + banner de limite atingido.
 *
 * T3: textarea para prompt livre + campos opcionais (stack, tipo) + botão
 *     "Refinar" + área de resultado formatado.
 * T4: botão "Conectar GitHub" + seletor de repo opcional que adiciona
 *     contexto ao prompt.
 * T6: onboarding flow — após primeiro refinamento, oferece conexão Git.
 *     Estado de onboarding salvo em localStorage (Tasks.md).
 * #10364 T6: dashboard do usuário (plano atual, uso, próxima cobrança).
 * #10364 T7: banner inline de limite atingido com CTA de upgrade.
 *
 * Guarda de rota: se não autenticado, redireciona para /vibe/login.
 */
import { useEffect, useState } from 'react';
import { Link, Redirect } from 'wouter';
import {
  AlertCircle,
  CheckCircle2,
  Github,
  Loader2,
  ListChecks,
  Gauge,
  Sparkles,
  ArrowRight,
  CreditCard,
  TrendingUp,
  Wand2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { useVibeAuth } from '@/hooks/use-vibe-auth';
import { useVibeUsage } from '@/hooks/use-vibe-usage';
import { useVibePlan } from '@/hooks/use-vibe-plan';
import {
  vibeApi,
  type VibeRefinementResult,
  type VibeRepo,
  type VibePreviewResult,
} from '@/lib/vibe-api';
import { VibeHeader } from '@/components/vibe/vibe-header';
import { DbConnectionSelector } from '@/components/vibe/db-connection-selector';
import { ApiError } from '@/lib/api-error';
import { cn } from '@/lib/utils';

const ONBOARDING_KEY = 'vibe.onboarding';
const PROJECT_TYPES = ['Web App', 'API/Backend', 'CLI', 'Mobile', 'Biblioteca', 'Outro'];

interface OnboardingState {
  hasRefined: boolean;
  gitOffered: boolean;
  gitConnected: boolean;
}

function readOnboarding(): OnboardingState {
  try {
    const raw = localStorage.getItem(ONBOARDING_KEY);
    if (raw)
      return { hasRefined: false, gitOffered: false, gitConnected: false, ...JSON.parse(raw) };
  } catch {
    // ignore
  }
  return { hasRefined: false, gitOffered: false, gitConnected: false };
}

function writeOnboarding(s: OnboardingState) {
  try {
    localStorage.setItem(ONBOARDING_KEY, JSON.stringify(s));
  } catch {
    // ignore
  }
}

export default function VibeAppPage() {
  const { isAuthenticated } = useVibeAuth();
  const { usage, invalidate: invalidateUsage } = useVibeUsage({ enabled: true });
  const { plan, invalidate: invalidatePlan } = useVibePlan({ enabled: true });
  const { toast } = useToast();

  const [prompt, setPrompt] = useState('');
  const [stack, setStack] = useState('');
  const [projectType, setProjectType] = useState('');
  const [selectedRepo, setSelectedRepo] = useState<VibeRepo | null>(null);
  const [refining, setRefining] = useState(false);
  const [result, setResult] = useState<VibeRefinementResult | null>(null);
  const [resultError, setResultError] = useState<string | null>(null);

  const [onboarding, setOnboarding] = useState<OnboardingState>(readOnboarding);
  const [showGitOffer, setShowGitOffer] = useState(false);

  const [repos, setRepos] = useState<VibeRepo[]>([]);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [connectingGit, setConnectingGit] = useState(false);
  const [selectedDbConnectionId, setSelectedDbConnectionId] = useState<number | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewResult, setPreviewResult] = useState<VibePreviewResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewMicrocopy, setPreviewMicrocopy] = useState('');

  useEffect(() => {
    writeOnboarding(onboarding);
  }, [onboarding]);

  // Loga "platform_opened" uma vez por sessão (métrica de ativação T3).
  useEffect(() => {
    const sessionKey = 'vibe.analytics.platformOpened';
    if (!sessionStorage.getItem(sessionKey)) {
      sessionStorage.setItem(sessionKey, '1');
      void vibeApi.analytics.logPlatformOpened().catch(() => {
        // analytics é best-effort — não bloqueia o app
      });
    }
  }, []);

  // Callback OAuth: se voltou com ?git=connected, carrega repos.
  // Deve rodar antes do early return de auth (regras de hooks).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('git') === 'connected') {
      // limpa a URL
      window.history.replaceState({}, '', '/vibe/app');
      toast({ title: 'GitHub conectado!', description: 'Agora você pode selecionar um repo.' });
      void loadRepos();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!isAuthenticated) return <Redirect to="/vibe/login" replace />;

  async function handleRefine(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = prompt.trim();
    if (!trimmed) {
      toast({
        title: 'Prompt vazio',
        description: 'Descreva sua ideia para refinar.',
        variant: 'destructive',
      });
      return;
    }
    setRefining(true);
    setResultError(null);
    try {
      const res = await vibeApi.refinements.create({
        prompt: trimmed,
        stack: stack.trim() || undefined,
        projectType: projectType || undefined,
        repoContext: selectedRepo?.fullName || undefined,
        dbConnectionId: selectedDbConnectionId ?? undefined,
      });
      setResult(res);
      if (!onboarding.hasRefined) {
        setOnboarding((s) => ({ ...s, hasRefined: true }));
      }
      invalidateUsage();
      invalidatePlan();
      // T6: após o primeiro refinamento, oferece conexão Git.
      if (!onboarding.hasRefined && !onboarding.gitOffered) {
        setShowGitOffer(true);
        setOnboarding((s) => ({ ...s, gitOffered: true }));
      }
    } catch (err) {
      const message =
        err instanceof ApiError && err.status === 403
          ? 'Você atingiu o limite do plano gratuito. Faça upgrade para continuar.'
          : err instanceof ApiError && err.status === 429
            ? 'Muitos refinamentos em pouco tempo. Aguarde um minuto.'
            : 'Não foi possível refinar agora. Tente novamente.';
      setResultError(message);
    } finally {
      setRefining(false);
    }
  }

  async function handleConnectGithub() {
    setConnectingGit(true);
    try {
      const { authorizeUrl } = await vibeApi.git.getAuthorizeUrl();
      // OAuth flow: navega para GitHub, callback volta para /vibe/app?git=connected
      window.location.href = authorizeUrl;
    } catch {
      toast({
        title: 'Erro',
        description: 'Não foi possível iniciar a conexão GitHub.',
        variant: 'destructive',
      });
      setConnectingGit(false);
    }
  }

  async function loadRepos() {
    if (repos.length > 0) return;
    setLoadingRepos(true);
    try {
      const { repos: list } = await vibeApi.git.listRepos();
      setRepos(list);
      setOnboarding((s) => ({ ...s, gitConnected: true }));
    } catch (err) {
      const message =
        err instanceof ApiError && err.status === 401
          ? 'GitHub não conectado. Conecte primeiro.'
          : err instanceof ApiError && err.status === 403
            ? 'Limite de conexões Git atingido no plano gratuito.'
            : 'Não foi possível carregar seus repositórios.';
      toast({ title: 'Erro', description: message, variant: 'destructive' });
    } finally {
      setLoadingRepos(false);
    }
  }

  // #10366 T5 — Gerar preview automático do repo selecionado
  async function handleGeneratePreview() {
    if (!selectedRepo) return;
    setPreviewLoading(true);
    setPreviewError(null);
    setPreviewResult(null);
    setPreviewMicrocopy('Analisando estrutura...');

    const [owner, repoName] = selectedRepo.fullName.split('/');
    if (!owner || !repoName) {
      setPreviewError('Repositório inválido.');
      setPreviewLoading(false);
      return;
    }

    try {
      const { jobId } = await vibeApi.git.createPreview(owner, repoName);

      // Polling a cada 2s, timeout 30s
      const startTime = Date.now();
      const microcopySteps = [
        'Analisando estrutura...',
        'Identificando stack...',
        'Gerando sugestões...',
      ];

      const poll = async (): Promise<void> => {
        if (Date.now() - startTime > 30_000) {
          setPreviewError('Preview demorou muito. Use o prompt livre ou tente novamente.');
          setPreviewLoading(false);
          return;
        }

        const elapsed = Math.floor((Date.now() - startTime) / 10_000);
        setPreviewMicrocopy(microcopySteps[Math.min(elapsed, microcopySteps.length - 1)]);

        const status = await vibeApi.git.getPreviewStatus(owner, repoName, jobId);

        if (status.status === 'completed' && status.result) {
          setPreviewResult(status.result);
          setPreviewLoading(false);
          invalidateUsage();
          invalidatePlan();
        } else if (status.status === 'failed') {
          setPreviewError(status.error ?? 'Falha ao gerar preview.');
          setPreviewLoading(false);
        } else {
          await new Promise((r) => setTimeout(r, 2000));
          await poll();
        }
      };

      await poll();
    } catch (err) {
      const message =
        err instanceof ApiError && err.status === 403
          ? 'Limite de refinamentos atingido. Faça upgrade para continuar.'
          : err instanceof ApiError
            ? err.message
            : 'Erro ao gerar preview.';
      setPreviewError(message);
      setPreviewLoading(false);
    }
  }

  const refinementsLeft = usage
    ? Math.max(0, usage.refinementsLimit - usage.refinementsUsed)
    : null;
  const atLimit = refinementsLeft !== null && refinementsLeft === 0;
  const isPro = plan?.plan === 'pro';

  // T7: banner de limite atingido — só para Free que esgotou refinamentos
  const showLimitBanner = atLimit && !isPro;

  return (
    <div className="min-h-screen bg-[--background] text-[--foreground]">
      <VibeHeader activeRoute="app" />

      <main className="mx-auto max-w-3xl px-4 py-10">
        {/* Onboarding banner: primeiro refinamento feito → oferece Git */}
        {showGitOffer && !onboarding.gitConnected && (
          <div className="mb-6 flex flex-col gap-3 rounded-lg border border-[--accent-cyan]/30 bg-[--accent-cyan]/10 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <Sparkles
                className="mt-0.5 h-5 w-5 shrink-0 text-[--accent-cyan]"
                aria-hidden="true"
              />
              <div>
                <p className="font-medium">Quer enriquecer o próximo refinamento?</p>
                <p className="text-sm text-[--foreground-muted]">
                  Conecte seu GitHub (somente leitura) para adicionar contexto do seu repo.
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="ghost" onClick={() => setShowGitOffer(false)}>
                Agora não
              </Button>
              <Button
                size="sm"
                variant="default"
                className="gap-2"
                onClick={handleConnectGithub}
                disabled={connectingGit}
              >
                <Github className="h-4 w-4" />
                Conectar GitHub
              </Button>
            </div>
          </div>
        )}

        <h1 className="font-[--font-display] text-2xl font-bold sm:text-3xl">Refine sua ideia</h1>
        <p className="mt-2 text-sm text-[--foreground-muted]">
          Descreva o que você quer construir. A IA devolve uma descrição refinada, tarefas sugeridas
          e complexidade estimada.
        </p>

        {/* T7: Banner de limite atingido (Free que esgotou refinamentos) */}
        {showLimitBanner && (
          <div className="mt-4 flex flex-col gap-3 rounded-lg border border-[--accent-orange]/30 bg-[--accent-orange]/10 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <AlertCircle
                className="mt-0.5 h-5 w-5 shrink-0 text-[--accent-orange]"
                aria-hidden="true"
              />
              <div>
                <p className="font-medium text-[--accent-orange]">
                  Você usou seus 3 refinamentos gratuitos deste mês.
                </p>
                <p className="text-sm text-[--foreground-muted]">
                  Faça upgrade para o Pro e desbloqueie 30 refinamentos/mês + repos ilimitados.
                </p>
              </div>
            </div>
            <Link href="/vibe/upgrade">
              <Button size="sm" className="gap-2 whitespace-nowrap">
                <TrendingUp className="h-4 w-4" />
                Desbloquear 30 refinamentos/mês
              </Button>
            </Link>
          </div>
        )}

        {/* T6: Dashboard do usuário — plano atual, uso e próxima cobrança */}
        {plan && (
          <div className="mt-4 rounded-lg border border-white/10 bg-white/5 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <CreditCard className="h-4 w-4 text-[--foreground-muted]" aria-hidden="true" />
                <span className="text-sm font-medium">
                  Plano {isPro ? 'Pro' : 'Free'}
                  {isPro && plan.cancelAtPeriodEnd && (
                    <span className="ml-2 text-xs text-[--accent-orange]">
                      (cancelado — acesso até{' '}
                      {plan.currentPeriodEnd
                        ? new Date(plan.currentPeriodEnd).toLocaleDateString('pt-BR')
                        : 'fim do período'}
                      )
                    </span>
                  )}
                </span>
              </div>
              {!isPro && (
                <Link href="/vibe/upgrade">
                  <Button size="sm" variant="outline" className="gap-1.5">
                    <TrendingUp className="h-3.5 w-3.5" />
                    Fazer upgrade
                  </Button>
                </Link>
              )}
            </div>
            {plan.limits && (
              <div className="mt-3 grid gap-3 text-xs sm:grid-cols-2">
                <div>
                  <span className="text-[--foreground-muted]">Refinamentos: </span>
                  <span className="font-medium">
                    {plan.limits.refinements.used} /{' '}
                    {plan.limits.refinements.max === -1 ? '∞' : plan.limits.refinements.max}
                  </span>
                  {plan.limits.refinements.max > 0 && (
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-white/10">
                      <div
                        className="h-full rounded-full bg-[--accent-cyan] transition-all"
                        style={{
                          width: `${Math.min(100, (plan.limits.refinements.used / plan.limits.refinements.max) * 100)}%`,
                        }}
                      />
                    </div>
                  )}
                </div>
                <div>
                  <span className="text-[--foreground-muted]">Repos Git: </span>
                  <span className="font-medium">
                    {plan.limits.gitRepos.used} /{' '}
                    {plan.limits.gitRepos.max === -1 ? '∞' : plan.limits.gitRepos.max}
                  </span>
                </div>
              </div>
            )}
            {isPro && plan.currentPeriodEnd && !plan.cancelAtPeriodEnd && (
              <p className="mt-2 text-xs text-[--foreground-muted]">
                Próxima cobrança: {new Date(plan.currentPeriodEnd).toLocaleDateString('pt-BR')}
              </p>
            )}
          </div>
        )}

        {/* Free tier indicator inline */}
        {refinementsLeft !== null && (
          <div
            className={cn(
              'mt-4 inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-xs',
              atLimit
                ? 'bg-[--accent-orange]/15 text-[--accent-orange]'
                : 'bg-white/5 text-[--foreground-muted]',
            )}
          >
            {atLimit ? (
              <>
                <AlertCircle className="h-3.5 w-3.5" />
                Limite mensal atingido — faça upgrade para continuar.
              </>
            ) : (
              <>
                <Sparkles className="h-3.5 w-3.5 text-[--accent-cyan]" />
                {refinementsLeft} refinamento{refinementsLeft === 1 ? '' : 's'} restante
                {refinementsLeft === 1 ? '' : 's'} este mês.
              </>
            )}
          </div>
        )}

        {/* Refinement form */}
        <form onSubmit={handleRefine} className="mt-6 flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="vibe-prompt" className="text-sm font-medium">
              Sua ideia <span className="text-[--accent-magenta]">*</span>
            </label>
            <textarea
              id="vibe-prompt"
              required
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Ex: um app de notas que sincroniza entre desktop e mobile, com tags e busca rápida…"
              disabled={refining || atLimit}
              rows={5}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm"
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="vibe-stack" className="text-sm font-medium">
                Stack <span className="text-[--foreground-muted]">(opcional)</span>
              </label>
              <Input
                id="vibe-stack"
                value={stack}
                onChange={(e) => setStack(e.target.value)}
                placeholder="Ex: React, Node, SQLite"
                disabled={refining}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor="vibe-type" className="text-sm font-medium">
                Tipo <span className="text-[--foreground-muted]">(opcional)</span>
              </label>
              <select
                id="vibe-type"
                value={projectType}
                onChange={(e) => setProjectType(e.target.value)}
                disabled={refining}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm"
              >
                <option value="">Selecione…</option>
                {PROJECT_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Repo context selector (T4) */}
          {onboarding.gitConnected && (
            <div className="flex flex-col gap-1.5">
              <label htmlFor="vibe-repo" className="text-sm font-medium">
                Repositório GitHub{' '}
                <span className="text-[--foreground-muted]">(opcional, contexto)</span>
              </label>
              <div className="flex gap-2">
                <select
                  id="vibe-repo"
                  value={selectedRepo?.id ?? ''}
                  onChange={(e) => {
                    const id = Number(e.target.value);
                    setSelectedRepo(repos.find((r) => r.id === id) ?? null);
                  }}
                  disabled={refining || loadingRepos}
                  className="flex h-10 flex-1 rounded-md border border-input bg-background px-3 py-2 text-base ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm"
                >
                  <option value="">{loadingRepos ? 'Carregando…' : 'Sem repo'}</option>
                  {repos.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.fullName}
                    </option>
                  ))}
                </select>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={loadRepos}
                  disabled={loadingRepos}
                >
                  {loadingRepos ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Atualizar'}
                </Button>
              </div>
              {/* #10366 T5 — Botão "Gerar preview" do repo selecionado */}
              {selectedRepo && (
                <div className="mt-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="gap-2"
                    onClick={handleGeneratePreview}
                    disabled={previewLoading || refining || atLimit}
                  >
                    {previewLoading ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        {previewMicrocopy}
                      </>
                    ) : (
                      <>
                        <Wand2 className="h-4 w-4" />
                        Gerar preview automático
                      </>
                    )}
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* Git connect button (T4) — visível quando ainda não conectado */}
          {!onboarding.gitConnected && (
            <div className="flex items-center gap-3 rounded-md border border-white/10 bg-white/5 px-4 py-3 text-sm">
              <Github className="h-5 w-5 text-[--foreground-muted]" aria-hidden="true" />
              <span className="flex-1 text-[--foreground-muted]">
                Conecte GitHub para adicionar contexto de repo (somente leitura).
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="gap-2"
                onClick={handleConnectGithub}
                disabled={connectingGit}
              >
                {connectingGit ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Github className="h-4 w-4" />
                )}
                Conectar
              </Button>
            </div>
          )}

          {/* #10365 T5 — seletor de conexão de banco (opcional) */}
          <DbConnectionSelector
            selectedId={selectedDbConnectionId}
            onSelect={setSelectedDbConnectionId}
            disabled={refining || atLimit}
          />

          <Button
            type="submit"
            size="lg"
            disabled={refining || atLimit}
            className="mt-2 gap-2 self-start"
          >
            {refining ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Refinando…
              </>
            ) : (
              <>
                <Sparkles className="h-4 w-4" />
                Refinar ideia
              </>
            )}
          </Button>
        </form>

        {/* Error */}
        {resultError && (
          <div className="mt-6 flex items-start gap-3 rounded-lg border border-[--accent-orange]/30 bg-[--accent-orange]/10 p-4 text-sm">
            <AlertCircle
              className="mt-0.5 h-5 w-5 shrink-0 text-[--accent-orange]"
              aria-hidden="true"
            />
            <div>
              <p className="font-medium text-[--accent-orange]">Não foi possível refinar</p>
              <p className="text-[--foreground-muted]">{resultError}</p>
            </div>
          </div>
        )}

        {/* #10366 T5 — Preview Error */}
        {previewError && (
          <div className="mt-6 flex items-start gap-3 rounded-lg border border-[--accent-orange]/30 bg-[--accent-orange]/10 p-4 text-sm">
            <AlertCircle
              className="mt-0.5 h-5 w-5 shrink-0 text-[--accent-orange]"
              aria-hidden="true"
            />
            <div>
              <p className="font-medium text-[--accent-orange]">Preview falhou</p>
              <p className="text-[--foreground-muted]">{previewError}</p>
            </div>
          </div>
        )}

        {/* #10366 T5 — Preview Result */}
        {previewResult && (
          <div className="mt-8 space-y-6 rounded-lg border border-[--accent-purple]/30 bg-[--background-card] p-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-medium text-[--accent-purple]">
                <Wand2 className="h-4 w-4" />
                Preview automático
              </div>
              <Button
                size="sm"
                variant="outline"
                className="gap-2"
                onClick={() => {
                  // Sugestões clicáveis populam o campo de prompt
                  const features = previewResult.suggestedFeatures.join('\n- ');
                  setPrompt(
                    `Baseado na análise do repositório:\n\n- ${features}\n\nNotas de arquitetura: ${previewResult.architectureNotes}`,
                  );
                  setPreviewResult(null);
                }}
              >
                <ArrowRight className="h-4 w-4" />
                Usar como refinamento
              </Button>
            </div>

            {previewResult.suggestedFeatures.length > 0 && (
              <div>
                <p className="text-xs font-medium uppercase tracking-wider text-[--foreground-muted]">
                  Features sugeridas
                </p>
                <ul className="mt-2 space-y-1.5 text-sm">
                  {previewResult.suggestedFeatures.map((f, i) => (
                    <li
                      key={i}
                      className="cursor-pointer rounded px-2 py-1 hover:bg-white/5"
                      onClick={() => {
                        setPrompt(f);
                        setPreviewResult(null);
                      }}
                    >
                      • {f}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {previewResult.architectureNotes && (
              <div>
                <p className="text-xs font-medium uppercase tracking-wider text-[--foreground-muted]">
                  Notas de arquitetura
                </p>
                <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-[--foreground]">
                  {previewResult.architectureNotes}
                </p>
              </div>
            )}

            {previewResult.potentialBugs.length > 0 && (
              <div>
                <p className="text-xs font-medium uppercase tracking-wider text-[--foreground-muted]">
                  Bugs potenciais
                </p>
                <ul className="mt-2 space-y-1.5 text-sm">
                  {previewResult.potentialBugs.map((b, i) => (
                    <li key={i}>• {b}</li>
                  ))}
                </ul>
              </div>
            )}

            {previewResult.estimatedEffort && (
              <div>
                <p className="text-xs font-medium uppercase tracking-wider text-[--foreground-muted]">
                  Esforço estimado
                </p>
                <p className="mt-2 text-sm text-[--foreground]">{previewResult.estimatedEffort}</p>
              </div>
            )}
          </div>
        )}

        {/* Result */}
        {result && (
          <div className="mt-8 space-y-6 rounded-lg border border-[--accent-cyan]/30 bg-[--background-card] p-6">
            <div>
              <div className="flex items-center gap-2 text-sm font-medium text-[--accent-cyan]">
                <CheckCircle2 className="h-4 w-4" />
                Descrição refinada
              </div>
              <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-[--foreground]">
                {result.refinedDescription}
              </p>
            </div>

            {result.suggestedTasks.length > 0 && (
              <div>
                <div className="flex items-center gap-2 text-sm font-medium text-[--accent-cyan]">
                  <ListChecks className="h-4 w-4" />
                  Tarefas sugeridas
                </div>
                <ul className="mt-2 space-y-1.5">
                  {result.suggestedTasks.map((t, i) => (
                    <li key={i} className="flex items-start gap-2 text-sm text-[--foreground]">
                      <span className="mt-0.5 font-mono text-xs text-[--foreground-muted]">
                        {String(i + 1).padStart(2, '0')}
                      </span>
                      <span>{t}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div>
              <div className="flex items-center gap-2 text-sm font-medium text-[--accent-cyan]">
                <Gauge className="h-4 w-4" />
                Complexidade estimada
              </div>
              <p className="mt-2 text-sm text-[--foreground]">{result.estimatedComplexity}</p>
            </div>

            {/* Pós-refinamento: se ainda não conectou Git, lembra */}
            {!onboarding.gitConnected && !showGitOffer && (
              <div className="flex items-center justify-between border-t border-white/10 pt-4 text-sm">
                <span className="text-[--foreground-muted]">
                  Quer enriquecer com contexto do seu repo?
                </span>
                <Button
                  size="sm"
                  variant="link"
                  className="gap-1"
                  onClick={() => setShowGitOffer(true)}
                >
                  Conectar GitHub
                  <ArrowRight className="h-3 w-3" />
                </Button>
              </div>
            )}
          </div>
        )}

        {/* Footer link */}
        <p className="mt-10 text-center text-xs text-[--foreground-muted]">
          <Link href="/vibe" className="underline-offset-4 hover:underline">
            ← Voltar para a landing
          </Link>
        </p>
      </main>
    </div>
  );
}
