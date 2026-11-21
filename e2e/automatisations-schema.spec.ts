// Automatisations des bases vues en schéma : bascule Liste / Schéma, création en schéma, aller-retour sans perte, contraintes du
// canevas (un seul déclencheur, chaîne, 5 actions), couleur selon le journal, état « en panne », lecture seule (droits, action
// masquée), téléphone et audit axe (clair et sombre).
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { ADMIN } from './accounts';
import { adminContext, api, createLocalUser, loginUi, PASSWORD, sessionContext } from './helpers';

type Prop = { id: string; name: string; options: { id: string; name: string }[] };

/** Base : Nom (texte), Statut (3 options) et une ligne « Existante ». */
async function autoBase(browser: Browser, title: string) {
  const admin = await adminContext(browser);
  const spaces = (await (await api(admin.request, 'GET', '/spaces')).json()) as { id: string; visibility: string }[];
  const base = (await (await api(admin.request, 'POST', '/bases', { spaceId: spaces.find((s) => s.visibility === 'public')!.id, title })).json()) as { page: { id: string }; properties: { id: string }[] };
  const id = base.page.id;
  const nom = base.properties[0]!.id;
  const statut = (await (await api(admin.request, 'POST', `/bases/${id}/properties`, { name: 'Statut', type: 'status' })).json()) as Prop;
  expect((await api(admin.request, 'POST', `/bases/${id}/rows`, { values: { [nom]: 'Existante' } })).ok()).toBeTruthy();
  await admin.close();
  return { id, nom, statut };
}

const panel = (page: Page) => page.getByRole('dialog', { name: /^Automatisations de/ });
const nodes = (page: Page) => panel(page).locator('.wf-node');
const info = (page: Page) => panel(page).locator('.wf-panel');

async function openSchema(page: Page, baseId: string) {
  await page.goto(`/p/${baseId}`);
  await page.getByRole('button', { name: 'Automatisations' }).click();
  await expect(panel(page).getByRole('button', { name: 'Nouvelle automatisation' })).toBeVisible();
  await panel(page).getByRole('button', { name: 'Schéma', exact: true }).click();
  await expect(panel(page).getByRole('button', { name: 'Schéma', exact: true })).toHaveAttribute('aria-pressed', 'true');
}

async function listAutomations(browser: Browser, baseId: string) {
  const admin = await adminContext(browser);
  const res = (await (await api(admin.request, 'GET', `/bases/${baseId}/automations`)).json()) as { items: { id: string; name: string; trigger: { filters?: unknown[] }; actions: { type: string; value?: unknown }[]; status: string }[] };
  await admin.close();
  return res.items;
}

