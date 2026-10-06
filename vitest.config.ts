import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['{apps,packages,plugins}/**/*.{test,spec}.ts'],
    passWithNoTests: true,
  },
});
