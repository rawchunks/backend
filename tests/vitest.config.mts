import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  resolve: { alias: {
    '@': fileURLToPath(new URL('../../app/src', import.meta.url)),
    '@vitest/coverage-v8': fileURLToPath(new URL('./node_modules/@vitest/coverage-v8/dist/index.js', import.meta.url)),
  } },
  test: {
    include: ['tests/{unit,gates,infrastructure,stress,live}/**/*.test.ts'],
    setupFiles: ['tests/support/offline.ts'],
    testTimeout: 10000,
    hookTimeout: 10000,
    restoreMocks: true,
    clearMocks: true,
    pool: 'forks',
    maxWorkers: 4,
    coverage: {
      provider: 'v8',
      include: ['index.ts', 'broker/**/*.ts', 'databases/**/*.ts', 'generation/**/*.ts', 'editing/**/*.ts', 'voice/**/*.ts', 'storage/**/*.ts'],
      exclude: ['**/*.d.ts'],
      reportsDirectory: 'tests/coverage',
      reporter: ['text', 'json-summary', 'html'],
      reportOnFailure: true,
    },
  },
});
