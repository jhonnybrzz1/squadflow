import { useEffect, useState } from 'react';

/**
 * Reactively reports whether the user has requested reduced motion at the OS level
 * (`prefers-reduced-motion: reduce`).
 *
 * For pure CSS animations the global rule in `index.css` already handles the case.
 * Use this hook only when JS code needs to branch — for example to skip a
 * framer-motion transition, pause a `requestAnimationFrame` loop, or render a
 * static fallback for a Canvas/WebGL effect.
 *
 * SSR-safe: returns `false` until the component mounts on the client.
 */
export function useReducedMotion(): boolean {
  const [prefersReduced, setPrefersReduced] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }

    const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    setPrefersReduced(mql.matches);

    const onChange = (event: MediaQueryListEvent) => setPrefersReduced(event.matches);

    // addEventListener is the modern API; Safari <14 only supports addListener.
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    }
    mql.addListener(onChange);
    return () => mql.removeListener(onChange);
  }, []);

  return prefersReduced;
}
