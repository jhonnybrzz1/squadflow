import * as React from 'react';
import type { LucideIcon } from 'lucide-react';
import { Inbox } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

export interface EmptyStateProps extends React.HTMLAttributes<HTMLDivElement> {
  icon?: LucideIcon;
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
}

/**
 * Estado vazio padrão do Design System: ícone suave, título, descrição e
 * ação primária opcional. Usar no lugar de listas em branco.
 */
export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  actionLabel,
  onAction,
  className,
  children,
  ...props
}: EmptyStateProps) {
  return (
    <div
      role="status"
      className={cn(
        'flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-card/50 px-6 py-12 text-center',
        className,
      )}
      {...props}
    >
      <Icon className="h-8 w-8 text-muted-foreground/60" aria-hidden="true" />
      <p className="text-subtitle text-foreground">{title}</p>
      {description && <p className="max-w-sm text-body text-muted-foreground">{description}</p>}
      {actionLabel && onAction && (
        <Button className="mt-3" onClick={onAction}>
          {actionLabel}
        </Button>
      )}
      {children}
    </div>
  );
}
