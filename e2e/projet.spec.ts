// Bases en mode projet : réglages, sous-éléments, « Bloqué par », relations et cumuls, vue chronologie (souris, clavier, tableau).
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { ADMIN } from './accounts';
import { adminContext, api, loginUi } from './helpers';

type Row = { id: string; values: Record<string, unknown>; parentId: string | null; blockedBy: string[] };
type Base = { page: { id: string }; properties: { id: string }[] };

/** Date locale décalée de `days` jours, au format AAAA-MM-JJ (le navigateur de test est sur le même fuseau). */
function day(days: number) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function newBase(browser: Browser, title: string) {
  const admin = await adminContext(browser);
  const spaces = (await (await api(admin.request, 'GET', '/spaces')).json()) as { id: string; visibility: string }[];
  const res = (await (await api(admin.request, 'POST', '/bases', { spaceId: spaces.find((s) => s.visibility === 'public')!.id, title })).json()) as Base;
  return { base: res, admin };
}

async function rowsOf(browser: Browser, baseId: string) {
  const admin = await adminContext(browser);
  const data = (await (await api(admin.request, 'GET', `/bases/${baseId}`)).json()) as { rows: Row[] };
  await admin.close();
  return data.rows;
}

/** Base de projet : Début, Fin, Statut ; A (aujourd'hui à +2) puis B (+3 à +4) bloquée par A ; dépendances actives. */
async function projectBase(browser: Browser, title: string) {
  const { base, admin } = await newBase(browser, title);
  const id = base.page.id;
  const nom = base.properties[0]!.id;
  const prop = async (name: string, type: string) => (await (await api(admin.request, 'POST', `/bases/${id}/properties`, { name, type })).json()) as { id: string; options: { id: string }[] };
  const debut = await prop('Début', 'date');
  const fin = await prop('Fin', 'date');
  const statut = await prop('Statut', 'status');
  const row = async (values: Record<string, unknown>) => (await (await api(admin.request, 'POST', `/bases/${id}/rows`, { values })).json()) as Row;
  const a = await row({ [nom]: 'Conception', [debut.id]: day(0), [fin.id]: day(2), [statut.id]: statut.options[1]!.id });
  const b = await row({ [nom]: 'Réalisation', [debut.id]: day(3), [fin.id]: day(4), [statut.id]: statut.options[0]!.id });
  expect((await api(admin.request, 'PATCH', `/bases/${id}/settings`, { dependencies: true, subitems: true, startPropertyId: debut.id, endPropertyId: fin.id })).ok()).toBeTruthy();
  expect((await api(admin.request, 'PATCH', `/bases/${id}/rows/${b.id}`, { blockedBy: [a.id] })).ok()).toBeTruthy();
  await admin.close();
  return { id, nom, debut, fin, statut, a, b };
}

async function openTimeline(page: Page, id: string) {
  await page.goto(`/p/${id}`);
  await page.getByRole('button', { name: 'Nouvelle vue' }).click();
  await page.getByRole('menuitem', { name: 'Nouvelle chronologie' }).click();
  await expect(page.locator('.tl-item')).toHaveCount(2);
}

const patched = (page: Page, rowId: string) => page.waitForResponse((r) => r.url().includes(`/rows/${rowId}`) && r.request().method() === 'PATCH');

