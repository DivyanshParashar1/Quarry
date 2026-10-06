import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['{apps,packages,plugins}/**/*.{test,spec}.ts'],
    globalSetup: ['./test/global-setup.ts'],
    passWithNoTests: true,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
