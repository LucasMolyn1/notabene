import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { ADMIN } from './accounts';
import { adminContext, api, createLocalUser, loginUi, PASSWORD, sessionContext } from './helpers';

async function newBaseVia(browser: import('@playwright/test').Browser, title: string) {
  const admin = await adminContext(browser);
  const spaces = (await (await api(admin.request, 'GET', '/spaces')).json()) as { id: string; visibility: string }[];
  const res = await (await api(admin.request, 'POST', '/bases', { spaceId: spaces.find((s) => s.visibility === 'public')!.id, title })).json();
  await admin.close();
  return res as { page: { id: string }; properties: { id: string }[] };
}

test('créer une base, ses colonnes et ses lignes, filtrer, trier, exporter', async ({ page, browser }) => {
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.getByText('Nouvelle base').first().click();
  await expect(page.getByRole('textbox', { name: 'Titre de la base' })).toHaveValue('Nouvelle base');
  await page.getByRole('textbox', { name: 'Titre de la base' }).fill('Inventaire e2e');
  await page.getByRole('textbox', { name: 'Titre de la base' }).press('Tab');

  // Colonne « Quantité » (nombre) et colonne « État » (sélection).
  await page.getByRole('button', { name: 'Ajouter une colonne' }).click();
  await page.getByRole('textbox', { name: 'Nom de la colonne' }).fill('Quantité');
  await page.getByLabel('Type').selectOption('number');
  await page.getByRole('button', { name: 'Ajouter', exact: true }).click();
  await expect(page.getByRole('columnheader', { name: /Quantité/ })).toBeVisible();

  await page.getByRole('button', { name: 'Ajouter une colonne' }).click();
  await page.getByRole('textbox', { name: 'Nom de la colonne' }).fill('État');
  await page.getByLabel('Type').selectOption('select');
  await page.getByRole('button', { name: 'Ajouter une option' }).click();
  await page.getByRole('textbox', { name: 'Option 1' }).fill('Neuf');
  await page.getByRole('button', { name: 'Ajouter une option' }).click();
  await page.getByRole('textbox', { name: 'Option 2' }).fill('Usé');
  await page.getByRole('button', { name: 'Ajouter', exact: true }).click();
  await expect(page.getByRole('columnheader', { name: /État/ })).toBeVisible();

  // Deux lignes.
  for (const [nom, qte, etat] of [['Marteau <b>x</b>', '3', 'Neuf'], ['Tournevis', '12', 'Usé']] as const) {
    await page.getByRole('button', { name: 'Nouvelle ligne' }).click();
    const row = page.locator('tbody tr').last();
    await row.getByRole('button', { name: /modifier Nom\)?$/i }).click();
    await page.getByRole('textbox', { name: 'Nom' }).fill(nom);
    await page.keyboard.press('Enter');
    await row.getByRole('button', { name: /modifier Quantité\)?$/i }).click();
    await page.getByRole('spinbutton', { name: 'Quantité' }).fill(qte);
    await page.keyboard.press('Enter');
    await row.getByRole('button', { name: /modifier État\)?$/i }).click();
    await page.getByRole('combobox', { name: 'État' }).selectOption({ label: etat });
    await expect(row.getByText(etat)).toBeVisible();
  }
  // Le texte est affiché tel quel, jamais interprété.
  await expect(page.locator('tbody tr').first().getByText('Marteau <b>x</b>')).toBeVisible();
  await expect(page.locator('tbody tr b')).toHaveCount(0);

  // Persistant après rechargement.
  await page.reload();
  await expect(page.locator('tbody tr')).toHaveCount(2);

  // Tri décroissant par quantité.
  await page.getByRole('button', { name: /Trier/ }).click();
  await page.getByRole('button', { name: 'Ajouter un tri' }).click();
  await page.locator('.bt-popover').getByLabel('Colonne', { exact: true }).selectOption({ label: 'Quantité' });
  await page.locator('.bt-popover').getByLabel('Sens').selectOption('desc');
  await expect(page.locator('tbody tr').first()).toContainText('Tournevis');
  await page.keyboard.press('Escape');

  // Filtre : état = Neuf.
  await page.getByRole('button', { name: /Filtrer/ }).click();
  await page.getByRole('button', { name: 'Ajouter un filtre' }).click();
  await page.locator('.bt-popover').getByLabel('Colonne', { exact: true }).selectOption({ label: 'État' });
  await page.locator('.bt-popover').getByLabel('Valeur').selectOption({ label: 'Neuf' });
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.locator('tbody tr').first()).toContainText('Marteau');
  await page.keyboard.press('Escape');

  // Les réglages de la vue sont enregistrés pour tout le monde (envoi différé de 500 ms).
  await page.waitForResponse((r) => r.url().includes('/views/') && r.request().method() === 'PATCH' && r.ok());
  await page.reload();
  await expect(page.locator('tbody tr')).toHaveCount(1);

  // Export CSV.
  const csv = await page.request.get(await page.getByRole('link', { name: /CSV/ }).getAttribute('href') as string);
  expect(csv.status()).toBe(200);
  expect(await csv.text()).toContain('Tournevis');

  // Suppression d'une ligne avec confirmation.
  await page.getByRole('button', { name: /Filtrer/ }).click();
  await page.getByRole('button', { name: 'Retirer le filtre' }).click();
  await page.keyboard.press('Escape');
  await page.locator('tbody tr').first().getByRole('button', { name: 'Supprimer la ligne' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Supprimer' }).click();
  await expect(page.locator('tbody tr')).toHaveCount(1);
  void browser;
});