test('réglages de la base, sous-éléments en retrait et « Bloqué par » dans le tableau', async ({ page, browser }) => {
  const { base, admin } = await newBase(browser, 'Projet tableau e2e');
  const id = base.page.id;
  const nom = base.properties[0]!.id;
  for (const t of ['Lot A', 'Lot B']) await api(admin.request, 'POST', `/bases/${id}/rows`, { values: { [nom]: t } });
  await admin.close();

  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto(`/p/${id}`);
  await expect(page.locator('tbody tr')).toHaveCount(2);
  await page.getByRole('button', { name: 'Réglages de la base' }).click();
  await page.getByLabel('Sous-éléments').check();
  await page.getByLabel('Dépendances').check();
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(page.getByRole('columnheader', { name: 'Bloqué par' })).toBeVisible();

  // Sous-élément ajouté depuis le menu de la ligne : rangé sous son parent, en retrait.
  await page.getByRole('button', { name: 'Actions de la ligne Lot A' }).click();
  await page.getByRole('menuitem', { name: 'Ajouter un sous-élément' }).click();
  await expect(page.locator('tbody tr')).toHaveCount(3);
  const child = page.locator('tbody tr').nth(1);
  await expect(child.locator('.bt-indent')).toHaveCount(1);
  await expect(child).toContainText('Sous-élément de Lot A');
  await child.getByRole('button', { name: /modifier Nom\)?$/i }).click();
  await page.getByRole('textbox', { name: 'Nom' }).fill('Tâche A1');
  await page.keyboard.press('Enter');
  await expect(page.locator('tbody tr').nth(1)).toContainText('Tâche A1');

  // Repli au clavier : le focus reste sur le bouton.
  await page.getByRole('button', { name: /Replier les sous-éléments de Lot A/ }).click();
  await expect(page.locator('tbody tr')).toHaveCount(2);
  await expect(page.getByRole('button', { name: /Déplier les sous-éléments de Lot A/ })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('tbody tr')).toHaveCount(3);

  // « Bloqué par » : choix dans la liste des lignes de la base.
  const rowB = page.locator('tbody tr').nth(2);
  await expect(rowB).toContainText('Lot B');
  await rowB.getByRole('button', { name: 'Modifier Bloqué par' }).click();
  await page.locator('.bt-popover').getByLabel('Lot A', { exact: true }).check();
  await page.locator('.bt-popover').getByRole('button', { name: 'Appliquer' }).click();
  await expect(rowB.getByRole('button', { name: /Bloqué par Lot A/ })).toBeVisible();

  const rows = await rowsOf(browser, id);
  const a = rows.find((r) => r.values[nom] === 'Lot A')!;
  expect(rows.find((r) => r.values[nom] === 'Tâche A1')!.parentId).toBe(a.id);
  expect(rows.find((r) => r.values[nom] === 'Lot B')!.blockedBy).toEqual([a.id]);

  // Remonter au premier niveau, puis supprimer le parent : ses sous-éléments partent avec lui.
  await page.reload();
  await page.getByRole('button', { name: 'Actions de la ligne Tâche A1' }).click();
  await page.getByRole('menuitem', { name: 'Placer sous un autre élément' }).click();
  await page.locator('.bt-popover').getByRole('button', { name: 'Lot B' }).click();
  await expect(page.locator('tbody tr').nth(2)).toContainText('Sous-élément de Lot B');
  await page.locator('tbody tr').nth(1).getByRole('button', { name: 'Supprimer la ligne' }).click();
  await expect(page.getByRole('dialog')).toContainText('1 sous-élément');
  await page.getByRole('dialog').getByRole('button', { name: 'Supprimer' }).click();
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.locator('tbody tr')).toContainText('Lot A');
});

test('relation entre deux bases et cumul créés depuis l’interface', async ({ page, browser }) => {
  const { base: taches, admin } = await newBase(browser, 'Tâches liées e2e');
  const heures = (await (await api(admin.request, 'POST', `/bases/${taches.page.id}/properties`, { name: 'Heures', type: 'number' })).json()) as { id: string };
  for (const [t, n] of [['T1', 3], ['T2', 5], ['T3', 40]] as const) await api(admin.request, 'POST', `/bases/${taches.page.id}/rows`, { values: { [taches.properties[0]!.id]: t, [heures.id]: n } });
  const spaces = (await (await api(admin.request, 'GET', '/spaces')).json()) as { id: string; visibility: string }[];
  const projets = (await (await api(admin.request, 'POST', '/bases', { spaceId: spaces.find((s) => s.visibility === 'public')!.id, title: 'Projets liés e2e' })).json()) as Base;
  await api(admin.request, 'POST', `/bases/${projets.page.id}/rows`, { values: { [projets.properties[0]!.id]: 'P1' } });
  await admin.close();

  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto(`/p/${projets.page.id}`);
  await page.getByRole('button', { name: 'Ajouter une colonne' }).click();
  await page.getByRole('textbox', { name: 'Nom de la colonne' }).fill('Tâches');
  await page.getByLabel('Type', { exact: true }).selectOption('relation');
  await page.getByLabel('Base liée', { exact: true }).selectOption({ label: 'Tâches liées e2e' });
  await page.getByRole('button', { name: 'Ajouter', exact: true }).click();
  await expect(page.getByRole('columnheader', { name: /Tâches/ })).toBeVisible();

  // Sélecteur de lignes de la base liée, avec recherche.
  const row = page.locator('tbody tr').first();
  await row.getByRole('button', { name: /Modifier Tâches/ }).click();
  const pop = page.locator('.bt-popover');
  await pop.getByRole('searchbox').fill('t1');
  await expect(pop.getByRole('checkbox')).toHaveCount(1);
  await pop.getByLabel('T1', { exact: true }).check();
  await pop.getByRole('searchbox').fill('');
  await pop.getByLabel('T2', { exact: true }).check();
  await pop.getByRole('button', { name: 'Appliquer' }).click();
  await expect(row.getByText('T1', { exact: true })).toBeVisible();
  await expect(row.getByText('T2', { exact: true })).toBeVisible();

  // Assistant de cumul : somme des heures des tâches liées.
  await page.getByRole('button', { name: 'Ajouter une colonne' }).click();
  await page.getByRole('textbox', { name: 'Nom de la colonne' }).fill('Total heures');
  await page.getByLabel('Type', { exact: true }).selectOption('rollup');
  await page.getByLabel('Colonne de la base liée').selectOption({ label: 'Heures (Nombre)' });
  await page.getByLabel('Calcul').selectOption('sum');
  await page.getByRole('button', { name: 'Ajouter', exact: true }).click();
  await expect(row.locator('td.bt-t-rollup')).toHaveText('8');
  // Un cumul ne se modifie pas.
  await expect(row.locator('td.bt-t-rollup button')).toHaveCount(0);
});

