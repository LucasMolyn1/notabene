// Interface sur téléphone : pas de débordement horizontal, cibles tactiles, barre de mise en forme, installation.
import { expect, test, type Page } from '@playwright/test';
import { ADMIN } from './accounts';
import { loginUi } from './helpers';

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

test('aucun écran ne déborde en largeur, et les boutons se touchent du doigt', async ({ page }) => {
  await page.goto('/?login');
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await loginUi(page, ADMIN.email, ADMIN.password);
  for (const path of ['/', '/settings/profile', '/settings/users', '/settings/about', '/settings/instance']) {
    await page.goto(path);
    await page.locator('.topbar').waitFor();
    await page.waitForTimeout(300);
    expect(await overflow(page), path).toBeLessThanOrEqual(0);
  }
  await page.getByRole('treeitem', { name: 'Bienvenue sur Notabene' }).click({ force: true }).catch(() => {});
  const small = await page.evaluate(() => [...document.querySelectorAll('.topbar button, .topbar a')]
    .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.width < 40 || r.height < 40); }).map((e) => e.className));
  expect(small).toEqual([]);
});

test('la barre du haut se limite à l’essentiel ; le reste est dans le menu « … »', async ({ page }) => {
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.getByRole('button', { name: /Barre latérale/ }).click();
  await page.getByRole('treeitem', { name: 'Bienvenue sur Notabene' }).click();
  await expect(page.locator('.topbar .icon-btn:visible')).toHaveCount(4); // menu, commentaires, « … », notifications (+ le bouton lecture/édition)
  await expect(page.locator('.tb-secondary:visible')).toHaveCount(0);
  await page.getByRole('button', { name: 'Plus d’options' }).click();
  for (const name of ['Suivre la page', 'Ajouter aux favoris', 'Historique des versions', 'Permissions de la page']) {
    await expect(page.getByRole('menuitem', { name })).toBeVisible();
  }
  await page.getByRole('menuitem', { name: 'Ajouter aux favoris' }).click();
  await expect(page.locator('.star-btn[aria-pressed="true"]')).toHaveCount(1);
});

test('la barre de mise en forme apparaît dans l’éditeur, met en gras et ouvre le menu d’insertion', async ({ page }) => {
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.getByText('Nouvelle page').first().click({ force: true });
  await page.getByRole('button', { name: /Barre latérale/ }).isVisible();
  const toolbar = page.getByRole('toolbar', { name: 'Mise en forme' });
  await page.locator('.tiptap').click();
  await expect(toolbar).toBeVisible();
  await page.keyboard.type('texte');
  await page.keyboard.press('Shift+Home');
  await toolbar.getByRole('button', { name: 'Gras' }).click();
  await expect(page.locator('.tiptap strong')).toHaveText('texte');
  await expect(toolbar.getByRole('button', { name: 'Gras' })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await toolbar.getByRole('button', { name: 'Insérer un bloc' }).click();
  await expect(page.locator('.slash-menu')).toBeVisible();
  await expect(page.locator('.bubble:not(.table-menu):visible')).toHaveCount(0); // la bulle de bureau ne s'affiche pas sur écran tactile
});

test('le manifeste permet d’installer Notabene comme une application', async ({ page, request }) => {
  await page.goto('/?login');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');
  const manifest = await (await request.get('/manifest.webmanifest')).json();
  expect(manifest).toMatchObject({ display: 'standalone', start_url: '/', scope: '/' });
  for (const icon of manifest.icons) expect((await request.get(icon.src)).status()).toBe(200);
  expect((await request.get('/icons/apple-touch-icon.png')).status()).toBe(200);
});
