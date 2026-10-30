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

test('la recherche s’ouvre au clavier, prend le focus et se ferme avec Échap', async ({ page }) => {
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.keyboard.press('Control+k');
  const input = page.getByRole('combobox', { name: 'Rechercher' });
  await expect(input).toBeFocused();
  await input.fill('bienvenue');
  await expect(page.getByRole('option').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(input).toBeHidden();
});

test('l’arborescence se parcourt au clavier (flèches, menu, Échap)', async ({ page }) => {
  await loginUi(page, ADMIN.email, ADMIN.password);
  const tree = page.getByRole('tree', { name: 'Pages' });
  const root = tree.getByRole('treeitem', { name: 'Bienvenue sur Notabene' });
  await root.focus();
  await page.keyboard.press('ArrowRight');
  await expect(root).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(tree.getByRole('treeitem').nth(1)).toBeFocused();
  await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toBeHidden();
  await expect(tree.getByRole('treeitem').nth(1)).toBeFocused();
});
