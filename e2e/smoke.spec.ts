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

test('l’écran À propos affiche la version et les nouveautés, la pastille s’éteint après lecture', async ({ page }) => {
  await loginUi(page, ADMIN.email, ADMIN.password);
  // Simule une mise à jour : une ancienne version a été vue sur ce navigateur.
  await page.evaluate(() => localStorage.setItem('notabene:seen-version', '0.0.1'));
  await page.reload();
  await expect(page.getByRole('img', { name: 'Nouveautés' }).first()).toBeVisible();
  await page.goto('/#/settings/about');
  await expect(page.getByRole('heading', { name: 'Nouveautés' })).toBeVisible();
  await expect(page.getByText('Installée')).toBeVisible();
  await expect(page.getByText('La vérification est désactivée : cette instance ne sait pas')).toBeVisible();
  await expect(page.getByRole('img', { name: 'Nouveautés' })).toHaveCount(0);
});

test('un diagramme se redimensionne au clavier et garde sa largeur', async ({ page }) => {
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.getByText('Nouvelle page').first().click();
  const editor = page.locator('.tiptap');
  await editor.click();
  await page.keyboard.type('/mermaid');
  await page.keyboard.press('Enter');
  const block = page.locator('.diagram').first();
  await expect(block).toBeVisible();
  const before = (await block.boundingBox())!.width;
  const handle = block.getByRole('slider', { name: /Largeur/ });
  await handle.focus();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await block.boundingBox())!.width).toBeLessThan(before);
  await page.reload();
  await expect.poll(async () => (await page.locator('.diagram').first().boundingBox())!.width).toBeLessThan(before);
});

test('une mise à jour disponible alerte l’administrateur et mène aux nouveautés', async ({ page }) => {
  // Réponse simulée : le serveur de test n'interroge pas GitHub.
  await page.route('**/api/v3/admin/update-check', (route) => route.fulfill({ json: {
    enabled: true, current: '3.2.0', updateAvailable: true, checkedAt: Date.now(), error: null,
    latest: { version: '9.9.9', url: 'https://github.com/LucasMolyn1/notabene/releases/tag/v9.9.9', publishedAt: null, notes: {
      version: '9.9.9', date: '2026-12-01', summary: 'Version de test.', sections: [{ title: 'Attention à la mise à jour', items: ['Sauvegardez avant.'] }] } },
  } }));
  await loginUi(page, ADMIN.email, ADMIN.password);
  const banner = page.getByRole('link', { name: /Version 9\.9\.9 disponible/ });
  await expect(banner).toBeVisible();
  await banner.click();
  await expect(page.getByText('Sauvegardez avant.')).toBeVisible();
  await expect(page.getByText('Disponible', { exact: true })).toBeVisible();
  await expect(page.getByText('docker compose pull')).toBeVisible();
});

test('un bloc de code se colore, ferme les parenthèses et se quitte au clavier', async ({ page }) => {
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.getByText('Nouvelle page').first().click();
  await page.locator('.tiptap').click();
  await page.keyboard.type('```js ');
  const cm = page.locator('.code-block .cm-content');
  await expect(cm).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Langage du bloc de code' })).toHaveValue('javascript');
  await page.keyboard.type('const x = {');
  await page.keyboard.press('Enter');
  await page.keyboard.type('a: 1');
  await expect(cm.locator('.tok-keyword').first()).toHaveText('const');
  await expect(cm).toContainText('}'); // accolade fermée automatiquement
  await page.keyboard.press('Escape');
  await page.keyboard.type('Après le bloc');
  await expect(page.locator('.tiptap > p', { hasText: 'Après le bloc' })).toBeVisible();
  await page.waitForTimeout(2500);
  await page.reload();
  await expect(page.locator('.code-block .cm-content')).toContainText('const x = {');
});

test('un emoji se cherche en français, s’affiche partout et se retrouve dans les récents', async ({ page }) => {
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.getByText('Nouvelle page').first().click();
  await page.getByRole('button', { name: /Ajouter une icône/i }).click();
  const search = page.getByRole('searchbox', { name: 'Rechercher un emoji' });
  await expect(search).toBeFocused();
  await search.fill('fusee');
  await page.getByRole('button', { name: /fusée/i }).first().click();
  await expect(page.locator('.page-icon .emoji-glyph')).toHaveText('🚀');
  await expect(page.locator('.crumb.current .emoji-glyph')).toHaveText('🚀'); // fil d'Ariane
  await page.locator('.page-icon').click();
  await expect(page.getByText('Récents')).toBeVisible();
  await expect(page.locator('.emoji-section[data-group="recent"] .emoji-btn').first()).toHaveText('🚀');
});

test('la vérification de mise à jour s’active depuis l’interface, avec explication', async ({ page }) => {
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto('/#/settings/about');
  await expect(page.getByText('Ce n’est pas une mise à jour automatique.')).toBeVisible();
  await expect(page.getByText('l’adresse IP publique de votre serveur')).toBeVisible();
  await page.getByRole('button', { name: 'Activer la vérification' }).click();
  await page.getByLabel('Mot de passe', { exact: true }).fill(ADMIN.password);
  await page.getByRole('button', { name: 'Confirmer' }).click();
  await expect(page.getByRole('button', { name: 'Désactiver la vérification' })).toBeVisible();
  await page.getByRole('button', { name: 'Désactiver la vérification' }).click(); // fenêtre de 10 min : pas de nouvelle saisie
  await expect(page.getByRole('button', { name: 'Activer la vérification' })).toBeVisible();
});
