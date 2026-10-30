import { expect, test } from '@playwright/test';
import { adminContext, api, createLocalUser, PASSWORD, sessionContext } from './helpers';

test('l’intégration portfolio se modifie sans redémarrage (ressaisie du mot de passe)', async ({ browser }) => {
  const admin = await adminContext(browser);
  const page = await admin.newPage();
  await page.goto('/#/settings/embed');
  await page.getByPlaceholder('https://portfolio.exemple.fr').fill('https://portfolio.exemple.test');
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  // Ressaisie obligatoire : un mauvais mot de passe est refusé.
  await page.getByLabel('Mot de passe', { exact: true }).fill('mauvais');
  await page.getByRole('button', { name: 'Confirmer' }).click();
  await expect(page.getByText('Mot de passe incorrect')).toBeVisible();
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  await page.getByLabel('Mot de passe', { exact: true }).fill('Strong-e2e-pass-123');
  await page.getByRole('button', { name: 'Confirmer' }).click();
  await expect(page.getByText('Sites autorisés mis à jour')).toBeVisible();
  const csp = (await admin.request.get('/healthz')).headers()['content-security-policy'];
  expect(csp).toContain("frame-ancestors 'self' https://portfolio.exemple.test");
  await admin.close();
});

test('la cloche signale un commentaire sur une page suivie', async ({ browser }) => {
  const admin = await adminContext(browser);
  await createLocalUser(admin.request, 'bell.ringer@e2e.test', 'Sonneur', 'editor');
  const pages = ((await (await api(admin.request, 'GET', '/pages?limit=200')).json()) as { items: { id: string; title: string }[] }).items;
  const target = pages.find((p) => p.title === 'Utiliser l’API REST')!;

  const other = await sessionContext(browser, 'bell.ringer@e2e.test', PASSWORD);
  expect((await api(admin.request, 'PUT', `/pages/${target.id}/watch`)).ok()).toBeTruthy();
  const page = await admin.newPage();
  await page.goto('/');
  await expect(page.getByText('Bienvenue sur Notabene').first()).toBeVisible();

  const posted = await api(other.request, 'POST', `/pages/${target.id}/comments`, { body: 'Un commentaire <i>de test</i>' });
  expect(posted.status()).toBe(201);
  // Mise à jour en direct : le compteur passe à 1 sans recharger.
  await expect(page.locator('.bell-badge')).toHaveText('1', { timeout: 10_000 });
  await page.getByRole('button', { name: 'Notifications' }).click();
  await expect(page.getByText('Sonneur a commenté')).toBeVisible();
  await Promise.all([admin.close(), other.close()]);
});
