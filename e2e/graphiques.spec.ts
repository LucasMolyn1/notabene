// Vue graphique d'une base : barres, anneau, lignes ; éléments focalisables aux flèches, infobulle, tableau des valeurs,
// assistant de configuration, filtres de la vue appliqués par le serveur, lecteur sans réglage, téléphone (375 px).
import { expect, test, type Browser, type Page } from '@playwright/test';
import { ADMIN } from './accounts';
import { adminContext, api, createLocalUser, loginUi, PASSWORD, sessionContext } from './helpers';

type Prop = { id: string; name: string; options: { id: string; name: string }[] };
type View = { id: string; config: Record<string, unknown> };

/** Base : Statut (3 options), Points (nombre), Échéance (date) ; 6 lignes dont une sans statut. */
async function chartBase(browser: Browser, title: string) {
  const admin = await adminContext(browser);
  const spaces = (await (await api(admin.request, 'GET', '/spaces')).json()) as { id: string; visibility: string }[];
  const base = (await (await api(admin.request, 'POST', '/bases', { spaceId: spaces.find((s) => s.visibility === 'public')!.id, title })).json()) as { page: { id: string }; properties: { id: string }[] };
  const id = base.page.id;
  const nom = base.properties[0]!.id;
  const prop = async (body: object) => (await (await api(admin.request, 'POST', `/bases/${id}/properties`, body)).json()) as Prop;
  const statut = await prop({ name: 'Statut', type: 'status' });
  const points = await prop({ name: 'Points', type: 'number' });
  const echeance = await prop({ name: 'Échéance', type: 'date' });
  const [a, b, c] = statut.options.map((o) => o.id);
  const rows: [string, string | null, number, string][] = [
    ['Un', a!, 3, '2026-01-05'], ['Deux', a!, 2, '2026-01-20'], ['Trois', b!, 5, '2026-02-03'],
    ['Quatre', c!, 1, '2026-03-10'], ['Cinq', c!, 4, '2026-03-11'], ['Six', null, 7, '2026-03-12'],
  ];
  for (const [n, s, p, d] of rows) {
    expect((await api(admin.request, 'POST', `/bases/${id}/rows`, { values: { [nom]: n, ...(s ? { [statut.id]: s } : {}), [points.id]: p, [echeance.id]: d } })).ok()).toBeTruthy();
  }
  const view = (await (await api(admin.request, 'POST', `/bases/${id}/views`, {
    name: 'Graphique', config: { type: 'chart', chart: 'bar', groupBy: statut.id, metric: 'count', sort: [], filters: [], hidden: [] },
  })).json()) as View;
  expect(view.id).toBeTruthy();
  await admin.close();
  return { id, nom, statut, points, echeance, view };
}

async function viewOf(browser: Browser, baseId: string, viewId: string) {
  const admin = await adminContext(browser);
  const data = (await (await api(admin.request, 'GET', `/bases/${baseId}`)).json()) as { views: View[] };
  await admin.close();
  return data.views.find((v) => v.id === viewId)!;
}

const chartLoaded = (page: Page, viewId: string) => page.waitForResponse((r) => r.url().includes(`/views/${viewId}/chart`) && r.request().method() === 'GET');

