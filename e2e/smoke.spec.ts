import { expect, test } from '@playwright/test';
import { ADMIN } from './accounts';
import { loginUi } from './helpers';

test('connexion locale puis chargement du wiki', async ({ page }) => {
  await loginUi(page, ADMIN.email, ADMIN.password);
  await expect(page.getByText('Bienvenue sur Notabene').first()).toBeVisible();
  await expect(page).toHaveTitle(/Notabene/);
});

test('refuse un mauvais mot de passe', async ({ page }) => {
  await loginUi(page, ADMIN.email, 'mauvais-mot-de-passe', undefined, { expectSuccess: false });
  await expect(page.getByText('Identifiants invalides')).toBeVisible();
});

test('les anciennes versions d’API n’existent plus', async ({ request }) => {
  expect((await request.get('/api/v1/config')).status()).toBe(404);
  expect((await request.get('/api/v3/config')).status()).toBe(200);
  expect((await request.get('/api/docs/json')).status()).toBe(401);
});
