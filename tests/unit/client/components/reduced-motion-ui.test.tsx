/** @vitest-environment jsdom */
import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '../../../../client/src/components/ui/dialog';
import { ReducedMotionPortal } from '../../../../client/src/components/ui/reduced-motion-portal';
import { useReducedMotion } from '../../../../client/src/hooks/useReducedMotion';

type MatchMediaController = {
  media: string;
  matches: boolean;
  listeners: Set<(event: MediaQueryListEvent) => void>;
  dispatch: (matches: boolean) => void;
};

function installMatchMedia(initialMatches: boolean) {
  const controller: MatchMediaController = {
    media: '(prefers-reduced-motion: reduce)',
    matches: initialMatches,
    listeners: new Set(),
    dispatch(matches) {
      controller.matches = matches;
      const event = { matches, media: controller.media } as MediaQueryListEvent;
      controller.listeners.forEach((listener) => listener(event));
    },
  };

  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: controller.matches,
      media: query,
      onchange: null,
      addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
        controller.listeners.add(listener);
      },
      removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => {
        controller.listeners.delete(listener);
      },
      addListener: (listener: (event: MediaQueryListEvent) => void) => {
        controller.listeners.add(listener);
      },
      removeListener: (listener: (event: MediaQueryListEvent) => void) => {
        controller.listeners.delete(listener);
      },
      dispatchEvent: vi.fn(),
    })),
  });

  return controller;
}

function ReducedMotionProbe() {
  const reduced = useReducedMotion();
  return <span>{reduced ? 'reduce' : 'full'}</span>;
}

describe('reduced motion UI support', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('tracks prefers-reduced-motion changes reactively', async () => {
    const controller = installMatchMedia(false);

    render(<ReducedMotionProbe />);
    expect(screen.getByText('full')).toBeTruthy();

    controller.dispatch(true);

    await waitFor(() => {
      expect(screen.getByText('reduce')).toBeTruthy();
    });
  });

  it('marks portalized content when reduced motion is active', async () => {
    installMatchMedia(true);

    render(
      <ReducedMotionPortal>
        <div>Portalized content</div>
      </ReducedMotionPortal>,
    );

    await waitFor(() => {
      const wrapper = document.body.querySelector('[data-reduced-motion="true"]');
      expect(wrapper?.textContent).toContain('Portalized content');
    });
  });

  it('uses the reduced-motion portal wrapper for dialog content', async () => {
    installMatchMedia(true);

    render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>Preferencia reduzida</DialogTitle>
          <DialogDescription>Descricao de suporte</DialogDescription>
        </DialogContent>
      </Dialog>,
    );

    await waitFor(() => {
      const wrapper = document.body.querySelector('[data-reduced-motion="true"]');
      expect(wrapper?.textContent).toContain('Preferencia reduzida');
    });
  });
});
