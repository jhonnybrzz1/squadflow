/**
 * Card de Segurança (Admin) — expõe os toggles operacionais de guardrails
 * em linguagem simples. Autenticação foi removida: projeto roda apenas localmente.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getFriendlyErrorFromException } from '@/lib/friendly-error';
import { ShieldCheck, Loader2, Check, X } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';

interface FeatureFlag {
  key: string;
  label: string;
  description: string;
  enabled: boolean;
  overridden: boolean;
}

export function SecuritySettingsCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const {
    data: flagsData,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['adminFeatureFlags'],
    queryFn: () => api.admin.featureFlags.list(),
    retry: false,
  });

  const toggleMutation = useMutation({
    mutationFn: ({ key, enabled }: { key: string; enabled: boolean }) =>
      api.admin.featureFlags.set(key, enabled),
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: ['adminFeatureFlags'] });
      toast({
        title: updated.enabled ? 'Proteção ativada' : 'Proteção desativada',
        description: updated.label,
      });
    },
    onError: (err: Error) => {
      console.error('Erro ao alterar configuração de segurança:', err);
      toast({
        title: 'Não foi possível alterar',
        description: getFriendlyErrorFromException(err).message,
        variant: 'destructive',
      });
    },
  });

  const flags: FeatureFlag[] = flagsData?.flags ?? [];

  return (
    <Card className="border-[var(--border)]">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 font-mono uppercase tracking-wider text-base">
          <ShieldCheck className="h-5 w-5 text-[var(--accent-cyan)]" />
          Segurança
        </CardTitle>
        <CardDescription className="font-mono text-xs">Proteções do assistente.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {isLoading ? (
          <div className="flex items-center gap-2 font-mono text-xs text-[var(--foreground-muted)]">
            <Loader2 className="h-4 w-4 animate-spin" /> Carregando proteções...
          </div>
        ) : error ? (
          <p className="font-mono text-xs text-[var(--destructive)]">
            Não foi possível carregar as proteções.
          </p>
        ) : (
          <div className="space-y-4">
            {flags.map((flag) => {
              const pending =
                toggleMutation.isPending && toggleMutation.variables?.key === flag.key;
              return (
                <div
                  key={flag.key}
                  className="flex items-start justify-between gap-4 border border-[var(--border)] p-3 rounded-md"
                >
                  <div className="space-y-1">
                    <p className="font-mono text-sm font-semibold">{flag.label}</p>
                    <p className="font-mono text-[11px] text-[var(--foreground-muted)]">
                      {flag.description}
                    </p>
                  </div>
                  <Button
                    variant={flag.enabled ? 'default' : 'outline'}
                    size="sm"
                    disabled={pending}
                    onClick={() => toggleMutation.mutate({ key: flag.key, enabled: !flag.enabled })}
                    className="font-mono shrink-0 min-w-[110px]"
                    aria-pressed={flag.enabled}
                  >
                    {pending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : flag.enabled ? (
                      <>
                        <Check className="h-4 w-4 mr-1" /> Ativado
                      </>
                    ) : (
                      <>
                        <X className="h-4 w-4 mr-1" /> Desativado
                      </>
                    )}
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
