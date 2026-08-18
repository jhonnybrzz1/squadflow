import { Link } from 'wouter';
import { ChevronRight, Loader2 } from 'lucide-react';

import { getBreadcrumbItems, type BreadcrumbMapItem } from '@/lib/breadcrumbMap';
import { cn } from '@/lib/utils';

type BreadcrumbsProps = {
  path: string;
  className?: string;
};

const statusLabels = {
  loading: 'Carregando página',
  error: 'Página temporariamente indisponível',
  denied: 'Acesso não permitido',
} as const;

function BreadcrumbLabel({ item }: { item: BreadcrumbMapItem }) {
  if (item.status === 'loading') {
    return (
      <span className="inline-flex items-center gap-1 text-gray-900">
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
        <span>{statusLabels.loading}</span>
      </span>
    );
  }

  if (item.status === 'error') {
    return (
      <span title={statusLabels.error} className="text-gray-900">
        ?
      </span>
    );
  }

  if (item.status === 'denied') {
    return (
      <span title={statusLabels.denied} aria-disabled="true" className="text-gray-500">
        {item.label}
      </span>
    );
  }

  return <span>{item.label}</span>;
}

export function Breadcrumbs({ path, className }: BreadcrumbsProps) {
  const items = getBreadcrumbItems(path);

  if (items.length === 0) {
    return null;
  }

  return (
    <nav
      role="navigation"
      aria-label="Navegação hierárquica"
      className={cn('mb-6 text-xs font-mono uppercase tracking-wider', className)}
    >
      <ol className="flex flex-wrap items-center gap-2">
        {items.map((item, index) => {
          const isLast = index === items.length - 1;
          const canLink = Boolean(item.href && !isLast && !item.status);

          return (
            <li key={`${item.label}-${index}`} className="flex items-center gap-2">
              {index > 0 && (
                <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 text-gray-500" />
              )}

              {canLink ? (
                <Link
                  href={item.href as string}
                  className="text-gray-700 underline-offset-4 hover:text-gray-900 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2"
                >
                  {item.label}
                </Link>
              ) : (
                <span
                  aria-current={isLast && !item.status ? 'page' : undefined}
                  className={cn(isLast && !item.status ? 'font-bold text-gray-900' : undefined)}
                >
                  <BreadcrumbLabel item={item} />
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
