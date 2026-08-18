import type { LucideIcon } from 'lucide-react';
import {
  LayoutDashboard,
  MessagesSquare,
  BookOpenText,
  Activity,
  LineChart,
  Settings2,
  DatabaseZap,
  History,
  ListChecks,
  Compass,
  Bot,
} from 'lucide-react';

export type NavItem = {
  label: string;
  href?: string;
  icon: LucideIcon;
  /** Item planejado (sem rota própria neste incremento). */
  planned?: boolean;
  /** Marca o item ativo também em sub-rotas (prefix match). */
  matchPrefix?: string;
};

export type NavGroup = {
  label: string;
  items: NavItem[];
};

/**
 * Arquitetura de informação da demanda 10024 (Incremento 1).
 * Grupos sem página própria entram como "planejado" — nenhuma rota nova de
 * backend é criada aqui; rotas legadas continuam funcionais.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Visão Geral',
    items: [{ label: 'Dashboard', href: '/admin/dashboard', icon: LayoutDashboard }],
  },
  {
    label: 'Conversas',
    items: [{ label: 'Refinamento de demandas', href: '/', icon: MessagesSquare }],
  },
  {
    // Demanda 10194: menu "Backlog" unificado (Specs + Atividades em abas).
    label: 'Backlog',
    items: [
      {
        label: 'Backlog',
        href: '/admin/backlog',
        icon: ListChecks,
        matchPrefix: '/admin/backlog',
      },
      // Demanda 10082 (F3): squad real com o modelo ativo de cada agente.
      { label: 'Squad de agentes', href: '/admin/squad', icon: Bot },
    ],
  },
  {
    label: 'Workflows',
    items: [
      // Demanda 10091: 'Orquestrações' substituído por 'Discovery'.
      { label: 'Discovery', href: '/admin/discovery', icon: Compass },
      { label: 'Retrospectiva', href: '/admin/retrospectiva', icon: History },
    ],
  },
  {
    label: 'Conhecimento',
    items: [
      {
        label: 'Relatórios de domínio',
        href: '/admin/relatorios',
        icon: BookOpenText,
        matchPrefix: '/domains/',
      },
    ],
  },
  {
    label: 'Observabilidade',
    items: [
      { label: 'Métricas anti-overengineering', href: '/admin/metricas-anti', icon: Activity },
      { label: 'Custo × Qualidade', href: '/admin/cost-quality', icon: LineChart },
    ],
  },
  {
    label: 'Configurações',
    items: [{ label: 'Retenção de dados', href: '/admin/retention', icon: DatabaseZap }],
  },
];

export const SETTINGS_ICON = Settings2;

/** Breadcrumb do shell: Grupo > Item, derivado da IA acima. */
export function getShellBreadcrumb(path: string): string[] {
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      if (item.href === path) return [group.label, item.label];
      if (item.matchPrefix && path.startsWith(item.matchPrefix)) return [group.label, item.label];
    }
  }
  if (path === '/') return ['Conversas', 'Refinamento de demandas'];
  return [];
}

export function isItemActive(item: NavItem, path: string): boolean {
  if (item.href && item.href === path) return true;
  if (item.matchPrefix && path.startsWith(item.matchPrefix)) return true;
  return false;
}