test('modifier les cellules de chaque type : date, case, multi-sélection, personne, page', async ({ page, browser }) => {
  const base = await newBaseVia(browser, 'Base types e2e');
  const admin = await adminContext(browser);
  await createLocalUser(admin.request, 'base.pick@e2e.test', 'Personne à choisir', 'editor');
  const spaces = (await (await api(admin.request, 'GET', '/spaces')).json()) as { id: string; visibility: string }[];
  await api(admin.request, 'POST', '/pages', { spaceId: spaces.find((s) => s.visibility === 'public')!.id, title: 'Page cible e2e' });
  for (const body of [
    { name: 'Date', type: 'date' }, { name: 'Fait', type: 'checkbox' },
    { name: 'Tags', type: 'multi_select', options: [{ name: 'alpha', color: 'blue' }, { name: 'beta', color: 'pink' }] },
    { name: 'Responsable', type: 'person' }, { name: 'Page', type: 'page_link' },
  ]) await api(admin.request, 'POST', `/bases/${base.page.id}/properties`, body);
  await api(admin.request, 'POST', `/bases/${base.page.id}/rows`, { values: {} });
  await admin.close();

  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto(`/p/${base.page.id}`);
  const row = page.locator('tbody tr').first();

  await row.getByRole('button', { name: /modifier Date/i }).click();
  await page.getByLabel('Date', { exact: true }).fill('2026-12-31');
  await page.keyboard.press('Enter');
  await expect(row.getByText('31/12/2026')).toBeVisible();

  await row.getByRole('checkbox', { name: 'Fait' }).check();
  await expect(row.getByRole('checkbox', { name: 'Fait' })).toBeChecked();

  await row.getByRole('button', { name: /modifier Tags/i }).click();
  await page.getByText('beta', { exact: true }).click();
  await page.getByRole('button', { name: 'Appliquer' }).click();
  await expect(row.getByText('beta')).toBeVisible();

  await row.getByRole('button', { name: /modifier Responsable/i }).click();
  await page.getByRole('searchbox', { name: 'Rechercher une personne' }).fill('Personne à');
  await page.getByRole('button', { name: 'Personne à choisir' }).click();
  await expect(row.getByText('Personne à choisir')).toBeVisible();

  await row.getByRole('button', { name: /modifier Page/i }).click();
  await page.getByRole('searchbox', { name: 'Rechercher une page' }).fill('Page cible');
  await page.getByRole('button', { name: 'Page cible e2e' }).click();
  await expect(row.getByRole('link', { name: 'Page cible e2e' })).toBeVisible();

  await page.reload();
  const again = page.locator('tbody tr').first();
  await expect(again.getByText('31/12/2026')).toBeVisible();
  await expect(again.getByText('beta')).toBeVisible();
  await expect(again.getByText('Personne à choisir')).toBeVisible();
  await expect(again.getByRole('link', { name: 'Page cible e2e' })).toBeVisible();
});

