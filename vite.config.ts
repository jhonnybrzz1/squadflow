import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import runtimeErrorOverlay from '@replit/vite-plugin-runtime-error-modal';

export default defineConfig({
  plugins: [
    react(),
    // Filtra "(unknown runtime error)" — lançamentos não-Error (ex: foco do
    // Radix Select ao fechar dropdown, animações CSS) que não têm stack útil.
    runtimeErrorOverlay({
      filter: (error) => error.message !== '(unknown runtime error)',
    }),
    ...(process.env.NODE_ENV !== 'production' && process.env.REPL_ID !== undefined
      ? [await import('@replit/vite-plugin-cartographer').then((m) => m.cartographer())]
      : []),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'client', 'src'),
      '@shared': path.resolve(import.meta.dirname, 'shared'),
    },
  },
  root: path.resolve(import.meta.dirname, 'client'),
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/public'),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // Spec 017 S3 (M-10/FR-008): vendors pesados fora do chunk de entrada.
        // Divisão por família estável — melhora cache e reduz o entry chunk;
        // orçamento verificado por scripts/bundle-budget.mjs.
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined;
          if (/react-markdown|remark|rehype|micromark|mdast|unist|hast|vfile/.test(id)) {
            return 'vendor-markdown';
          }
          if (id.includes('@radix-ui')) return 'vendor-radix';
          if (id.includes('@tanstack')) return 'vendor-query';
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return 'vendor-react';
          if (id.includes('lucide-react')) return 'vendor-icons';
          return undefined;
        },
      },
    },
  },
  server: {
    fs: {
      strict: true,
      deny: ['**/.*'],
    },
  },
});
