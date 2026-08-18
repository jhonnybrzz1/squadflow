/**
 * Demanda 10194 — Unificação dos Backlogs: Specs × Atividades.
 *
 * Página única com abas para o catálogo de specs e atividades do handoff.
 * A aba ativa é controlada pelo query param ?tab=specs|activities.
 * A rota antiga /admin/backlog/activities redireciona para /admin/backlog?tab=activities.
 */
import { useEffect, useState } from 'react';
import { useLocation } from 'wouter';
import { ListChecks, Activity } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import BacklogSpecsView from '@/pages/backlog';
import BacklogActivitiesView from '@/pages/backlog-activities';

type BacklogTab = 'specs' | 'activities';

const VALID_TABS: BacklogTab[] = ['specs', 'activities'];

function getTabFromSearch(search: string): BacklogTab {
  const params = new URLSearchParams(search);
  const tab = params.get('tab');
  return VALID_TABS.includes(tab as BacklogTab) ? (tab as BacklogTab) : 'specs';
}

export default function BacklogUnifiedPage() {
  const [, setLocation] = useLocation();
  const [tab, setTab] = useState<BacklogTab>(() => getTabFromSearch(window.location.search));

  useEffect(() => {
    const onUrlChange = () => {
      setTab(getTabFromSearch(window.location.search));
    };

    // Wouter does not expose search params; listen to popstate and manual updates.
    window.addEventListener('popstate', onUrlChange);
    onUrlChange();

    // Ensure the default tab is reflected in the URL on first load.
    const params = new URLSearchParams(window.location.search);
    if (!params.get('tab')) {
      params.set('tab', 'specs');
      setLocation(`/admin/backlog?${params.toString()}`, { replace: true });
    }

    return () => window.removeEventListener('popstate', onUrlChange);
  }, [setLocation]);

  const handleTabChange = (value: string) => {
    const params = new URLSearchParams(window.location.search);
    params.set('tab', value);
    setLocation(`/admin/backlog?${params.toString()}`, { replace: true });
    setTab(value as BacklogTab);
  };

  return (
    <section className="mx-auto max-w-5xl px-6 py-8" data-testid="backlog-unified-page">
      <h1 className="mb-1 text-xl font-semibold text-[var(--foreground)]">Backlog</h1>
      <p className="mb-6 text-sm text-[var(--foreground-muted)]">
        Catálogo de specs e atividades do handoff.
      </p>

      <Tabs value={tab} onValueChange={handleTabChange} className="w-full">
        <TabsList className="mb-4">
          <TabsTrigger value="specs" className="gap-2">
            <ListChecks className="h-4 w-4" aria-hidden="true" />
            Catálogo de Specs
          </TabsTrigger>
          <TabsTrigger value="activities" className="gap-2">
            <Activity className="h-4 w-4" aria-hidden="true" />
            Atividades do Handoff
          </TabsTrigger>
        </TabsList>

        <TabsContent value="specs">
          <BacklogSpecsView />
        </TabsContent>

        <TabsContent value="activities">
          <BacklogActivitiesView />
        </TabsContent>
      </Tabs>
    </section>
  );
}
