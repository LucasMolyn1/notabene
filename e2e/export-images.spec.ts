import { readFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { ADMIN } from './accounts';
import { adminContext, api, loginUi } from './helpers';

// Image PNG de 1 × 1 pixel et petite image SVG, intégrées en base64 dans le texte de la page.
const PNG_SRC = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const SVG_SRC = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>').toString('base64')}`;

const doc = (...images: string[]) => ({
  type: 'doc',
  content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Texte de la page.' }] },
    ...images.map((src) => ({ type: 'image', attrs: { src, alt: 'image' } })),
  ],
});

async function createPages(browser: Browser, title: string, content?: object, withChild = false) {
  const admin = await adminContext(browser);
  const spaces = (await (await api(admin.request, 'GET', '/spaces')).json()) as { id: string; visibility: string }[];
  const spaceId = spaces.find((s) => s.visibility === 'public')!.id;
  const created = await (await api(admin.request, 'POST', '/pages', { spaceId, title, ...(content ? { content } : {}) })).json();
  if (withChild) await api(admin.request, 'POST', '/pages', { spaceId, parentId: created.id, title: `${title} (sous-page)` });
  await admin.close();
  return { id: created.id as string, spaceId };
}

// Audit axe (WCAG 2.1 AA) de l'écran courant, en clair puis en sombre.
async function a11y(page: Page, label: string) {
  const found: string[] = [];
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // Le thème est posé au chargement sur <html data-theme> : on le bascule sans recharger (l'écran garde son état).
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    found.push(...result.violations.map((v) => `${label} (${theme}) | ${v.id} | ${v.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(' ; ')}`));
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  expect(found).toEqual([]);
}

async function storedContent(browser: Browser, id: string) {
  const admin = await adminContext(browser);
  const page = await (await api(admin.request, 'GET', `/pages/${id}`)).json();
  await admin.close();
  return JSON.stringify(page.content);
}

test('export ZIP d’une page avec ses sous-pages depuis le menu de la page', async ({ page, browser }) => {
  const { id } = await createPages(browser, 'Export ZIP e2e', doc(PNG_SRC), true);
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto(`/p/${id}`);
  await page.getByRole('button', { name: 'Plus d’options' }).click();
  await page.getByRole('menuitem', { name: 'Exporter en ZIP' }).click();
  const dialog = page.getByRole('dialog', { name: /Exporter « Export ZIP e2e » en ZIP/ });
  await expect(dialog.getByRole('radio', { name: /Markdown/ })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: /Avec les sous-pages/ })).toBeChecked();
  await a11y(page, 'fenêtre d’export ZIP');
  await dialog.getByRole('radio', { name: /HTML/ }).check();
  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Télécharger le ZIP' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^Export-ZIP-e2e.*\.zip$/);
  const bytes = await readFile((await file.path())!);
  expect(bytes.subarray(0, 4).toString('binary')).toBe('PK\u0003\u0004'); // en-tête d'une archive ZIP
  expect(bytes.includes(Buffer.from('.html'))).toBeTruthy();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Archive ZIP téléchargée.')).toBeVisible();
});

