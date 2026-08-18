import { lazy, Suspense } from 'react';
import { Loader2 } from 'lucide-react';
import { Switch, Route, Redirect, useLocation } from 'wouter';
import { queryClient } from './lib/queryClient';
import { QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import CustomDisclaimer from '@/components/ui/custom-disclaimer';
import Home from '@/pages/home';
import NotFound from '@/pages/not-found';
import { ThemeProvider } from 'next-themes';
import { EnhancedThemeProvider } from '@/components/ui/theme-provider';
import { ErrorBoundary } from '@/components/error-boundary';
import { AppShell } from '@/components/app-shell/AppShell';
// Demanda #10358: plataforma pública Vibe Coders — camada aditiva isolada
// (plan.md). Rotas /vibe/* vivem fora do AppShell administrativo e usam
// seu próprio provider de auth (JWT + localStorage, sem cookie de sessão).
import { VibeAuthProvider } from '@/hooks/use-vibe-auth';
const VibeLandingPage = lazy(() => import('@/pages/vibe/landing'));
const VibeAuthPage = lazy(() => import('@/pages/vibe/auth'));
const VibeAppPage = lazy(() => import('@/pages/vibe/app'));
const VibeUpgradePage = lazy(() => import('@/pages/vibe/upgrade'));
const VibeSettingsPage = lazy(() => import('@/pages/vibe/settings'));

const DomainReportPage = lazy(() => import('@/pages/domain-report'));
const DashboardPage = lazy(() => import('@/pages/dashboard'));
const AntiMetricsPage = lazy(() => import('@/pages/anti-metrics'));
const AdminRetentionPage = lazy(() => import('@/pages/admin-retention'));
const CostQualityPage = lazy(() => import('@/pages/cost-quality'));
const RetrospectivePage = lazy(() => import('@/pages/retrospective'));
// Demanda 10076: módulos habilitados no menu com placeholder "Em breve".
const ComingSoonPage = lazy(() => import('@/pages/coming-soon'));
// Demanda 10194: página unificada de backlog (Specs + Atividades).
const BacklogUnifiedPage = lazy(() => import('@/pages/backlog-unified'));
// Backlog de specs e atividades mantidos como componentes de aba.
const BacklogPage = lazy(() => import('@/pages/backlog'));
const BacklogActivitiesPage = lazy(() => import('@/pages/backlog-activities'));
// Demanda 10091: menu "Discovery" (frameworks de Product Discovery + agente PM).
const DiscoveryPage = lazy(() => import('@/pages/discovery'));
// Demanda 10082 (F3): Squad com o modelo ativo por agente (fecha o placeholder da 10076).
const SquadPage = lazy(() => import('@/pages/squad'));

function PageFallback() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-[60vh] flex-col items-center justify-center gap-3 font-mono text-sm text-[var(--foreground-muted)]"
    >
      <Loader2 className="h-5 w-5 animate-spin text-[var(--accent-cyan)]" aria-hidden="true" />
      <span>Carregando módulo…</span>
    </div>
  );
}

function SafeRoute({
  path,
  component: Component,
  name,
}: {
  path?: string;
  component: React.ComponentType;
  name: string;
}) {
  return (
    <Route path={path}>
      <ErrorBoundary componentName={name} dataSource="internal" errorType="route">
        <Component />
      </ErrorBoundary>
    </Route>
  );
}

function Router() {
  return (
    <Suspense fallback={<PageFallback />}>
      <Switch>
        <SafeRoute path="/" component={Home} name="Home" />
        <SafeRoute
          path="/domains/:domain/report"
          component={DomainReportPage}
          name="DomainReport"
        />
        <SafeRoute path="/admin/dashboard" component={DashboardPage} name="Dashboard" />
        <SafeRoute path="/admin/metricas-anti" component={AntiMetricsPage} name="AntiMetrics" />
        <SafeRoute path="/admin/retention" component={AdminRetentionPage} name="AdminRetention" />
        <SafeRoute path="/admin/cost-quality" component={CostQualityPage} name="CostQuality" />
        <SafeRoute path="/admin/retrospectiva" component={RetrospectivePage} name="Retrospective" />
        <SafeRoute path="/admin/squad" component={SquadPage} name="Squad" />
        <SafeRoute path="/admin/backlog" component={BacklogUnifiedPage} name="Backlog" />
        <Route path="/admin/backlog/activities">
          <Redirect to="/admin/backlog?tab=activities" replace />
        </Route>
        {/* Rotas legadas ainda carregáveis como componentes de aba. */}
        <SafeRoute path="/admin/backlog-specs-legacy" component={BacklogPage} name="BacklogSpecs" />
        <SafeRoute
          path="/admin/backlog-activities-legacy"
          component={BacklogActivitiesPage}
          name="BacklogActivities"
        />
        <SafeRoute path="/admin/discovery" component={DiscoveryPage} name="Discovery" />
        <SafeRoute path="/admin/orquestracoes" component={ComingSoonPage} name="ComingSoon" />
        <SafeRoute path="/admin/relatorios" component={ComingSoonPage} name="ComingSoon" />
        <SafeRoute component={NotFound} name="NotFound" />
      </Switch>
    </Suspense>
  );
}