test('une colonne calculée se crée depuis l’interface, se met à jour et ne se modifie pas', async ({ page, browser }) => {
  const base = await newBaseVia(browser, 'Base formules e2e');
  const admin = await adminContext(browser);
  const prix = (await (await api(admin.request, 'POST', `/bases/${base.page.id}/properties`, { name: 'Prix', type: 'number' })).json()).id as string;
  await api(admin.request, 'POST', `/bases/${base.page.id}/rows`, { values: { [prix]: 4 } });
  await admin.close();

  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto(`/p/${base.page.id}`);
  await page.getByRole('button', { name: 'Ajouter une colonne' }).click();
  await page.getByRole('textbox', { name: 'Nom de la colonne' }).fill('Double');
  await page.getByLabel('Type', { exact: true }).selectOption('formula');
  // Une formule invalide est refusée avec une explication.
  await page.getByRole('textbox', { name: 'Formule' }).fill('prop("Prix") *');
  await page.getByRole('button', { name: 'Ajouter', exact: true }).click();
  await expect(page.getByText(/Formule : Expression incomplète/)).toBeVisible();
  await page.getByRole('textbox', { name: 'Formule' }).fill('prop("Prix") * 2');
  await page.getByRole('button', { name: 'Ajouter', exact: true }).click();
  const row = page.locator('tbody tr').first();
  await expect(row.getByRole('cell', { name: '8' })).toBeVisible();
  await expect(row.getByRole('button', { name: /modifier Double/i })).toHaveCount(0);

  // Modifier la cellule source recalcule.
  await row.getByRole('button', { name: /modifier Prix/i }).click();
  await page.getByRole('spinbutton', { name: 'Prix' }).fill('10');
  await page.keyboard.press('Enter');
  await expect(row.getByRole('cell', { name: '20' })).toBeVisible();
});

test('un lecteur voit la base sans pouvoir la modifier', async ({ browser }) => {
  const base = await newBaseVia(browser, 'Base lecture seule e2e');
  const admin = await adminContext(browser);
  await createLocalUser(admin.request, 'base.reader@e2e.test', 'Lectrice base', 'reader');
  await api(admin.request, 'POST', `/bases/${base.page.id}/rows`, { values: { [base.properties[0]!.id]: 'ligne visible' } });
  await admin.close();
  const ctx = await sessionContext(browser, 'base.reader@e2e.test', PASSWORD);
  const page = await ctx.newPage();
  await page.goto(`/p/${base.page.id}`);
  await expect(page.getByText('ligne visible')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Nouvelle ligne' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Ajouter une colonne' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /modifier Nom\)?$/i })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Titre de la base' })).toBeDisabled();
  // Tri et filtre restent possibles pour elle, sans rien enregistrer.
  await page.getByRole('button', { name: /Filtrer/ }).click();
  await expect(page.getByRole('button', { name: 'Ajouter un filtre' })).toBeVisible();
  await ctx.close();
});

test('une modification faite ailleurs apparaît sans recharger', async ({ browser }) => {
  const base = await newBaseVia(browser, 'Base temps réel e2e');
  const a = await adminContext(browser);
  const page = await a.newPage();
  await page.goto(`/p/${base.page.id}`);
  await expect(page.getByRole('textbox', { name: 'Titre de la base' })).toBeVisible();
  const other = await adminContext(browser);
  await api(other.request, 'POST', `/bases/${base.page.id}/rows`, { values: { [base.properties[0]!.id]: 'arrivée à distance' } });
  await expect(page.getByText('arrivée à distance')).toBeVisible({ timeout: 10_000 });
  await other.close();
  await a.close();
});

for (const scheme of ['light', 'dark'] as const) {
  test(`accessibilité d’une base, thème ${scheme}`, async ({ browser }) => {
    const base = await newBaseVia(browser, `Base a11y ${scheme}`);
    const admin = await adminContext(browser);
    const sel = await (await api(admin.request, 'POST', `/bases/${base.page.id}/properties`, { name: 'Statut', type: 'status' })).json() as { id: string; options: { id: string }[] };
    await api(admin.request, 'POST', `/bases/${base.page.id}/properties`, { name: 'Tags', type: 'multi_select', options: [{ name: 'a', color: 'yellow' }, { name: 'b', color: 'purple' }] });
    for (const [i, o] of sel.options.entries()) await api(admin.request, 'POST', `/bases/${base.page.id}/rows`, { values: { [base.properties[0]!.id]: `Ligne ${i}`, [sel.id]: o.id } });
    await admin.close();
    const ctx = await browser.newContext({ colorScheme: scheme, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await loginUi(page, ADMIN.email, ADMIN.password);
    await page.goto(`/p/${base.page.id}`);
    await expect(page.locator('tbody tr')).toHaveCount(3);
    const found: string[] = [];
    const scan = async (label: string) => {
      const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      found.push(...r.violations.map((v) => `${label} | ${v.id} | ${v.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(' ; ')}`));
    };
    await scan('tableau');
    await page.getByRole('button', { name: /Filtrer/ }).click();
    await page.getByRole('button', { name: 'Ajouter un filtre' }).click();
    await scan('filtres');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Ajouter une colonne' }).click();
    await scan('nouvelle colonne');
    expect(found).toEqual([]);
    await ctx.close();
  });
}