test('chronologie : barres, flèche de dépendance, clavier, souris, décalage en cascade, tableau équivalent', async ({ page, browser }) => {
  const p = await projectBase(browser, 'Chronologie e2e');
  await page.setViewportSize({ width: 1500, height: 900 });
  await loginUi(page, ADMIN.email, ADMIN.password);
  await openTimeline(page, p.id);
  await expect(page.locator('svg.tl-arrows path.tl-dep')).toHaveCount(1);
  await expect(page.locator('.tl-today')).toHaveCount(1);

  // Clavier : flèche droite = décaler d'un jour ; B, bloquée par A, est décalée en cascade.
  const barA = page.getByRole('button', { name: /^Conception, du/ });
  await barA.focus();
  const done = patched(page, p.a.id);
  await page.keyboard.press('ArrowRight');
  await done;
  await expect(page.getByRole('status').filter({ hasText: 'décalée' })).toHaveCount(1);
  await expect(barA).toBeFocused();
  let rows = await rowsOf(browser, p.id);
  const at = (rid: string) => rows.find((r) => r.id === rid)!.values;
  expect([at(p.a.id)[p.debut.id], at(p.a.id)[p.fin.id]]).toEqual([day(1), day(3)]);
  expect([at(p.b.id)[p.debut.id], at(p.b.id)[p.fin.id]]).toEqual([day(4), day(5)]);

  // Maj + flèche : étirer la fin.
  const done2 = patched(page, p.a.id);
  await page.keyboard.press('Shift+ArrowRight');
  await done2;
  rows = await rowsOf(browser, p.id);
  expect(at(p.a.id)[p.fin.id]).toBe(day(4));
  expect(at(p.b.id)[p.debut.id]).toBe(day(5));

  // Souris, à l'échelle du jour : glisser la barre B de deux jours.
  await page.getByLabel('Échelle').selectOption('day');
  const barB = page.getByRole('button', { name: /^Réalisation, du/ });
  // La fenêtre visible se reconstruit à l'image suivante (changement d'échelle) : on attend qu'elle soit posée.
  await page.getByRole('button', { name: 'Aujourd’hui' }).click();
  await expect(barB).toBeInViewport();
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const box = (await barB.boundingBox())!;
  const done3 = patched(page, p.b.id);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2, { steps: 4 });
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2, { steps: 4 });
  await page.mouse.up();
  await done3;
  rows = await rowsOf(browser, p.id);
  expect(at(p.b.id)[p.debut.id]).toBe(day(7));
  expect(at(p.b.id)[p.fin.id]).toBe(day(8));

  // Saisie des dates (Entrée sur la barre).
  await barB.focus();
  await page.keyboard.press('Enter');
  const editor = page.getByRole('form', { name: /Dates de Réalisation/ });
  await editor.getByLabel('Fin').fill(day(10));
  const done4 = patched(page, p.b.id);
  await editor.getByRole('button', { name: 'Enregistrer' }).click();
  await done4;
  rows = await rowsOf(browser, p.id);
  expect(at(p.b.id)[p.fin.id]).toBe(day(10));

  // Regroupement par statut et couleur.
  await page.getByLabel('Regrouper par').selectOption({ label: 'Regrouper par Statut' });
  await expect(page.locator('.tl-group')).toHaveCount(2);
  const viewSaved = page.waitForResponse((r) => r.url().includes('/views/') && r.request().method() === 'PATCH');
  await page.getByLabel('Couleur des barres').selectOption({ label: 'Couleur selon Statut' });
  await viewSaved;
  await expect(page.locator('.tl-item.c-default')).toHaveCount(0);

  // Tableau équivalent : mêmes lignes, dates modifiables.
  await page.getByRole('button', { name: 'Tableau des dates' }).click();
  const table = page.getByRole('table', { name: 'Chronologie sous forme de tableau' });
  await expect(table.locator('tbody tr')).toHaveCount(2);
  await expect(table.getByLabel('Début de Réalisation')).toHaveValue(day(7));
  await expect(table.locator('tbody tr', { hasText: 'Réalisation' })).toContainText('Conception');
  const done5 = patched(page, p.a.id);
  await table.getByLabel('Début de Conception').fill(day(-2));
  await table.getByLabel('Début de Conception').press('Tab');
  await done5;
  rows = await rowsOf(browser, p.id);
  expect(at(p.a.id)[p.debut.id]).toBe(day(-2));

  // Les réglages de la vue sont enregistrés.
  await page.reload();
  await page.getByRole('tab', { name: 'Chronologie' }).click();
  await expect(page.getByLabel('Échelle')).toHaveValue('day');
  await expect(page.locator('.tl-group')).toHaveCount(2);
});

