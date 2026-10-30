// Lint du dépôt (lancé depuis la racine : npm run lint). Objectif : peu de règles, toutes pertinentes, aucune alerte tolérée.
// Les règles de sécurité visent ce qui a réellement posé problème : regex quadratiques (ReDoS), évaluation dynamique,
// processus enfants, HTML injecté côté client. « detect-object-injection » et « detect-non-literal-fs-filename » sont
// volontairement absentes : trop de faux positifs pour peu de valeur ici.
import js from '@eslint/js';
import noUnsanitized from 'eslint-plugin-no-unsanitized';
import security from 'eslint-plugin-security';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/**', 'dist/**', 'data/**', 'coverage/**', 'test-results/**', 'playwright-report/**', 'client/public/**'] },
  js.configs.recommended,
  // Convention : « _nom » = valeur volontairement ignorée (retirer des clés d'un objet par déstructuration).
  { rules: { 'no-unused-vars': ['error', { ignoreRestSiblings: true, argsIgnorePattern: '^_' }] } },
  {
    files: ['**/*.ts'],
    extends: [...tseslint.configs.recommended],
    languageOptions: { globals: globals.node },
    rules: { '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true, argsIgnorePattern: '^_' }] },
  },
  {
    files: ['**/*.mjs', 'vite.config.js', 'scripts/**/*.{js,mjs}'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['client/src/**/*.js'],
    languageOptions: { globals: globals.browser, sourceType: 'module' },
    plugins: { 'no-unsanitized': noUnsanitized },
    rules: {
      // innerHTML, outerHTML, insertAdjacentHTML : chaque usage doit être justifié (contenu assaini ou constant).
      'no-unsanitized/method': 'error',
      'no-unsanitized/property': 'error',
    },
  },
  {
    plugins: { security },
    rules: {
      'security/detect-unsafe-regex': 'error',
      'security/detect-eval-with-expression': 'error',
      'security/detect-child-process': 'error',
      'security/detect-pseudoRandomBytes': 'error',
      'security/detect-new-buffer': 'error',
      'security/detect-buffer-noassert': 'error',
      'security/detect-bidi-characters': 'error',
      'security/detect-disable-mustache-escape': 'error',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-script-url': 'error',
    },
  },
  {
    // Les tests vérifient justement que des URL « javascript: » sont refusées.
    files: ['server/test/**', 'e2e/**'],
    rules: { 'no-script-url': 'off' },
  },
);