test('schéma : création d’une automatisation, puis aller-retour Liste et Schéma sans perte', async ({ page, browser }) => {
  const b = await autoBase(browser, 'Schéma automatisations e2e');
  const done = b.statut.options[2]!;
  await page.setViewportSize({ width: 1280, height: 900 });
  await loginUi(page, ADMIN.email, ADMIN.password);
  await openSchema(page, b.id);
  const dlg = panel(page);

  // Nouvelle automatisation : un déclencheur et une action, déjà reliés.
  await expect(dlg.getByLabel('Automatisation', { exact: true })).toHaveValue('new');
  await expect(nodes(page)).toHaveCount(2);
  await dlg.getByLabel('Nom', { exact: true }).fill('Terminer en schéma');

  // Un filtre ajouté s'insère dans la chaîne, avant l'action ; configuré par le panneau.
  await dlg.getByRole('button', { name: 'Ajouter Filtre' }).click();
  await expect(nodes(page)).toHaveCount(3);
  await dlg.getByRole('group', { name: /^Filtre : / }).press('Enter');
  await expect(info(page)).toContainText('Une condition sur la ligne concernée');
  await info(page).getByLabel('Colonne', { exact: true }).selectOption({ label: 'Statut' });
  await info(page).getByLabel('Condition', { exact: true }).selectOption({ index: 0 });
  await info(page).getByLabel('Valeur', { exact: true }).selectOption({ label: b.statut.options[0]!.name });
  await expect(dlg.getByRole('group', { name: /^Filtre : Statut / })).toBeVisible();

  // Action : Statut = Terminé.
  await nodes(page).filter({ hasText: 'Modifier' }).click();
  await info(page).getByLabel('Colonne', { exact: true }).selectOption({ label: 'Statut' });
  await info(page).getByLabel('Valeur de Statut').selectOption({ label: done.name });
  await expect(dlg.getByRole('group', { name: `Action : Modifier « Statut » : ${done.name}` })).toBeVisible();

  // Vue texte : l'ordre des maillons.
  await dlg.getByRole('button', { name: 'Vue texte' }).click();
  const text = dlg.getByRole('list', { name: /Vue texte du schéma/ });
  await expect(text.getByRole('listitem')).toHaveCount(3);
  await expect(text).toContainText('Déclencheur : Quand une ligne est ajoutée. Suite vers Statut est À faire');

  await dlg.getByRole('button', { name: 'Créer' }).click();
  await expect(dlg.getByLabel('Automatisation', { exact: true })).not.toHaveValue('new');
  await expect(nodes(page)).toHaveCount(3);
  const saved = await listAutomations(browser, b.id);
  expect(saved).toHaveLength(1);
  expect(saved[0]!.trigger.filters).toHaveLength(1);
  expect(saved[0]!.actions).toMatchObject([{ type: 'set_property', value: done.id }]);

  // Liste : la même automatisation, résumée.
  await dlg.getByRole('button', { name: 'Liste', exact: true }).click();
  const item = dlg.getByRole('listitem', { name: 'Terminer en schéma' });
  await expect(item).toContainText('Quand une ligne est ajoutée (1 filtre) : Modifier une propriété.');

  // Modification par le formulaire de la liste, puis retour au schéma : rien n'est perdu.
  await dlg.getByRole('button', { name: 'Modifier Terminer en schéma' }).click();
  await expect(dlg.getByRole('group', { name: 'Filtre 1' })).toBeVisible();
  await dlg.getByLabel('Nom', { exact: true }).fill('Terminer (renommée)');
  await dlg.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(dlg.getByRole('listitem', { name: 'Terminer (renommée)' })).toBeVisible();
  await dlg.getByRole('button', { name: 'Schéma', exact: true }).click();
  await expect(dlg.getByLabel('Automatisation', { exact: true })).toHaveValue(saved[0]!.id);
  await expect(dlg.getByLabel('Nom', { exact: true })).toHaveValue('Terminer (renommée)');
  await expect(nodes(page)).toHaveCount(3);
  await nodes(page).filter({ hasText: 'Modifier' }).click();
  await expect(info(page).getByLabel('Valeur de Statut')).toHaveValue(done.id);
  await nodes(page).filter({ hasText: 'Statut' }).first().click();
  await expect(info(page).getByLabel('Valeur', { exact: true })).toHaveValue(b.statut.options[0]!.id);

  // Modification en schéma : retirer le filtre (le lien se referme), enregistrer, la liste n'a plus de filtre.
  await dlg.getByRole('group', { name: /^Filtre : / }).focus();
  await page.keyboard.press('Delete');
  await expect(nodes(page)).toHaveCount(2);
  await expect(dlg.locator('.wf-edge')).toHaveCount(1);
  await dlg.getByRole('button', { name: 'Enregistrer' }).click();
  await expect.poll(async () => (await listAutomations(browser, b.id))[0]!.trigger.filters).toHaveLength(0);

  // Modifications non enregistrées : confirmation avant de quitter le schéma.
  await dlg.getByRole('button', { name: 'Ajouter Action' }).click();
  await dlg.getByRole('button', { name: 'Liste', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'Abandonner les modifications' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Annuler' }).click();
  await expect(dlg.getByRole('button', { name: 'Schéma', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await dlg.getByRole('button', { name: 'Liste', exact: true }).click();
  await page.getByRole('dialog', { name: 'Abandonner les modifications' }).getByRole('button', { name: 'Abandonner' }).click();
  await expect(dlg.getByRole('listitem', { name: 'Terminer (renommée)' })).toBeVisible();
});

test('schéma : contraintes du canevas (un déclencheur, chaîne, 5 actions, bouton sans filtre)', async ({ page, browser }) => {
  const b = await autoBase(browser, 'Schéma contraintes e2e');
  await page.setViewportSize({ width: 1280, height: 900 });
  await loginUi(page, ADMIN.email, ADMIN.password);
  await openSchema(page, b.id);
  const dlg = panel(page);
  const status = dlg.locator('.wf-status');

  // Second déclencheur refusé.
  await dlg.getByRole('button', { name: 'Ajouter Déclencheur' }).click();
  await expect(status).toContainText('Une automatisation n’a qu’un seul déclencheur.');
  await expect(nodes(page)).toHaveCount(2);

  // Cinq actions au plus : la sixième est refusée.
  for (let i = 0; i < 4; i++) await dlg.getByRole('button', { name: 'Ajouter Action' }).click();
  await expect(nodes(page)).toHaveCount(6);
  await dlg.getByRole('button', { name: 'Ajouter Action' }).click();
  await expect(status).toContainText('5 actions au plus.');
  await expect(nodes(page)).toHaveCount(6);
  await expect(dlg.getByText('Filtres : 0 sur 5. Actions : 5 sur 5.')).toBeVisible();

  // Chaîne : une suite et une entrée par nœud, donc rien à relier ici.
  await nodes(page).last().focus();
  await page.keyboard.press('l');
  await expect(dlg.getByRole('menuitem', { name: 'Aucune cible possible' })).toBeDisabled();
  await page.keyboard.press('Escape');

  // Retirer un maillon referme la chaîne ; un bouton de ligne n'a pas de filtre.
  await nodes(page).nth(2).focus();
  await page.keyboard.press('Delete');
  await expect(nodes(page)).toHaveCount(5);
  await expect(dlg.locator('.wf-edge')).toHaveCount(4);
  await nodes(page).first().click();
  await info(page).getByLabel('Quand').selectOption('button');
  await dlg.getByRole('button', { name: 'Ajouter Filtre' }).click();
  await expect(status).toContainText('Un bouton de ligne n’a pas de filtre.');
  await expect(nodes(page)).toHaveCount(5);

  // Enregistrer : l'erreur du serveur (ou de validation) s'affiche près du schéma, sans rien perdre.
  await dlg.getByRole('button', { name: 'Créer' }).click();
  await expect(dlg.getByRole('alert')).toContainText('Donnez un nom à l’automatisation.');
  await expect(nodes(page)).toHaveCount(5);
});

test('schéma : couleur selon le dernier résultat du journal et état « en panne »', async ({ page, browser }) => {
  const b = await autoBase(browser, 'Schéma état e2e');
  const [todo, , done] = b.statut.options;
  const admin = await adminContext(browser);
  const ok = (await (await api(admin.request, 'POST', `/bases/${b.id}/automations`, {
    name: 'Réussie', trigger: { type: 'row_added', filters: [] }, actions: [{ type: 'set_property', propertyId: b.statut.id, value: done!.id }],
  })).json()) as { id: string };
  const broken = (await (await api(admin.request, 'POST', `/bases/${b.id}/automations`, {
    name: 'En panne', trigger: { type: 'button', label: 'Marquer' }, actions: [{ type: 'set_property', propertyId: b.statut.id, value: todo!.id }],
  })).json()) as { id: string };
  // Une exécution réussie pour « Réussie » ; la colonne de « En panne » est supprimée.
  expect((await api(admin.request, 'POST', `/bases/${b.id}/rows`, { values: { [b.nom]: 'Déclenche' } })).ok()).toBeTruthy();
  await expect.poll(async () => ((await (await api(admin.request, 'GET', `/bases/${b.id}/automations/${ok.id}/runs`)).json()) as { items: unknown[] }).items.length).toBe(1);
  const other = (await (await api(admin.request, 'POST', `/bases/${b.id}/properties`, { name: 'Autre', type: 'status' })).json()) as Prop;
  expect((await api(admin.request, 'PATCH', `/bases/${b.id}/automations/${broken.id}`, {
    actions: [{ type: 'set_property', propertyId: other.id, value: other.options[0]!.id }],
  })).ok()).toBeTruthy();
  expect((await api(admin.request, 'DELETE', `/bases/${b.id}/properties/${other.id}`)).ok()).toBeTruthy();
  await admin.close();

  await page.setViewportSize({ width: 1280, height: 900 });
  await loginUi(page, ADMIN.email, ADMIN.password);
  await openSchema(page, b.id);
  const dlg = panel(page);
  const pick = dlg.getByLabel('Automatisation', { exact: true });

  await pick.selectOption({ label: 'Réussie' });
  await expect(nodes(page)).toHaveCount(2);
  await expect(nodes(page).first()).toHaveClass(/wf-color-green/);
  await expect(nodes(page).last()).toHaveClass(/wf-color-green/);
  await expect(dlg.getByText(/Dernier résultat : Réussie \(Réussie\)/)).toBeVisible();
  await expect(nodes(page).first()).toContainText('Dernier résultat : Réussie');

  await pick.selectOption({ label: 'En panne' });
  await expect(nodes(page).first()).toHaveClass(/wf-color-red/);
  await expect(nodes(page).first()).toContainText('En panne');
  await expect(dlg.getByText(/une colonne, une option ou une base qu’elle cite n’existe plus/)).toBeVisible();
});

test('schéma : lecteur sans droit, et action vers une base illisible masquée', async ({ browser }) => {
  const b = await autoBase(browser, 'Schéma droits e2e');
  const admin = await adminContext(browser);
  await createLocalUser(admin.request, 'au-schema-lecteur@e2e.test', 'Lecteur Schéma', 'reader');
  await createLocalUser(admin.request, 'au-schema-editeur@e2e.test', 'Éditeur Schéma', 'editor');
  const space = (await (await api(admin.request, 'POST', '/spaces', { name: 'Espace privé schéma', visibility: 'private' })).json()) as { id: string };
  const hidden = (await (await api(admin.request, 'POST', '/bases', { spaceId: space.id, title: 'Base secrète schéma' })).json()) as { page: { id: string } };
  const made = await api(admin.request, 'POST', `/bases/${b.id}/automations`, {
    name: 'Vers la base secrète', trigger: { type: 'button', label: 'Copier' }, actions: [{ type: 'add_row', baseId: hidden.page.id, values: {} }],
  });
  expect(made.status()).toBe(201);
  await admin.close();

  // Lecteur : aucune entrée « Automatisations », et la route refuse.
  const reader = await sessionContext(browser, 'au-schema-lecteur@e2e.test', PASSWORD);
  const rp = await reader.newPage();
  await rp.setViewportSize({ width: 1280, height: 900 });
  await rp.goto(`/p/${b.id}`);
  await expect(rp.getByRole('button', { name: 'Nouvelle ligne' })).toHaveCount(0);
  await expect(rp.getByRole('button', { name: 'Automatisations' })).toHaveCount(0);
  expect((await reader.request.get(`/api/v3/bases/${b.id}/automations`)).status()).toBe(403);
  await reader.close();

  // Éditeur qui ne lit pas la base visée : le schéma n'en montre rien et reste en lecture seule.
  const editor = await sessionContext(browser, 'au-schema-editeur@e2e.test', PASSWORD);
  const ep = await editor.newPage();
  await ep.setViewportSize({ width: 1280, height: 900 });
  await openSchema(ep, b.id);
  const dlg = panel(ep);
  await expect(dlg.getByText('le schéma est en lecture seule')).toBeVisible();
  await expect(nodes(ep)).toHaveCount(2);
  await expect(nodes(ep).last()).toContainText('Ajouter une ligne dans une base que vous ne voyez pas');
  await expect(dlg).not.toContainText('Base secrète schéma');
  await expect(dlg.getByRole('button', { name: /^Ajouter (Filtre|Action|Déclencheur)$/ })).toHaveCount(0);
  await expect(dlg.getByRole('button', { name: 'Enregistrer' })).toHaveCount(0);
  await nodes(ep).last().click();
  await expect(info(ep).locator('input, select, textarea')).toHaveCount(0);
  await expect(info(ep)).not.toContainText('Base secrète schéma');
  await editor.close();
});

test.describe('téléphone', () => {
  test('schéma sur 375 px : fenêtre et panneau sans défilement horizontal', async ({ browser }) => {
    const b = await autoBase(browser, 'Schéma mobile e2e');
    const ctx = await browser.newContext({ baseURL: 'http://localhost:3100', viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    await loginUi(page, ADMIN.email, ADMIN.password);
    await page.goto(`/p/${b.id}`);
    await page.getByRole('button', { name: 'Plus d’actions' }).click();
    await page.getByRole('menuitem', { name: 'Automatisations' }).click();
    await panel(page).getByRole('button', { name: 'Schéma', exact: true }).click();
    await expect(nodes(page)).toHaveCount(2);
    await nodes(page).first().tap();
    await expect(info(page)).toBeVisible();
    const box = (await panel(page).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(375);
    expect(await panel(page).locator('.modal-body').evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    await ctx.close();
  });
});

for (const scheme of ['light', 'dark'] as const) {
  test(`accessibilité du schéma des automatisations, thème ${scheme}`, async ({ browser }) => {
    const b = await autoBase(browser, `Schéma a11y ${scheme}`);
    const admin = await adminContext(browser);
    expect((await api(admin.request, 'POST', `/bases/${b.id}/automations`, {
      name: 'Marquer terminé', trigger: { type: 'row_added', filters: [{ propertyId: b.statut.id, op: 'eq', value: b.statut.options[0]!.id }] },
      actions: [{ type: 'set_property', propertyId: b.statut.id, value: b.statut.options[2]!.id }],
    })).status()).toBe(201);
    await admin.close();
    const ctx = await browser.newContext({ baseURL: 'http://localhost:3100', colorScheme: scheme, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await loginUi(page, ADMIN.email, ADMIN.password);
    await openSchema(page, b.id);
    await expect(nodes(page)).toHaveCount(3);
    await nodes(page).nth(1).click();
    await expect(info(page)).toBeVisible();
    const r = await new AxeBuilder({ page }).include('dialog.modal').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(r.violations.map((v) => `${v.id} | ${v.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(' ; ')}`)).toEqual([]);
    await ctx.close();
  });
}

test('schéma : fermer la fenêtre avec des modifications non enregistrées demande confirmation (Échap, croix, bouton)', async ({ page, browser }) => {
  const b = await autoBase(browser, 'Schéma fermeture e2e');
  await page.setViewportSize({ width: 1280, height: 900 });
  await loginUi(page, ADMIN.email, ADMIN.password);
  await openSchema(page, b.id);
  const dlg = panel(page);
  const confirm = () => page.getByRole('dialog', { name: 'Abandonner les modifications' });

  // Sans modification : la fenêtre se ferme tout de suite.
  await dlg.getByRole('button', { name: 'Fermer', exact: true }).first().click();
  await expect(dlg).toBeHidden();

  // Avec une modification : Échap, croix et bouton demandent d'abord confirmation ; « Annuler » garde la fenêtre.
  await openSchema(page, b.id);
  await dlg.getByRole('button', { name: 'Ajouter Filtre' }).click();
  await page.keyboard.press('Escape');
  await expect(confirm()).toBeVisible();
  await confirm().getByRole('button', { name: 'Annuler' }).click();
  await expect(dlg).toBeVisible();
  await dlg.locator('.modal-head').getByRole('button', { name: 'Fermer' }).click();
  await expect(confirm()).toBeVisible();
  await confirm().getByRole('button', { name: 'Annuler' }).click();
  await expect(dlg).toBeVisible();
  await dlg.locator('.modal-foot').getByRole('button', { name: 'Fermer' }).click();
  await expect(confirm()).toBeVisible();
  await confirm().getByRole('button', { name: 'Abandonner' }).click();
  await expect(dlg).toBeHidden();
});
