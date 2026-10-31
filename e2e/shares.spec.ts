import { expect, test, type Browser } from '@playwright/test';
import { ADMIN } from './accounts';
import { adminContext, api, createLocalUser, loginUi, PASSWORD } from './helpers';

const EDITOR = 'partage.editeur@e2e.test';

async function setSharing(browser: Browser, enabled: boolean) {
  const admin = await adminContext(browser);
  expect((await api(admin.request, 'PUT', '/admin/sharing', { enabled })).ok()).toBeTruthy();
  await admin.close();
}

test.beforeAll(async ({ browser }) => {
  const admin = await adminContext(browser);
  await createLocalUser(admin.request, EDITOR, 'Éditeur Partage', 'editor');
  await admin.close();
  await setSharing(browser, true);
});
test.afterAll(async ({ browser }) => { await setSharing(browser, false).catch(() => undefined); });

test('une page se partage par lien, se lit sans compte, puis le lien se retire', async ({ page, browser }) => {
  const admin = await adminContext(browser);
  const spaces = (await (await api(admin.request, 'GET', '/spaces')).json()) as { id: string; visibility: string }[];
  const content = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Texte publié par lien' }] }] };
  const created = await (await api(admin.request, 'POST', '/pages', { spaceId: spaces.find((s) => s.visibility === 'private')!.id, title: 'Page à partager e2e', content })).json();
  await admin.close();

  await loginUi(page, EDITOR, PASSWORD);
  await page.goto(`/p/${created.id}`);
  await page.getByRole('button', { name: 'Partager par un lien public' }).click();
  const dialog = page.getByRole('dialog', { name: 'Partager cette page' });
  await dialog.getByRole('button', { name: 'Créer un lien public' }).click();
  const url = await dialog.getByLabel('Lien public').inputValue();
  expect(url).toMatch(/\/share\/[A-Za-z0-9_-]{32}$/);
  await expect(dialog.getByLabel('Autoriser les moteurs de recherche')).not.toBeChecked();

  // Visiteur sans compte : contexte vierge.
  const visitor = await browser.newContext({ baseURL: 'http://localhost:3100' });
  const tab = await visitor.newPage();
  const path = new URL(url).pathname;
  const shell = await tab.goto(path);
  expect(shell?.headers()['referrer-policy']).toBe('no-referrer');
  expect(shell?.headers()['x-robots-tag']).toBe('noindex, nofollow');
  expect(shell?.headers()['cache-control']).toBe('no-store');
  await expect(tab.getByRole('heading', { name: 'Page à partager e2e' })).toBeVisible();
  await expect(tab.getByText('Texte publié par lien')).toBeVisible();
  await expect(tab.locator('.sidebar')).toBeHidden();
  await expect(tab.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, nofollow');

  // Retrait : le lien cesse de répondre.
  await dialog.getByRole('button', { name: 'Retirer le partage' }).click();
  await tab.reload();
  await expect(tab.getByText('Lien introuvable ou expiré')).toBeVisible();
  await visitor.close();
});

test('le réglage d’instance et la liste se trouvent dans Paramètres, Pages partagées', async ({ page }) => {
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto('/settings/shares');
  await expect(page.getByLabel('Autoriser le partage public par lien')).toBeChecked();
  await expect(page.getByRole('heading', { name: 'Pages partagées' }).first()).toBeVisible();
});
