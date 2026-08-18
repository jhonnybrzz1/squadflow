import React from 'react';
import { AlertCircle, AlertTriangle, Info, X } from 'lucide-react';

interface CustomDisclaimerProps {
  children: React.ReactNode;
  title?: string;
  variant?: 'info' | 'warning' | 'note';
  className?: string;
  showIcon?: boolean;
  closable?: boolean;
  onClose?: () => void;
}

const CustomDisclaimer: React.FC<CustomDisclaimerProps> = ({
  children,
  title = 'Importante',
  variant = 'info',
  className = '',
  showIcon = true,
  closable = false,
  onClose,
}) => {
  const variantConfig = {
    info: {
      borderClass: 'border-l-[var(--accent-cyan)]',
      textClass: 'text-[var(--accent-cyan)]',
      icon: Info,
    },
    warning: {
      borderClass: 'border-l-[var(--warning)]',
      textClass: 'text-[var(--warning)]',
      icon: AlertTriangle,
    },
    note: {
      borderClass: 'border-l-[var(--foreground-muted)]',
      textClass: 'text-[var(--foreground-muted)]',
      icon: AlertCircle,
    },
  };

  const config = variantConfig[variant];
  const Icon = config.icon;

  return (
    <div className={`border-l-4 bg-[var(--muted)] p-4 ${config.borderClass} ${className}`}>
      <div className="flex items-start gap-3">
        {showIcon && <Icon className={`w-5 h-5 flex-shrink-0 mt-0.5 ${config.textClass}`} />}
        <div className="flex-1 min-w-0">
          <h3 className={`font-mono text-xs font-bold mb-2 ${config.textClass}`}>
            {title.toUpperCase()}
          </h3>
          <div className="font-mono text-sm text-[var(--foreground-muted)]">{children}</div>
        </div>
        {closable && onClose && (
          <button
            onClick={onClose}
            className="w-6 h-6 flex items-center justify-center hover:bg-[var(--background)] transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
            aria-label="Fechar aviso"
          >
            <X className="w-4 h-4 text-[var(--foreground-muted)]" />
          </button>
        )}
      </div>
    </div>
  );
};

export default CustomDisclaimer;
