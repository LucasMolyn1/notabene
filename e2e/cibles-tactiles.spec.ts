// Cibles tactiles de 44 px sur téléphone (375 px) : cases à cocher, onglets de vue, boutons d'en-tête, boutons de
// l'arbre, numéros de sources de l'IA, lien « BeNote ». Mesure par boundingBox ; aucun défilement horizontal.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { adminContext, api } from './helpers';

test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

const MIN = 44;
const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

async function expectTarget(loc: Locator, what: string) {
  await expect(loc, what).toBeVisible();
  const box = await loc.boundingBox();
  expect(box, what).not.toBeNull();
  expect(box!.width, `${what} (largeur)`).toBeGreaterThanOrEqual(MIN - 0.5);
  expect(box!.height, `${what} (hauteur)`).toBeGreaterThanOrEqual(MIN - 0.5);
}

test('téléphone : zones de clic de 44 px et pas de défilement horizontal', async ({ browser }) => {
  const admin = await adminContext(browser);
  const storageState = await admin.storageState();
  await admin.close();
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true, baseURL: 'http://localhost:3100', storageState });
  const spaces = (await (await api(ctx.request, 'GET', '/spaces')).json()) as { id: string; visibility: string }[];
  const spaceId = spaces.find((s) => s.visibility === 'public')!.id;
  const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
  const doc = (await (await api(ctx.request, 'POST', '/pages', {
    spaceId, title: 'Cibles tactiles',
    content: { type: 'doc', content: [para('Liste'), { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: false }, content: [para('Prendre les gants')] }] }] },
  })).json()) as { id: string };
  await api(ctx.request, 'POST', '/pages', { spaceId, title: 'Sous-page tactile', parentId: doc.id });
  const base = (await (await api(ctx.request, 'POST', '/bases', { spaceId, title: 'Base tactile' })).json()) as { page: { id: string }; properties: { id: string }[] };
  const done = (await (await api(ctx.request, 'POST', `/bases/${base.page.id}/properties`, { name: 'Fait', type: 'checkbox' })).json()) as { id: string };
  await api(ctx.request, 'POST', `/bases/${base.page.id}/rows`, { values: { [base.properties[0]!.id]: 'Ligne 1' } });
  await api(ctx.request, 'POST', `/bases/${base.page.id}/views`, { name: 'Deuxième vue', config: { type: 'table', sort: [], filters: [], hidden: [] } });

  const page = await ctx.newPage();
  await page.goto(`/p/${doc.id}`);
  await page.locator('.prose').first().waitFor();
  expect(await overflow(page)).toBeLessThanOrEqual(0);

  // Boutons d'en-tête de page (ceux qui restent dans la barre sur téléphone ; les autres passent dans « … »).
  const header = page.locator('.topbar button:visible');
  expect(await header.count()).toBeGreaterThanOrEqual(4);
  for (let i = 0; i < await header.count(); i++) await expectTarget(header.nth(i), `bouton d’en-tête ${await header.nth(i).getAttribute('aria-label') ?? await header.nth(i).textContent()}`);
  // Le bouton d'ouverture de la barre latérale a un libellé visible.
  await expect(page.getByRole('button', { name: 'Menu', exact: true })).toHaveText('Menu');

  // Case d'une liste de tâches : zone de 44 px autour d'une case de 17 px ; un appui au bord de la zone coche la case.
  const label = page.locator('.prose ul[data-type="taskList"] li > label').first();
  await expectTarget(label, 'case de liste de tâches');
  const box = (await page.locator('.prose ul[data-type="taskList"] input[type="checkbox"]').first().boundingBox())!;
  expect(box.width).toBeLessThan(20);
  const zone = (await label.boundingBox())!;
  await page.touchscreen.tap(zone.x + 3, zone.y + 3);
  await expect(page.locator('.prose ul[data-type="taskList"] input[type="checkbox"]').first()).toBeChecked();

  // Numéro de source de l'IA (pastille insérée telle que le rendu de l'IA la produit).
  await page.evaluate(() => {
    const p = document.createElement('p');
    const a = document.createElement('a');
    a.className = 'cite';
    a.href = '#';
    a.textContent = '1';
    p.append('Réponse ', a, ' suite.');
    document.querySelector('.page')!.append(p);
  });
  await expectTarget(page.locator('.page > p a.cite'), 'numéro de source de l’IA');

  // Barre latérale : lien BeNote, boutons d'une ligne (déplier, Options, ajouter une sous-page).
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  const sidebar = page.getByRole('complementary', { name: 'Navigation' });
  await expectTarget(sidebar.getByRole('link', { name: 'BeNote' }), 'lien BeNote');
  const row = sidebar.locator('.tree-row', { hasText: 'Cibles tactiles' });
  await expectTarget(row.locator('.caret'), 'bouton déplier');
  await expectTarget(row.getByRole('button', { name: 'Options' }), 'bouton Options');
  await expectTarget(row.getByRole('button', { name: 'Ajouter une sous-page' }), 'bouton ajouter une sous-page');
  expect(await overflow(page)).toBeLessThanOrEqual(0);

  // Base : onglets de vue et case à cocher d'une cellule.
  await page.goto(`/p/${base.page.id}`);
  await page.getByRole('tablist', { name: 'Vues' }).waitFor();
  const tabs = page.getByRole('tab');
  expect(await tabs.count()).toBeGreaterThanOrEqual(2);
  for (let i = 0; i < await tabs.count(); i++) await expectTarget(tabs.nth(i), `onglet de vue ${i + 1}`);
  const cell = page.getByRole('checkbox', { name: 'Fait' }).first();
  await expectTarget(page.locator('.bt-check-hit').first(), 'case de base');
  const hit = (await page.locator('.bt-check-hit').first().boundingBox())!;
  await page.touchscreen.tap(hit.x + 4, hit.y + hit.height / 2);
  await expect(cell).toBeChecked();
  await expect.poll(async () => ((await (await api(ctx.request, 'GET', `/bases/${base.page.id}/rows`)).json()) as { items: { values: Record<string, unknown> }[] }).items[0]!.values[done.id]).toBe(true);
  expect(await overflow(page)).toBeLessThanOrEqual(0);

  for (const path of ['/settings/security', '/settings/tokens', '/settings/audit']) {
    await page.goto(path);
    await page.locator('.set-card').first().waitFor();
    await page.waitForTimeout(200);
    expect(await overflow(page), path).toBeLessThanOrEqual(0);
  }
  await ctx.close();
});