test('chronologie : seules les lignes visibles sont construites', async ({ page, browser }) => {
  const { base, admin } = await newBase(browser, 'Chronologie longue e2e');
  const id = base.page.id;
  const debut = (await (await api(admin.request, 'POST', `/bases/${id}/properties`, { name: 'Début', type: 'date' })).json()) as { id: string };
  for (let i = 0; i < 150; i++) await api(admin.request, 'POST', `/bases/${id}/rows`, { values: { [base.properties[0]!.id]: `Ligne ${i}`, [debut.id]: day(i % 20) } });
  await api(admin.request, 'PATCH', `/bases/${id}/settings`, { startPropertyId: debut.id });
  const detail = (await (await api(admin.request, 'GET', `/bases/${id}`)).json()) as { views: { id: string }[] };
  await api(admin.request, 'PATCH', `/bases/${id}/views/${detail.views[0]!.id}`, { config: { type: 'timeline', scale: 'week', sort: [], filters: [], hidden: [] } });
  await admin.close();
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto(`/p/${id}`);
  await expect(page.locator('.tl-line').first()).toBeVisible();
  expect(await page.locator('.tl-line').count()).toBeLessThan(80);
  // Haut et bas changent de ligne ; la ligne qui a le focus est construite au fil du défilement.
  await page.getByRole('button', { name: /^Ligne 0, le/ }).focus();
  for (let i = 0; i < 60; i++) await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('button', { name: /^Ligne 60, le/ })).toBeFocused();
});

for (const scheme of ['light', 'dark'] as const) {
  test(`accessibilité du mode projet, thème ${scheme}`, async ({ browser }) => {
    const p = await projectBase(browser, `Projet a11y ${scheme}`);
    const admin = await adminContext(browser);
    await api(admin.request, 'POST', `/bases/${p.id}/properties`, { name: 'Liens', type: 'relation', config: { targetId: p.id } });
    await api(admin.request, 'POST', `/bases/${p.id}/rows`, { values: { [p.nom]: 'Sous-tâche' }, parentId: p.a.id });
    await admin.close();
    const ctx = await browser.newContext({ colorScheme: scheme, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await loginUi(page, ADMIN.email, ADMIN.password);
    const found: string[] = [];
    const scan = async (label: string) => {
      const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      found.push(...r.violations.map((v) => `${label} | ${v.id} | ${v.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(' ; ')}`));
    };
    await page.goto(`/p/${p.id}`);
    await expect(page.locator('tbody tr')).toHaveCount(3);
    await scan('tableau projet');
    await page.locator('tbody tr').first().getByRole('button', { name: /Modifier Liens/ }).click();
    await expect(page.locator('.bt-popover input[type="checkbox"]').first()).toBeVisible();
    await scan('sélecteur de relation');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Réglages de la base' }).click();
    await scan('réglages de la base');
    await page.getByRole('button', { name: 'Annuler' }).click();
    await openTimeline(page, p.id);
    await scan('chronologie');
    await page.getByRole('button', { name: 'Tableau des dates' }).click();
    await scan('chronologie en tableau');
    expect(found).toEqual([]);
    await ctx.close();
  });
}
