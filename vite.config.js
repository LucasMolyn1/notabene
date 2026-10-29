import { defineConfig } from 'vite';

const backend = process.env.NOTABENE_BACKEND || 'http://localhost:3000';

export default defineConfig({
  root: 'client',
  publicDir: 'public',
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      // Directives "use client" des dépendances React d'Excalidraw : sans effet hors RSC.
      onwarn(warning, warn) {
        if (warning.code !== 'MODULE_LEVEL_DIRECTIVE') warn(warning);
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': backend,
      '/auth': backend,
      '/healthz': backend,
    },
  },
});
