import { useToast } from '@/hooks/use-toast';
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from '@/components/ui/toast';

export function Toaster() {
  const { toasts } = useToast();

  return (
    <ToastProvider>
      {toasts.map(function ({ id, title, description, action, ...props }) {
        const toastAnnouncementKey = `${id}-${String(title ?? '')}-${String(description ?? '')}`;

        return (
          <Toast key={toastAnnouncementKey} {...props}>
            <div className="grid gap-1">
              {title && <ToastTitle>{title}</ToastTitle>}
              {description && <ToastDescription>{description}</ToastDescription>}
            </div>
            {action}
            <ToastClose />
          </Toast>
        );
      })}
      <ToastViewport
        data-testid="toast-live-region"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      />
    </ToastProvider>
  );
}
