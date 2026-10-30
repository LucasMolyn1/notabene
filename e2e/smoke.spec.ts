import { expect, test } from '@playwright/test';
import zlib from 'node:zlib';
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

test('le modèle de l’IA se choisit dans une liste déroulante une fois la clé enregistrée', async ({ page }) => {
  // Réponses simulées : pas de vrai fournisseur dans les tests.
  await page.route('**/api/v3/admin/ai', (route) => route.request().method() === 'GET'
    ? route.fulfill({ json: { enabled: true, provider: 'openai', baseUrl: 'https://api.example.com/v1', model: 'gpt-4o', hasKey: true, keyHint: '…abcd' } })
    : route.continue());
  await page.route('**/api/v3/admin/ai/models', (route) => route.fulfill({ json: { models: ['gpt-4o', 'gpt-4o-mini', 'mistral-large-latest'] } }));
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto('/#/settings/ai');
  const model = page.getByRole('combobox', { name: 'Modèle', exact: true });
  await expect(model).toHaveValue('gpt-4o');
  await expect(model.locator('option')).toHaveText(['gpt-4o', 'gpt-4o-mini', 'mistral-large-latest', 'Autre modèle…']);
  await model.selectOption('mistral-large-latest');
  await expect(model).toHaveValue('mistral-large-latest');
  await model.selectOption('__custom');
  await expect(page.getByRole('textbox', { name: 'Nom du modèle' })).toBeVisible();
});

test('le bouton de mise à jour demande confirmation et le mot de passe, puis dépose la demande', async ({ page }) => {
  const check = (updater: object) => ({ enabled: true, source: 'env', locked: false, current: '3.5.0', updateAvailable: true, checkedAt: Date.now(), error: null,
    latest: { version: '9.9.9', url: 'https://github.com/LucasMolyn1/notabene/releases/tag/v9.9.9', publishedAt: null, notes: null }, updater });
  let asked: unknown = null;
  await page.route('**/api/v3/admin/update-check', (route) => route.fulfill({ json: check({ available: true, state: 'idle', version: null, message: null, at: null }) }));
  await page.route('**/api/v3/admin/update/apply', async (route) => { asked = route.request().postDataJSON(); await route.fulfill({ json: { requested: true, version: '9.9.9' } }); });
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto('/#/settings/about');
  await page.getByRole('button', { name: 'Mettre à jour vers la 9.9.9' }).click();
  await expect(page.getByText('sauvegarder la base, télécharger la nouvelle image')).toBeVisible();
  await page.getByRole('button', { name: 'Mettre à jour', exact: true }).click();
  await page.getByLabel('Mot de passe', { exact: true }).fill(ADMIN.password);
  await page.getByRole('button', { name: 'Confirmer' }).click();
  await expect(page.getByText('Demande envoyée au service de l’hôte')).toBeVisible();
  expect(asked).toMatchObject({ version: '9.9.9', reauth: { password: ADMIN.password } });
});

test('sans service sur l’hôte, la page explique comment l’installer au lieu d’un bouton', async ({ page }) => {
  await page.route('**/api/v3/admin/update-check', (route) => route.fulfill({ json: { enabled: true, source: 'env', locked: false, current: '3.5.0', updateAvailable: true, checkedAt: Date.now(), error: null,
    latest: { version: '9.9.9', url: 'https://github.com/LucasMolyn1/notabene/releases/tag/v9.9.9', publishedAt: null, notes: null }, updater: { available: false, state: null, version: null, message: null, at: null } } }));
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto('/#/settings/about');
  await expect(page.getByText('installez le service de mise à jour sur l’hôte')).toBeVisible();
  await expect(page.getByRole('button', { name: /Mettre à jour vers/ })).toHaveCount(0);
});

test('« Vérifier maintenant » relance la vérification et annonce une nouvelle version', async ({ page }) => {
  const status = (available: boolean) => ({ enabled: true, source: 'env', locked: false, current: '3.6.0', updateAvailable: available, checkedAt: Date.now(), error: null,
    latest: { version: available ? '9.9.9' : '3.6.0', url: 'https://github.com/LucasMolyn1/notabene/releases/tag/v9.9.9', publishedAt: null, notes: null },
    updater: { available: false, state: null, version: null, message: null, at: null } });
  await page.route('**/api/v3/admin/update-check', (route) => route.fulfill({ json: status(false) }));
  await page.route('**/api/v3/admin/update-check/refresh', (route) => route.fulfill({ json: status(true) }));
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto('/#/settings/about');
  await expect(page.getByText('Vous utilisez la dernière version publiée.')).toBeVisible();
  await page.getByRole('button', { name: 'Vérifier maintenant' }).click();
  await expect(page.getByText('La version 9.9.9 est disponible').first()).toBeVisible();
});

// PNG uni de 96 x 96 pixels, fabriqué sur place (aucun fichier de test à ranger).
function solidPng(r: number, g: number, b: number, side = 96) {
  const row = Buffer.concat([Buffer.from([0]), Buffer.concat(Array.from({ length: side }, () => Buffer.from([r, g, b])))]);
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(4); head.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type), data])));
    return Buffer.concat([head, Buffer.from(type), data, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(side, 0); ihdr.writeUInt32BE(side, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: side }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}

test('une photo de profil se choisit, se recadre, s’affiche partout et se retire', async ({ page }) => {
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto('/#/settings/profile');
  await expect(page.locator('.profile .avatar img')).toHaveCount(0);
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Ajouter une photo' }).click();
  (await chooser).setFiles({ name: 'moi.png', mimeType: 'image/png', buffer: solidPng(200, 60, 60) });
  await expect(page.getByRole('dialog', { name: 'Ma photo de profil' })).toBeVisible();
  await page.getByRole('slider', { name: 'Zoom' }).fill('2');
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(page.getByText('Photo de profil enregistrée')).toBeVisible();
  const img = page.locator('.profile .avatar img');
  await expect(img).toHaveCount(1);
  await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBe(256);
  await expect(page.locator('.account .avatar img')).toHaveCount(1); // barre latérale, après rechargement
  await page.reload();
  await expect(page.locator('.account .avatar img')).toHaveCount(1);
  await page.getByRole('button', { name: 'Retirer la photo' }).click();
  await expect(page.locator('.profile .avatar img')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Ajouter une photo' })).toBeVisible();
});
