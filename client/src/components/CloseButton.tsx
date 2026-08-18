import { X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type CloseButtonProps = {
  modalTitle: string;
  onClose: () => void;
  modalApi?: 'custom' | 'headlessui' | 'radix';
  className?: string;
};

export function CloseButton({ modalTitle, onClose, className }: CloseButtonProps) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={onClose}
      className={cn('absolute top-2 right-2 h-9 w-9', className)}
      aria-label={`Fechar modal ${modalTitle}`}
    >
      <X className="h-4 w-4" aria-hidden="true" />
    </Button>
  );
}