/**
 * Demanda #10358 — router da plataforma pública Vibe Coders.
 *
 * Renderizado FORA do AppShell administrativo (plan.md §"Camada aditiva
 * isolada"). VibeAuthProvider envolve só estas rotas para não interferir
 * no estado do painel administrativo (que usa cookie de sessão, não JWT).
 */
function VibeRouter() {
  return (
    <VibeAuthProvider>
      <Suspense fallback={<PageFallback />}>
        <Switch>
          <Route path="/vibe/login">
            <ErrorBoundary componentName="VibeAuth" dataSource="internal" errorType="route">
              <VibeAuthPage />
            </ErrorBoundary>
          </Route>
          <Route path="/vibe/signup">
            <ErrorBoundary componentName="VibeAuth" dataSource="internal" errorType="route">
              <VibeAuthPage />
            </ErrorBoundary>
          </Route>
          <Route path="/vibe/app">
            <ErrorBoundary componentName="VibeApp" dataSource="internal" errorType="route">
              <VibeAppPage />
            </ErrorBoundary>
          </Route>
          <Route path="/vibe/upgrade">
            <ErrorBoundary componentName="VibeUpgrade" dataSource="internal" errorType="route">
              <VibeUpgradePage />
            </ErrorBoundary>
          </Route>
          <Route path="/vibe/settings">
            <ErrorBoundary componentName="VibeSettings" dataSource="internal" errorType="route">
              <VibeSettingsPage />
            </ErrorBoundary>
          </Route>
          <Route path="/vibe">
            <ErrorBoundary componentName="VibeLanding" dataSource="internal" errorType="route">
              <VibeLandingPage />
            </ErrorBoundary>
          </Route>
        </Switch>
      </Suspense>
    </VibeAuthProvider>
  );
}

/**
 * Painel administrativo — AppShell preservado, oculto quando a rota é /vibe/*
 * (a plataforma pública renderiza via VibeRouter, fora do AppShell).
 */
function AdminSurface() {
  const [location] = useLocation();
  if (location.startsWith('/vibe')) return null;
  return (
    <AppShell>
      <div className="flex min-h-full flex-col">
        <Router />
        <footer className="mt-auto">
          <CustomDisclaimer
            title="Sobre o AICHATflow"
            variant="note"
            className="border-0 rounded-none dark:border-darkBorder"
          >
            <p className="text-sm dark:text-[--muted-foreground]">
              Esta plataforma utiliza inteligência artificial para refinar demandas com colaboração
              entre agentes especializados. Os agentes trabalham juntos para entender completamente
              seu pedido antes de gerar documentos finais.
            </p>
          </CustomDisclaimer>
        </footer>
      </div>
    </AppShell>
  );
}

function App() {
  return (
    <ErrorBoundary componentName="App" dataSource="internal" errorType="system">
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
        <EnhancedThemeProvider>
          <QueryClientProvider client={queryClient}>
            <TooltipProvider>
              <Toaster />
              <div className="min-h-screen bg-background text-foreground dark:bg-[--background] dark:text-[--foreground]">
                {/* Plataforma pública /vibe/* — fora do AppShell (camada aditiva). */}
                <VibeRouter />
                {/* Painel administrativo — AppShell preservado, oculto em /vibe/*. */}
                <AdminSurface />
              </div>
            </TooltipProvider>
          </QueryClientProvider>
        </EnhancedThemeProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

export default App;
