import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx,js,jsx}'],
    exclude: [
      'tests/a11y/**',
      'node_modules/**',
      'dist/**',
      'documents/**',
      'uploads/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
    ],
    watch: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json'],
      all: true,
      reportsDirectory: './coverage',
      reportOnFailure: true,
    },
  },
  server: {
    watch: {
      ignored: [
        '**/documents/**',
        '**/uploads/**',
        '**/coverage/**',
        '**/playwright-report/**',
        '**/test-results/**',
      ],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './client/src'),
      '@shared': path.resolve(__dirname, './shared'),
    },
  },
});
