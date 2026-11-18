import { expect, test, type Browser } from '@playwright/test';
import { ADMIN } from './accounts';
import { adminContext, api, loginUi } from './helpers';

const SPACE = 'Espace client e2e';

async function setSharing(browser: Browser, enabled: boolean) {
  const admin = await adminContext(browser);
  if (enabled) {
    expect((await api(admin.request, 'PUT', '/admin/sharing', { enabled: true })).ok()).toBeTruthy();
    expect((await api(admin.request, 'PUT', '/admin/sharing/spaces', { enabled: true })).ok()).toBeTruthy();
  } else {
    await api(admin.request, 'PUT', '/admin/sharing/spaces', { enabled: false });
    await api(admin.request, 'PUT', '/admin/sharing', { enabled: false });
  }
  await admin.close();
}

test.beforeAll(async ({ browser }) => { await setSharing(browser, true); });
test.afterAll(async ({ browser }) => { await setSharing(browser, false).catch(() => undefined); });

test('un espace se partage par lien : création, copie, lecture anonyme, défilement, révocation', async ({ page, browser, context }) => {
  // Espace avec une page longue, une sous-page et une page restreinte (exclue du partage).
  const admin = await adminContext(browser);
  const space = await (await api(admin.request, 'POST', '/spaces', { name: SPACE, visibility: 'private' })).json();
  const paragraphs = Array.from({ length: 80 }, (_, i) => ({ type: 'paragraph', content: [{ type: 'text', text: `Paragraphe ${i + 1} du texte partagé.` }] }));
  paragraphs.push({ type: 'paragraph', content: [{ type: 'text', text: 'Fin du texte long' }] });
  const home = await (await api(admin.request, 'POST', '/pages', { spaceId: space.id, title: 'Accueil client e2e', content: { type: 'doc', content: paragraphs } })).json();
  const child = await (await api(admin.request, 'POST', '/pages', { spaceId: space.id, parentId: home.id, title: 'Sous-page client e2e' })).json();
  const secret = await (await api(admin.request, 'POST', '/pages', { spaceId: space.id, title: 'Page restreinte e2e' })).json();
  const me = await (await admin.request.get('/api/v3/me')).json();
  expect((await api(admin.request, 'PUT', `/pages/${secret.id}/permissions`, { entries: [{ userId: me.user.id, level: 'write' }] })).ok()).toBeTruthy();
  await admin.close();

  const logs: string[] = [];
  page.on('console', (m) => logs.push(m.text()));
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto(`/s/${space.id}`);
  await page.locator('.space-switch').click();
  await page.getByRole('menuitem', { name: 'Partager l’espace par lien' }).click();
  const dialog = page.getByRole('dialog', { name: 'Partager l’espace par lien' });
  await expect(dialog.getByText('Toute personne ayant le lien peut lire ; les pages restreintes sont exclues.')).toBeVisible();
  await expect(dialog.getByText('Aucun lien pour cet espace.')).toBeVisible();

  // Création au clavier : libellé, expiration, validation.
  await dialog.getByLabel('Libellé (facultatif)').fill('Client e2e');
  await dialog.getByLabel('Expiration').selectOption({ label: '30 jours' });
  await dialog.getByLabel('Libellé (facultatif)').press('Enter');
  const field = dialog.getByLabel('Nouveau lien (Client e2e)');
  await expect(field).toBeFocused();
  const url = await field.inputValue();
  expect(url).toMatch(/\/share\/[A-Za-z0-9_-]{43}$/);
  const token = url.split('/').pop()!;
  await expect(dialog.getByText('Copiez ce lien maintenant : il ne sera plus affiché.', { exact: false })).toBeVisible();
  await expect(dialog.getByRole('listitem').filter({ hasText: 'Client e2e' })).toContainText('expire le');

  await dialog.getByRole('button', { name: 'Copier le lien' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(url);
  // Le jeton n'apparaît ni dans l'adresse de gestion ni dans la console.
  expect(page.url()).not.toContain(token);
  expect(logs.some((l) => l.includes(token))).toBe(false);

  // Visiteur sans compte : arborescence de l'espace, sans la page restreinte.
  const visitor = await browser.newContext({ baseURL: 'http://localhost:3100' });
  const tab = await visitor.newPage();
  await tab.goto(new URL(url).pathname);
  await expect(tab.locator('.share-head')).toContainText(SPACE);
  await expect(tab.getByRole('heading', { level: 1, name: 'Accueil client e2e' })).toBeVisible();
  const nav = tab.getByRole('navigation', { name: `Pages de l’espace ${SPACE}` });
  await expect(nav.getByRole('link', { name: 'Accueil client e2e' })).toHaveAttribute('aria-current', 'page');
  await expect(nav.getByRole('link', { name: 'Sous-page client e2e' })).toBeVisible();
  await expect(tab.getByText('Page restreinte e2e')).toHaveCount(0);
  await expect(tab.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex, nofollow');

  // Défilement : la fin d'une page longue est atteignable.
  const end = tab.getByText('Fin du texte long');
  await expect(end).not.toBeInViewport();
  await tab.locator('.share-scroller').hover();
  await tab.mouse.wheel(0, 20_000);
  await expect(end).toBeInViewport();

  // Navigation vers une sous-page.
  await nav.getByRole('link', { name: 'Sous-page client e2e' }).click();
  await expect(tab).toHaveURL(new RegExp(`/share/${token}/p/${child.id}$`));
  await expect(tab.getByRole('heading', { level: 1, name: 'Sous-page client e2e' })).toBeVisible();
  // Une page restreinte demandée directement : même réponse qu'un lien inconnu.
  await tab.goto(`/share/${token}/p/${secret.id}`);
  await expect(tab.getByText('Lien introuvable ou expiré')).toBeVisible();

  // Révocation : le lien cesse de répondre.
  await dialog.getByRole('button', { name: 'Révoquer le lien Client e2e' }).click();
  await page.getByRole('dialog', { name: 'Révoquer ce lien ?' }).getByRole('button', { name: 'Révoquer' }).click();
  await expect(dialog.getByText('Aucun lien pour cet espace.')).toBeVisible();
  await expect(dialog.getByLabel('Nouveau lien (Client e2e)')).toHaveCount(0);
  await tab.goto(new URL(url).pathname);
  await expect(tab.getByText('Lien introuvable ou expiré')).toBeVisible();
  await visitor.close();
});

test('le réglage du partage d’espaces se trouve dans Paramètres, Pages partagées, avec confirmation', async ({ page }) => {
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto('/settings/shares');
  const toggle = page.getByLabel('Autoriser le partage d’espaces entiers par lien');
  await expect(toggle).toBeChecked();
  await toggle.uncheck({ force: true });
  const confirm = page.getByRole('dialog', { name: 'Désactiver le partage d’espaces ?' });
  await expect(confirm).toContainText('supprime');
  await confirm.getByRole('button', { name: 'Annuler' }).click();
  await expect(page.getByLabel('Autoriser le partage d’espaces entiers par lien')).toBeChecked();
});
