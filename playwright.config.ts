// Tests de bout en bout : un vrai serveur (build de production) sur une base neuve, un vrai navigateur.
import { defineConfig } from '@playwright/test';

const PORT = 3100;

export default defineConfig({
  testDir: 'e2e',
  // Une seule base partagée entre les tests : exécution en série.
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure', screenshot: 'only-on-failure', locale: 'fr-FR' },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    // Base temporaire neuve et administrateur de test créés par le script avant le démarrage.
    command: 'node e2e/start-server.mjs',
    url: `http://localhost:${PORT}/healthz`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      NODE_ENV: 'production',
      ALLOW_INSECURE_HTTP: 'true',
      HOST: '127.0.0.1',
      PORT: String(PORT),
      PUBLIC_URL: `http://localhost:${PORT}`,
      DATA_DIR: process.env.E2E_DATA_DIR ?? '/tmp/notabene-e2e',
      E2E_ADMIN_EMAIL: 'admin@e2e.test',
      E2E_ADMIN_PASSWORD: 'Strong-e2e-pass-123',
      ENCRYPTION_KEY: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=',
      AUTH_LOCAL: 'true',
      SEED_DEMO: 'true',
      COLLAB_ENABLED: 'true',
      // Beaucoup de connexions depuis la même IP pendant la série de tests.
      AUTH_RATE_LIMIT_PER_MINUTE: '500',
      // Une seule IP et un seul compte pour toute la série, lancée vite : le plafond par défaut (600 requêtes par minute) est atteint.
      RATE_LIMIT_PER_MINUTE: '20000',
      LOG_LEVEL: 'warn',
    },
  },
});
