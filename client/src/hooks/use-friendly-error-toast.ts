import { useEffect, useRef } from 'react';
import { useToast } from '@/hooks/use-toast';
import { getFriendlyErrorFromException } from '@/lib/friendly-error';

/**
 * Exibe um toast amigável (PT-BR) quando `error` passa de ausente para presente.
 *
 * Notifica apenas uma vez por episódio de erro: enquanto o erro persistir
 * (ex.: retries/polling do React Query), nenhum toast adicional é emitido;
 * quando a consulta volta a funcionar (error limpo), o guard é resetado e um
 * novo episódio futuro volta a notificar.
 *
 * Introduzido pela spec 008 (US1) para eliminar falhas silenciosas ao carregar
 * demandas do histórico com rede indisponível — reutiliza o mapa central da
 * spec 005 via getFriendlyErrorFromException; nunca expõe texto técnico.
 */
export function useFriendlyErrorToast(error: unknown, options?: { title?: string }): void {
  const { toast } = useToast();
  const notifiedRef = useRef(false);
  const title = options?.title;

  useEffect(() => {
    if (!error) {
      notifiedRef.current = false;
      return;
    }
    if (notifiedRef.current) return;
    notifiedRef.current = true;

    const friendly = getFriendlyErrorFromException(error);
    toast({
      title: title ?? friendly.title,
      description: friendly.message,
      variant: 'destructive',
    });
  }, [error, title, toast]);
}
