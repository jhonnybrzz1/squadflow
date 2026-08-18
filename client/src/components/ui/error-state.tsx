import * as React from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

export interface ErrorStateProps extends React.HTMLAttributes<HTMLDivElement> {
  title?: string;
  description?: string;
  retryLabel?: string;
  onRetry?: () => void;
  retrying?: boolean;
}

/**
 * Estado de erro padrão do Design System, com ação de retry.
 * Usar quando um carregamento de dados falha, no lugar de tela em branco.
 */
export function ErrorState({
  title = 'Algo deu errado',
  description = 'Não foi possível carregar os dados. Tente novamente.',
  retryLabel = 'Tentar novamente',
  onRetry,
  retrying = false,
  className,
  children,
  ...props
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-6 py-12 text-center',
        className,
      )}
      {...props}
    >
      <AlertTriangle className="h-8 w-8 text-destructive" aria-hidden="true" />
      <p className="text-subtitle text-foreground">{title}</p>
      <p className="max-w-sm text-body text-muted-foreground">{description}</p>
      {onRetry && (
        <Button variant="outline" className="mt-3" onClick={onRetry} loading={retrying}>
          {!retrying && <RotateCcw className="mr-2 h-4 w-4" aria-hidden="true" />}
          {retryLabel}
        </Button>
      )}
      {children}
    </div>
  );
}
