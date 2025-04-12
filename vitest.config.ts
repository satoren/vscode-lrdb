import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['**/__tests__/**/?(*.)+(spec|test).+(ts|tsx|js)', '**/?(*.)+(spec|test).+(ts|tsx|js)'],
    exclude: ['**/dist/**/*', '**/out/**/*', '**/node_modules/'],
    coverage: {
      include: [
        '**/src/**/*.{js,jsx,ts,tsx}',
      ],
      exclude: [
        '**/node_modules/',
        '**/__tests__/**',
        '**/__mocks__/**',
        '**/examples/**',
        '**/examples-*/**',
      ],
    },
    alias: {
      '~': path.resolve(__dirname, './')
    },
  },
});