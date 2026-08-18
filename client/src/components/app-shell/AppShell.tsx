import { useState, type ReactNode } from 'react';
import { Link, useLocation } from 'wouter';
import {
  ChevronRight,
  Menu,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Sun,
  Terminal,
} from 'lucide-react';

import { cn } from '@/lib/utils';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { useEnhancedTheme } from '@/components/ui/theme-provider';
import { GrafanaLink, CreditsBadge } from '@/components/header-links';
import { NAV_GROUPS, getShellBreadcrumb, isItemActive } from './nav-config';

const SIDEBAR_STORAGE_KEY = 'aichatflow.sidebar.collapsed';

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2 overflow-hidden">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
        <Terminal className="h-4 w-4" aria-hidden="true" />
      </div>
      {!compact && (
        <span className="whitespace-nowrap font-display text-base font-bold tracking-tight text-sidebar-foreground">
          AiChatFlow
        </span>
      )}
    </div>
  );
}

function NavList({ collapsed, onNavigate }: { collapsed: boolean; onNavigate?: () => void }) {
  const [location] = useLocation();

  return (
    <nav aria-label="Navegação principal" className="flex-1 overflow-y-auto px-2 py-4">
      {NAV_GROUPS.map((group) => (
        <div key={group.label} className="mb-4">
          {!collapsed && (
            <p className="px-3 pb-1 text-meta font-medium uppercase tracking-wider text-sidebar-foreground/70">
              {group.label}
            </p>
          )}
          <ul className="space-y-0.5">
            {group.items.map((item) => {
              const active = isItemActive(item, location);
              const Icon = item.icon;
              const baseClasses = cn(
                'flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors',
                collapsed && 'justify-center px-2',
                active
                  ? 'bg-sidebar-accent font-medium text-sidebar-primary'
                  : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
              );

              return (
                <li key={item.label}>
                  {item.href ? (
                    <Link
                      href={item.href}
                      onClick={onNavigate}
                      className={baseClasses}
                      aria-current={active ? 'page' : undefined}
                      title={collapsed ? item.label : undefined}
                    >
                      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                      {!collapsed && <span className="truncate">{item.label}</span>}
                    </Link>
                  ) : (
                    <span
                      className={cn(
                        baseClasses,
                        'cursor-default text-sidebar-foreground/60 hover:bg-transparent hover:text-sidebar-foreground/60',
                      )}
                      aria-disabled="true"
                      title={collapsed ? `${item.label} (planejado)` : undefined}
                    >
                      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                      {!collapsed && (
                        <>
                          <span className="truncate">{item.label}</span>
                          <span className="ml-auto rounded-full border border-sidebar-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
                            breve
                          </span>
                        </>
                      )}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function ShellBreadcrumb() {
  const [location] = useLocation();
  const parts = getShellBreadcrumb(location);
  if (parts.length === 0) return null;

  return (
    <nav aria-label="Localização atual" className="min-w-0">
      <ol className="flex items-center gap-1.5 text-sm text-muted-foreground">
        {parts.map((part, index) => {
          const isLast = index === parts.length - 1;
          return (
            <li key={part} className="flex min-w-0 items-center gap-1.5">
              {index > 0 && <ChevronRight className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
              <span
                aria-current={isLast ? 'page' : undefined}
                className={cn('truncate', isLast && 'font-medium text-foreground')}
              >
                {part}
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function readCollapsedPreference(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === 'true';
  } catch (_) {
    return false;
  }
}

/**
 * Shell de navegação da demanda 10024: Sidebar fixa (desktop), Sheet (mobile/
 * tablet <1024px) e Topbar com breadcrumb + ações globais (telemetria, saldo,
 * tema). Envolve todas as rotas — as páginas continuam donas do conteúdo.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(readCollapsedPreference);
  const [mobileOpen, setMobileOpen] = useState(false);
  const { toggleTheme, isDarkMode } = useEnhancedTheme();

  const toggleCollapsed = () => {
    setCollapsed((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(next));
      } catch (_) {
        // preferências são best-effort
      }
      return next;
    });
  };

  return (
    <div className="flex min-h-screen">
      {/* Skip navigation */}
      <a
        href="#main-content"
        className="skip-link absolute left-[-9999px] top-4 z-[100] rounded border-2 border-[var(--accent-cyan)] bg-[var(--background)] px-4 py-2 font-mono text-sm font-bold text-[var(--accent-cyan)] focus:left-4 focus:outline-none"
      >
        Pular para conteúdo principal
      </a>

      {/* Sidebar desktop */}
      <aside
        className={cn(
          'sticky top-0 hidden h-screen shrink-0 flex-col border-r border-sidebar-border bg-sidebar lg:flex',
          collapsed ? 'w-[68px]' : 'w-64',
        )}
      >
        <div
          className={cn(
            'flex h-14 items-center border-b border-sidebar-border px-4',
            collapsed && 'justify-center px-2',
          )}
        >
          <Brand compact={collapsed} />
        </div>
        <NavList collapsed={collapsed} />
        <div className="border-t border-sidebar-border p-2">
          <button
            type="button"
            onClick={toggleCollapsed}
            className="flex min-h-[44px] w-full min-w-[44px] items-center justify-center gap-2 rounded-md px-3 py-2 text-sm text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
            aria-label={collapsed ? 'Expandir menu lateral' : 'Recolher menu lateral'}
            aria-expanded={!collapsed}
          >
            {collapsed ? (
              <PanelLeftOpen className="h-4 w-4" aria-hidden="true" />
            ) : (
              <>
                <PanelLeftClose className="h-4 w-4" aria-hidden="true" />
                <span>Recolher</span>
              </>
            )}
          </button>
        </div>
      </aside>

      {/* Conteúdo + Topbar */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="safe-area-header sticky top-0 z-50 flex h-14 items-center gap-3 border-b border-border bg-background/95 px-4 backdrop-blur-sm">
          {/* Menu mobile/tablet */}
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <button
                type="button"
                className="flex h-11 min-h-[44px] w-11 min-w-[44px] items-center justify-center rounded-md border border-border text-foreground hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 lg:hidden"
                aria-label="Abrir menu de navegação"
              >
                <Menu className="h-5 w-5" aria-hidden="true" />
              </button>
            </SheetTrigger>
            <SheetContent side="left" className="w-72 border-sidebar-border bg-sidebar p-0">
              <SheetTitle className="sr-only">Menu de navegação</SheetTitle>
              <div className="flex h-14 items-center border-b border-sidebar-border px-4">
                <Brand />
              </div>
              <NavList collapsed={false} onNavigate={() => setMobileOpen(false)} />
            </SheetContent>
          </Sheet>

          <div className="lg:hidden">
            <Brand compact />
          </div>

          <ShellBreadcrumb />

          <div className="ml-auto flex items-center gap-2">
            <GrafanaLink />
            <CreditsBadge />
            <button
              onClick={toggleTheme}
              className="flex h-11 min-h-[44px] w-11 min-w-[44px] items-center justify-center rounded-md border border-border text-foreground transition-colors hover:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
              aria-label={isDarkMode ? 'Ativar modo claro' : 'Ativar modo escuro'}
              aria-pressed={isDarkMode}
            >
              {isDarkMode ? (
                <Sun className="h-5 w-5" aria-hidden="true" />
              ) : (
                <Moon className="h-5 w-5" aria-hidden="true" />
              )}
            </button>
          </div>
        </header>

        <main id="main-content" className="flex-1">
          {children}
        </main>
      </div>
    </div>
  );
}