test('export ZIP refusé : le message du serveur est annoncé et la fenêtre reste ouverte', async ({ page, browser }) => {
  const { spaceId } = await createPages(browser, 'Export ZIP refusé e2e');
  await page.route('**/api/v3/spaces/*/export/zip*', (route) => route.fulfill({
    status: 413, contentType: 'application/problem+json', json: { status: 413, title: 'Payload Too Large', detail: 'plus de 2000 pages à exporter' },
  }));
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto(`/s/${spaceId}`);
  await page.locator('.space-switch').click();
  await page.getByRole('menuitem', { name: 'Exporter l’espace en ZIP' }).click();
  const dialog = page.getByRole('dialog', { name: /Exporter l’espace/ });
  await expect(dialog.getByRole('checkbox')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Télécharger le ZIP' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Export trop volumineux : plus de 2000 pages à exporter');
  await expect(dialog).toBeVisible();
  await a11y(page, 'export ZIP refusé');
  // Un export à la fois par personne : le message du serveur est repris tel quel.
  await page.unroute('**/api/v3/spaces/*/export/zip*');
  await page.route('**/api/v3/spaces/*/export/zip*', (route) => route.fulfill({
    status: 429, contentType: 'application/problem+json', json: { status: 429, title: 'Too Many Requests', detail: 'Un export est déjà en cours pour vous' },
  }));
  await dialog.getByRole('button', { name: 'Télécharger le ZIP' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Un export est déjà en cours pour vous');
});

test('simulation : une page d’un espace personnel d’autrui est listée sans titre ni lien', async ({ page }) => {
  await page.route('**/api/v3/admin/images/migration', (route) => (route.request().method() === 'GET'
    ? route.fulfill({ json: { pendingPages: 1, current: null, runs: [], labels: { coedition: 'Page en cours de co-édition' } } })
    : route.fulfill({ json: { pages: 0, images: 0, bytes: 0, reasons: { coedition: 1 }, skipped: [{ pageId: 'abcdefghijkl', title: null, hidden: true, reasons: ['coedition'] }] } })));
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto('/settings/images');
  await page.getByRole('button', { name: 'Simuler' }).click();
  const sim = page.locator('.notice.info');
  await sim.getByText('1 page concernée par une exclusion').click();
  await expect(sim.getByText('Page d’un espace personnel (masquée)')).toBeVisible();
  await expect(sim.locator('.img-pages a')).toHaveCount(0);
});

test('conversion des images : simulation, conversion, puis annulation', async ({ page, browser }) => {
  test.setTimeout(90_000);
  const { id } = await createPages(browser, 'Images base64 e2e', doc(PNG_SRC, SVG_SRC));
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto('/settings/images');
  await expect(page.getByRole('heading', { name: 'Images des pages' })).toBeVisible();
  await expect(page.getByText(/contien(t|nent) encore des images intégrées/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'docs/BACKUP.md' })).toBeVisible();

  // Simulation : rien n'est modifié, le motif d'exclusion du SVG est affiché avec son libellé.
  await page.getByRole('button', { name: 'Simuler' }).click();
  const sim = page.locator('.notice.info');
  await expect(sim).toContainText('Résultat de la simulation');
  await expect(sim).toContainText(/serai(en)?t convertie/);
  await expect(sim).toContainText('Image SVG : laissée dans la page');
  expect(await storedContent(browser, id)).toContain('data:image/png');
  await a11y(page, 'simulation');

  // Conversion après confirmation, suivie jusqu'à la fin (relevé toutes les 3 s).
  await page.getByRole('button', { name: 'Convertir', exact: true }).click();
  await page.getByRole('dialog', { name: 'Convertir les images des pages ?' }).getByRole('button', { name: 'Convertir' }).click();
  const runs = page.locator('.img-run');
  await expect(runs.first()).toContainText('Conversion', { timeout: 20_000 });
  await expect(runs.first()).toContainText('Terminée', { timeout: 20_000 });
  const converted = await storedContent(browser, id);
  expect(converted).not.toContain('data:image/png');
  expect(converted).toContain('/api/v3/attachments/');
  expect(converted).toContain('data:image/svg+xml');

  // Détail par page : la page convertie y figure.
  await runs.first().getByRole('button', { name: 'Détail par page' }).click();
  await expect(runs.first().getByRole('link', { name: 'Images base64 e2e' })).toBeVisible();
  await a11y(page, 'historique des conversions');

  // Annulation : les images reviennent dans la page.
  await runs.first().getByRole('button', { name: 'Annuler cette conversion' }).click();
  await page.getByRole('dialog', { name: 'Annuler cette conversion ?' }).getByRole('button', { name: 'Annuler la conversion' }).click();
  await expect(runs.first()).toContainText('Annulation d’une conversion', { timeout: 20_000 });
  await expect(runs.first()).toContainText('Terminée', { timeout: 20_000 });
  expect(await storedContent(browser, id)).toContain('data:image/png');
});
