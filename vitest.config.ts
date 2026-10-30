import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['server/test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['server/src/**/*.ts'],
      reporter: ['text-summary', 'text'],
      // Garde-fou : la couverture ne doit pas baisser (mesurée à 76 % des instructions, 80 % des lignes, 65 % des branches, 82 % des fonctions).
      thresholds: { statements: 74, lines: 78, branches: 62, functions: 80 },
    },
  },
});
