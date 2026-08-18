'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';
import { useReducedMotion } from '@/hooks/useReducedMotion';

interface ReducedMotionPortalProps {
  children: React.ReactNode;
  container?: Element | DocumentFragment | null;
}

export function ReducedMotionPortal({
  children,
  container,
}: ReducedMotionPortalProps): React.ReactPortal | null {
  const prefersReducedMotion = useReducedMotion();
  const [mounted, setMounted] = React.useState(false);

  React.useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return null;
  }

  return createPortal(
    <div data-reduced-motion={prefersReducedMotion ? 'true' : undefined}>{children}</div>,
    container ?? document.body,
  );
}
