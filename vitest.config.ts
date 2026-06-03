import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  esbuild: {
    // React 17+ automatic JSX runtime — no `import React` needed in .tsx files.
    jsx: 'automatic',
  },
  resolve: {
    alias: {
      // Only used by the dashboard; no other workspace package collides on `@/`.
      '@': resolve(__dirname, 'apps/dashboard/src'),
    },
  },
  test: {
    globals: false,
    environment: 'node',
    include: ['**/*.test.ts', '**/*.test.tsx'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**'],
    environmentMatchGlobs: [
      ['apps/dashboard/**/*.test.tsx', 'jsdom'],
      ['apps/dashboard/**/*.test.ts', 'jsdom'],
    ],
  },
});
