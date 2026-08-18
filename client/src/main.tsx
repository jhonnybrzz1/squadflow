import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import 'highlight.js/styles/github-dark.css';

// Suppress ResizeObserver loop completed with undelivered notifications error
// This is a known issue with recharts and some Radix UI components
if (typeof window !== 'undefined') {
  const isResizeObserverError = (e: any) =>
    e.message === 'ResizeObserver loop completed with undelivered notifications.' ||
    e.message === 'ResizeObserver loop limit exceeded';

  const originalHandler = window.onerror;
  window.onerror = (...args) => {
    if (isResizeObserverError({ message: args[0] })) {
      return true;
    }
    return originalHandler ? originalHandler(...args) : false;
  };

  window.addEventListener('error', (e) => {
    if (isResizeObserverError(e)) {
      e.stopImmediatePropagation();
    }
  });

  window.addEventListener('unhandledrejection', (e) => {
    if (isResizeObserverError(e.reason)) {
      e.stopImmediatePropagation();
    }
  });

  // Log non-Error throws (ex: Radix Select focus/animation) que o plugin
  // runtime-error-overlay converte em "(unknown runtime error)". Captura antes
  // do plugin para registrar o valor real no console para debug.
  window.addEventListener(
    'error',
    (e) => {
      if (e.error && !(e.error instanceof Error)) {
        console.warn('[non-Error throw]', {
          message: e.message,
          file: e.filename,
          line: e.lineno,
          value: e.error,
        });
      }
    },
    true,
  );
  window.addEventListener(
    'unhandledrejection',
    (e) => {
      if (e.reason && !(e.reason instanceof Error)) {
        console.warn('[non-Error rejection]', { value: e.reason });
      }
    },
    true,
  );
}

createRoot(document.getElementById('root')!).render(<App />);
