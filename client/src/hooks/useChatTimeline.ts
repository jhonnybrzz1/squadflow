import { useState, useTransition, useOptimistic } from 'react';
import { type ChatMessage } from '@shared/schema';
import { api } from '@/lib/api';
import { useToast } from './use-toast';

interface UseChatTimelineProps {
  initialMessages: ChatMessage[];
  refinementId?: string | number;
}

export function useChatTimeline({ initialMessages, refinementId }: UseChatTimelineProps) {
  const { toast } = useToast();

  const [optimisticMessages, addOptimisticMessage] = useOptimistic<ChatMessage[], ChatMessage>(
    initialMessages,
    (state, newMessage) => {
      if (newMessage.agent !== 'user') {
        console.warn(
          '[useChatTimeline] useOptimistic was called for a non-user message:',
          newMessage,
        );
      }
      return [...state, newMessage];
    },
  );
  const [isPending, startTransition] = useTransition();
  const [isPaused, setIsPaused] = useState(false);

  // Use optimistic messages directly
  const messages = optimisticMessages;

  const submitUserResponse = async (message: string, interactionId?: string, sequence?: number) => {
    if (!refinementId) return { success: false, error: 'No active refinement' };

    const newMessage: ChatMessage = {
      id: `optimistic-${Date.now()}`,
      agent: 'user',
      message,
      timestamp: new Date().toISOString(),
      type: 'completed',
      category: 'system',
    };

    return new Promise<void>((resolve, reject) => {
      startTransition(async () => {
        addOptimisticMessage(newMessage);
        try {
          if (interactionId && sequence !== undefined) {
            await api.refinement.submitAnswer(
              String(refinementId),
              interactionId,
              sequence,
              message,
            );
          } else {
            // Normal chat push if applicable
            console.warn(
              '[useChatTimeline] submitUserResponse called without interactionId/sequence, normal chat push not yet supported',
            );
          }
          resolve();
        } catch (error) {
          toast({
            title: 'Erro no envio',
            description: 'Falha ao enviar sua mensagem. Tente novamente.',
            variant: 'destructive',
          });
          console.error('[useChatTimeline] Failed to submit user response', error);
          reject(error);
        }
      });
    });
  };

  const pauseTimeline = async () => {
    if (!refinementId) return;
    setIsPaused(true);
    try {
      await api.refinement.pause(String(refinementId));
    } catch (_e) {
      setIsPaused(false);
      toast({
        title: 'Erro',
        description: 'Não foi possível pausar.',
        variant: 'destructive',
      });
    }
  };

  const resumeTimeline = async () => {
    if (!refinementId) return;
    try {
      await api.refinement.resume(String(refinementId));
      setIsPaused(false);
    } catch (_e) {
      toast({
        title: 'Erro',
        description: 'Não foi possível retomar.',
        variant: 'destructive',
      });
    }
  };

  return {
    messages,
    isPending,
    isPaused,
    submitUserResponse,
    pauseTimeline,
    resumeTimeline,
  };
}
