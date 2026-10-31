import { expect, test, type Browser } from '@playwright/test';
import { ADMIN } from './accounts';
import { adminContext, api, createLocalUser, loginUi, PASSWORD, sessionContext } from './helpers';

const OWNER = 'perso.proprietaire@e2e.test';

async function setEnabled(browser: Browser, enabled: boolean) {
  const admin = await adminContext(browser);
  expect((await api(admin.request, 'PUT', '/admin/personal-spaces', { enabled })).ok()).toBeTruthy();
  await admin.close();
}

test.beforeAll(async ({ browser }) => {
  const admin = await adminContext(browser);
  await createLocalUser(admin.request, OWNER, 'Propriétaire Perso', 'editor');
  await admin.close();
  await setEnabled(browser, true);
});
test.afterAll(async ({ browser }) => { await setEnabled(browser, false).catch(() => undefined); });

test('une personne crée son espace personnel, que les administrateurs ne voient pas', async ({ page, browser }) => {
  await loginUi(page, OWNER, PASSWORD);
  await page.getByRole('button', { name: /Privé|Public/ }).first().click();
  await page.getByRole('menuitem', { name: 'Créer mon espace personnel' }).click();
  await page.waitForURL(/\/s\//);
  await expect(page.locator('.space-switch')).toContainText('Espace de Propriétaire Perso');

  // Une page dans l'espace, puis le point de vue d'un administrateur.
  await page.getByRole('button', { name: /Nouvelle page/ }).first().click();
  await page.waitForURL(/\/p\//);
  const admin = await adminContext(browser);
  const spaces = (await (await api(admin.request, 'GET', '/spaces')).json()) as { name: string }[];
  expect(spaces.map((s) => s.name)).not.toContain('Espace de Propriétaire Perso');
  const owner = await sessionContext(browser, OWNER, PASSWORD);
  const mine = (await (await api(owner.request, 'GET', '/spaces')).json()) as { name: string; kind: string; role: string }[];
  expect(mine.find((s) => s.name === 'Espace de Propriétaire Perso')).toMatchObject({ kind: 'personal', role: 'full' });
  await admin.close(); await owner.close();
});

test('le réglage d’instance se trouve dans Paramètres, Espaces', async ({ page }) => {
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto('/settings/spaces');
  await expect(page.getByRole('heading', { name: 'Espaces personnels' })).toBeVisible();
  await expect(page.getByLabel('Autoriser les espaces personnels')).toBeChecked();
});
