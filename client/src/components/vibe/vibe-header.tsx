/**
 * Demanda #10358 T6 — header global da plataforma pública.
 *
 * Renderiza logo, indicador de uso do Free Tier (T5) e ações de auth.
 * Não reutiliza o `AppShell` administrativo — a plataforma pública é uma
 * superfície visualmente separada (plan.md §"Camada aditiva isolada").
 */
import { Link } from 'wouter';
import { LogOut, Settings, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useVibeAuth } from '@/hooks/use-vibe-auth';
import { useVibeUsage } from '@/hooks/use-vibe-usage';
import { cn } from '@/lib/utils';

export function VibeHeader({ activeRoute }: { activeRoute?: 'landing' | 'app' | 'settings' }) {
  const { isAuthenticated, user, logout } = useVibeAuth();
  const { usage } = useVibeUsage({ enabled: isAuthenticated });

  const refinementsPct = usage
    ? Math.min(100, Math.round((usage.refinementsUsed / usage.refinementsLimit) * 100))
    : 0;
  const reposPct = usage
    ? Math.min(100, Math.round((usage.reposUsed / usage.reposLimit) * 100))
    : 0;

  return (
    <header className="sticky top-0 z-[--z-sticky] border-b border-white/10 bg-[--background]/80 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
        <Link
          href="/vibe"
          className="flex items-center gap-2 font-[--font-display] text-lg font-bold tracking-tight text-[--foreground]"
        >
          <span className="grid h-7 w-7 place-items-center rounded-md bg-[--accent-cyan] text-[--background]">
            <Zap className="h-4 w-4" aria-hidden="true" />
          </span>
          Vibe<span className="text-[--accent-cyan]">Flow</span>
        </Link>

        <nav className="flex items-center gap-3">
          {isAuthenticated ? (
            <>
              {usage && (
                <div
                  className="hidden items-center gap-3 rounded-md border border-white/10 bg-white/5 px-3 py-1.5 text-xs sm:flex"
                  title="Uso do plano gratuito no mês atual"
                >
                  <UsagePip
                    label="Refinamentos"
                    used={usage.refinementsUsed}
                    limit={usage.refinementsLimit}
                    pct={refinementsPct}
                  />
                  <UsagePip
                    label="Repos"
                    used={usage.reposUsed}
                    limit={usage.reposLimit}
                    pct={reposPct}
                  />
                </div>
              )}
              <span
                className="hidden text-xs text-[--foreground-muted] md:inline"
                title={user?.email}
              >
                {user?.email}
              </span>
              {activeRoute === 'landing' ? (
                <Button asChild size="sm" variant="default">
                  <Link href="/vibe/app">Abrir app</Link>
                </Button>
              ) : null}
              <Button asChild size="sm" variant="ghost" aria-label="Configurações">
                <Link href="/vibe/settings">
                  <Settings className="h-4 w-4" />
                  <span className="sr-only">Configurações</span>
                </Link>
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void logout()} aria-label="Sair">
                <LogOut className="h-4 w-4" />
                <span className="sr-only">Sair</span>
              </Button>
            </>
          ) : (
            <>
              <Button asChild size="sm" variant="ghost">
                <Link href="/vibe/login">Entrar</Link>
              </Button>
              <Button asChild size="sm" variant="default">
                <Link href="/vibe/signup">Criar conta</Link>
              </Button>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}

function UsagePip({
  label,
  used,
  limit,
  pct,
}: {
  label: string;
  used: number;
  limit: number;
  pct: number;
}) {
  const near = pct >= 80;
  return (
    <div className="flex items-center gap-1.5" title={`${label}: ${used}/${limit}`}>
      <span className="text-[--foreground-muted]">{label}</span>
      <span
        className={cn(
          'font-mono tabular-nums',
          near ? 'text-[--accent-orange]' : 'text-[--foreground]',
        )}
      >
        {used}/{limit}
      </span>
      <span
        className={cn(
          'h-1.5 w-10 overflow-hidden rounded-full bg-white/10',
          near && 'ring-1 ring-[--accent-orange]/40',
        )}
        aria-hidden="true"
      >
        <span
          className={cn(
            'block h-full rounded-full',
            near ? 'bg-[--accent-orange]' : 'bg-[--accent-cyan]',
          )}
          style={{ width: `${pct}%` }}
        />
      </span>
    </div>
  );
}
