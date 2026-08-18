export type BreadcrumbStatus = 'ready' | 'loading' | 'error' | 'denied';

export type BreadcrumbMapItem = {
  label: string;
  href?: string;
  status?: BreadcrumbStatus;
};

const breadcrumbMap: Record<string, BreadcrumbMapItem[]> = {
  '/admin/dashboard': [{ label: 'Admin' }, { label: 'Dashboard' }],
  '/admin/metricas-anti': [
    { label: 'Admin', href: '/admin/dashboard' },
    { label: 'Métricas Anti-Overengineering' },
  ],
  '/admin/retention': [
    { label: 'Admin', href: '/admin/dashboard' },
    { label: 'Retenção de Dados' },
  ],
};

export function getBreadcrumbItems(path: string): BreadcrumbMapItem[] {
  if (!path.startsWith('/admin/')) {
    return [];
  }

  return (
    breadcrumbMap[path] ?? [
      { label: 'Admin', href: '/admin/dashboard' },
      { label: '?', status: 'error' },
    ]
  );
}