test('graphique : barres, clavier, infobulle, tableau des valeurs, assistant, filtres', async ({ page, browser }) => {
  const p = await chartBase(browser, 'Graphique e2e');
  const [optA, optB, optC] = p.statut.options;
  await page.setViewportSize({ width: 1300, height: 950 });
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto(`/p/${p.id}`);
  let loaded = chartLoaded(page, p.view.id);
  await page.getByRole('tab', { name: 'Graphique' }).click();
  await loaded;

  // Titre, description, une barre par option dans l'ordre des options, « Sans valeur » ; libellé « option : valeur ».
  await expect(page.getByRole('heading', { name: 'Nombre de lignes par Statut' })).toBeVisible();
  await expect(page.getByText(/Barres, 4 groupes, 6 lignes/)).toBeVisible();
  const chart = page.getByRole('group', { name: 'Nombre de lignes par Statut' });
  const items = chart.getByRole('img');
  await expect(items).toHaveCount(4);
  await expect(items.nth(0)).toHaveAccessibleName(`${optA!.name} : 2`);
  await expect(items.nth(1)).toHaveAccessibleName(`${optB!.name} : 1`);
  await expect(items.nth(2)).toHaveAccessibleName(`${optC!.name} : 2`);
  await expect(items.nth(3)).toHaveAccessibleName('Sans valeur : 1');
  // Valeurs écrites à côté des barres (pas la couleur seule).
  await expect(chart.locator('.ch-value').first()).toHaveText('2');

  // Clavier : une seule barre dans l'ordre de tabulation, flèches pour passer à la suivante ; infobulle au focus, Échap la masque.
  await expect(chart.locator('[tabindex="0"]')).toHaveCount(1);
  await items.nth(0).focus();
  const tip = page.getByRole('tooltip');
  await expect(tip).toBeVisible();
  await expect(tip).toContainText(`${optA!.name} : 2`);
  await expect(tip).toContainText('2 lignes');
  await page.keyboard.press('ArrowRight');
  await expect(items.nth(1)).toBeFocused();
  await expect(tip).toContainText(`${optB!.name} : 1`);
  await page.keyboard.press('End');
  await expect(items.nth(3)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(tip).toBeHidden();

  // Tableau des valeurs : mêmes informations.
  await page.getByRole('button', { name: 'Tableau des valeurs' }).click();
  const table = page.getByRole('table', { name: 'Nombre de lignes par Statut' });
  await expect(table.getByRole('row')).toHaveCount(6); // en-tête, 4 groupes, total
  await expect(table.getByRole('row', { name: new RegExp(`^${optA!.name} 2 2`) })).toBeVisible();
  await expect(table.getByRole('row', { name: /^Total 6 6 100 %/ })).toBeVisible();
  await page.getByRole('button', { name: 'Graphique', exact: true }).click();

  // Assistant : anneau, somme des points.
  await page.getByRole('button', { name: 'Configurer le graphique' }).click();
  const dialog = page.getByRole('dialog', { name: 'Configurer le graphique' });
  await dialog.getByLabel('Anneau').check();
  await dialog.getByLabel('Calcul').selectOption('sum');
  await dialog.getByLabel('Colonne de valeur').selectOption({ label: 'Points' });
  loaded = chartLoaded(page, p.view.id);
  await dialog.getByRole('button', { name: 'Enregistrer' }).click();
  await loaded;
  await expect(page.getByRole('heading', { name: 'Somme de Points par Statut' })).toBeVisible();
  const donut = page.getByRole('group', { name: 'Somme de Points par Statut' });
  await expect(donut.getByRole('img', { name: `${optA!.name} : 5` })).toBeVisible();
  await expect(donut.getByRole('img', { name: 'Sans valeur : 7' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Légende' })).toContainText('22,7 %');
  let saved = (await viewOf(browser, p.id, p.view.id)).config;
  expect(saved).toMatchObject({ type: 'chart', chart: 'donut', metric: 'sum', valueId: p.points.id, groupBy: p.statut.id });

  // Lignes par mois de l'échéance.
  await page.getByRole('button', { name: 'Configurer le graphique' }).click();
  await dialog.getByLabel('Lignes').check();
  await dialog.getByLabel('Regrouper par').selectOption({ label: 'Échéance' });
  await dialog.getByLabel('Intervalle de dates').selectOption('month');
  await dialog.getByLabel('Calcul').selectOption('count');
  loaded = chartLoaded(page, p.view.id);
  await dialog.getByRole('button', { name: 'Enregistrer' }).click();
  await loaded;
  const lines = page.getByRole('group', { name: /Nombre de lignes par Échéance/ });
  await expect(lines.getByRole('img')).toHaveCount(3);
  saved = (await viewOf(browser, p.id, p.view.id)).config;
  expect(saved).toMatchObject({ chart: 'line', groupBy: p.echeance.id, bucket: 'month', metric: 'count' });
  expect(saved.valueId).toBeUndefined();

  // Filtre de la vue (Points > 2) : appliqué par le serveur au calcul.
  const admin = await adminContext(browser);
  expect((await api(admin.request, 'PATCH', `/bases/${p.id}/views/${p.view.id}`, {
    config: { type: 'chart', chart: 'bar', groupBy: p.statut.id, metric: 'count', sort: [], filters: [{ propertyId: p.points.id, op: 'gt', value: 2 }], hidden: [] },
  })).ok()).toBeTruthy();
  await admin.close();
  loaded = chartLoaded(page, p.view.id);
  await page.reload();
  await page.getByRole('tab', { name: 'Graphique' }).click();
  await loaded;
  const filtered = page.getByRole('group', { name: 'Nombre de lignes par Statut' });
  await expect(filtered.getByRole('img', { name: `${optA!.name} : 1` })).toBeVisible();
  await expect(filtered.getByRole('img', { name: `${optB!.name} : 1` })).toBeVisible();
  await expect(filtered.getByRole('img', { name: `${optC!.name} : 1` })).toBeVisible();
  await expect(page.getByRole('button', { name: /Filtrer \(1\)/ })).toBeVisible();
});

test('graphique : un lecteur le voit sans pouvoir le régler ; téléphone 375 px', async ({ browser }) => {
  const p = await chartBase(browser, 'Graphique lecture e2e');
  const admin = await adminContext(browser);
  await createLocalUser(admin.request, 'chart.reader@e2e.test', 'Lecteur graphique', 'reader');
  await admin.close();
  const ctx = await sessionContext(browser, 'chart.reader@e2e.test', PASSWORD);
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(`/p/${p.id}`);
  const loaded = chartLoaded(page, p.view.id);
  await page.getByRole('tab', { name: 'Graphique' }).click();
  await loaded;
  const chart = page.getByRole('group', { name: 'Nombre de lignes par Statut' });
  await expect(chart.getByRole('img')).toHaveCount(4);
  await expect(page.getByRole('button', { name: 'Configurer le graphique' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Filtrer/ })).toHaveCount(0);
  // Rien ne déborde horizontalement, le dessin tient dans la largeur.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  const box = (await chart.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(375);
  await page.getByRole('button', { name: 'Tableau des valeurs' }).click();
  await expect(page.getByRole('table', { name: 'Nombre de lignes par Statut' })).toBeVisible();
  await ctx.close();
});
