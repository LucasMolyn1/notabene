// Automatisations des bases : création par le panneau (ligne ajoutée, bouton, notification), déclenchement, bouton de ligne,
// journal, désactivation ; réglage d'administration des webhooks et secret montré une seule fois ; axe en clair et en sombre ;
// téléphone (375 px).
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { ADMIN } from './accounts';
import { adminContext, api, loginUi } from './helpers';

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

async function setWebhooks(browser: Browser, on: boolean) {
  const admin = await adminContext(browser);
  expect((await api(admin.request, 'PUT', '/admin/automations', { webhooks: on })).ok()).toBeTruthy();
  await admin.close();
}

const panel = (page: Page) => page.getByRole('dialog', { name: /^Automatisations de/ });

async function openPanel(page: Page) {
  await page.getByRole('button', { name: 'Automatisations' }).click();
  await expect(panel(page).getByRole('button', { name: 'Nouvelle automatisation' })).toBeVisible();
}

test('automatisations : ligne ajoutée, bouton de ligne, notification, journal et désactivation', async ({ page, browser }) => {
  const b = await autoBase(browser, 'Automatisations e2e');
  const [todo, , done] = b.statut.options;
  await page.setViewportSize({ width: 1280, height: 900 });
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto(`/p/${b.id}`);
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await openPanel(page);
  const dlg = panel(page);
  await expect(dlg.getByText('Aucune automatisation pour le moment.')).toBeVisible();

  // 1. « Quand une ligne est ajoutée » : Statut = Terminé.
  await dlg.getByRole('button', { name: 'Nouvelle automatisation' }).click();
  await expect(dlg.getByLabel('Nom', { exact: true })).toBeFocused();
  await dlg.getByLabel('Nom', { exact: true }).fill('Terminer à l’ajout');
  await expect(dlg.getByLabel('Quand')).toHaveValue('row_added');
  const action1 = dlg.getByRole('group', { name: 'Action 1' });
  await action1.getByLabel('Colonne', { exact: true }).selectOption({ label: 'Statut' });
  await action1.getByLabel('Valeur de Statut').selectOption({ label: done!.name });
  await dlg.getByRole('button', { name: 'Créer' }).click();
  const item1 = dlg.getByRole('listitem', { name: 'Terminer à l’ajout' });
  await expect(item1).toContainText('Active');
  await expect(item1).toContainText('Quand une ligne est ajoutée : Modifier une propriété.');

  // 2. Bouton « Rouvrir » : Statut = À faire, et notification de la personne connectée.
  await dlg.getByRole('button', { name: 'Nouvelle automatisation' }).click();
  await dlg.getByLabel('Nom', { exact: true }).fill('Rouvrir');
  await dlg.getByLabel('Quand').selectOption('button');
  await dlg.getByLabel('Libellé du bouton').fill('Rouvrir');
  await action1.getByLabel('Colonne', { exact: true }).selectOption({ label: 'Statut' });
  await action1.getByLabel('Valeur de Statut').selectOption({ label: todo!.name });
  await dlg.getByRole('button', { name: /^Ajouter une action/ }).click();
  const action2 = dlg.getByRole('group', { name: 'Action 2' });
  await expect(action2.getByLabel('Type d’action')).toBeFocused();
  await action2.getByLabel('Type d’action').selectOption('notify');
  // Sans destinataire : message d'erreur près du formulaire, focalisé.
  await dlg.getByRole('button', { name: 'Créer' }).click();
  await expect(dlg.getByRole('alert')).toContainText('Action 2 : choisissez au moins une personne');
  await action2.getByRole('searchbox', { name: 'Ajouter une personne' }).fill('Admin');
  await action2.getByRole('button', { name: 'Admin E2E' }).click();
  await expect(action2.getByRole('list', { name: 'Personnes notifiées' })).toContainText('Admin E2E');
  await dlg.getByRole('button', { name: 'Créer' }).click();
  await expect(dlg.getByRole('listitem', { name: 'Rouvrir' })).toContainText('Bouton « Rouvrir » sur chaque ligne');
  await expect(dlg.getByRole('listitem', { name: 'Rouvrir' })).toContainText('Agit avec les droits de la personne qui clique');
  await dlg.getByRole('button', { name: 'Fermer' }).last().click();

  // Déclenchement : une nouvelle ligne reçoit « Terminé » ; le bouton apparaît sur chaque ligne.
  await page.getByRole('button', { name: 'Nouvelle ligne' }).click();
  await expect(page.locator('tbody tr')).toHaveCount(2);
  await expect(page.locator('tbody tr').nth(1)).toContainText(done!.name);
  await expect(page.getByRole('columnheader', { name: 'Boutons' })).toBeVisible();
  const run = page.waitForResponse((r) => r.url().includes('/run') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Rouvrir (Sans titre)' }).click();
  expect((await run).ok()).toBeTruthy();
  await expect(page.locator('.toast').filter({ hasText: '« Rouvrir » : fait.' })).toBeVisible();
  await expect(page.locator('tbody tr').nth(1)).toContainText(todo!.name);
  await expect(page.locator('tbody tr').nth(1)).not.toContainText(done!.name);
  // Le focus reste sur le bouton après le nouveau rendu.
  await expect(page.getByRole('button', { name: 'Rouvrir (Sans titre)' })).toBeFocused();

  // Notification « automation » dans la cloche.
  await page.getByRole('button', { name: /^Notifications, \d+ non lue/ }).click();
  await expect(page.getByRole('dialog', { name: 'Notifications' })).toContainText('Une automatisation vous a notifié depuis la base Automatisations e2e');
  await page.getByRole('dialog', { name: 'Notifications' }).getByRole('button', { name: 'Fermer' }).last().click();

  // Journal, puis désactivation du bouton : il disparaît des lignes.
  await openPanel(page);
  await dlg.getByRole('button', { name: 'Journal de Terminer à l’ajout' }).click();
  const runs = dlg.getByRole('table', { name: 'Journal de Terminer à l’ajout' });
  await expect(runs.getByRole('row')).toHaveCount(2);
  await expect(runs).toContainText('Réussie');
  await expect(runs).toContainText('Admin E2E');
  await dlg.getByRole('button', { name: 'Retour à la liste' }).click();
  await dlg.getByRole('button', { name: 'Désactiver Rouvrir' }).click();
  await expect(dlg.getByRole('listitem', { name: 'Rouvrir' })).toContainText('Désactivée');
  await expect(dlg.getByRole('button', { name: 'Activer Rouvrir' })).toBeFocused();
  await dlg.getByRole('button', { name: 'Fermer' }).last().click();
  await expect(page.getByRole('button', { name: 'Rouvrir (Sans titre)' })).toHaveCount(0);

  // Modification : le formulaire reprend la configuration.
  await openPanel(page);
  await dlg.getByRole('button', { name: 'Modifier Terminer à l’ajout' }).click();
  await expect(dlg.getByLabel('Nom', { exact: true })).toHaveValue('Terminer à l’ajout');
  await expect(dlg.getByRole('group', { name: 'Action 1' }).getByLabel('Valeur de Statut')).toHaveValue(done!.id);
  await dlg.getByRole('button', { name: 'Annuler' }).click();

  // Suppression.
  await dlg.getByRole('button', { name: 'Supprimer Terminer à l’ajout' }).click();
  await page.getByRole('dialog', { name: 'Supprimer l’automatisation' }).getByRole('button', { name: 'Supprimer' }).click();
  await expect(dlg.getByRole('listitem', { name: 'Terminer à l’ajout' })).toHaveCount(0);
});

test('webhooks d’automatisation : réglage d’administration, secret montré une seule fois', async ({ page, browser }) => {
  const b = await autoBase(browser, 'Webhook automatisation e2e');
  await setWebhooks(browser, false);
  await page.setViewportSize({ width: 1280, height: 900 });
  await loginUi(page, ADMIN.email, ADMIN.password);

  // Désactivé par défaut : l'action est proposée mais désactivée.
  await page.goto(`/p/${b.id}`);
  await openPanel(page);
  const dlg = panel(page);
  await dlg.getByRole('button', { name: 'Nouvelle automatisation' }).click();
  await expect(dlg.getByRole('group', { name: 'Action 1' }).getByRole('option', { name: /Appeler un webhook \(désactivé par l’administrateur\)/ })).toBeDisabled();
  await dlg.getByRole('button', { name: 'Fermer' }).last().click();

  // Réglage d'administration.
  await page.goto('/settings');
  await page.locator('.set-nav-item').filter({ hasText: /^Webhooks$/ }).click();
  const toggle = page.getByLabel('Autoriser les webhooks d’automatisation');
  await expect(toggle).not.toBeChecked();
  const put = page.waitForResponse((r) => r.url().endsWith('/admin/automations') && r.request().method() === 'PUT');
  await page.locator('.switch-row').filter({ hasText: 'Autoriser les webhooks d’automatisation' }).click();
  expect((await put).ok()).toBeTruthy();
  await expect(toggle).toBeChecked();

  // Création d'un bouton avec webhook (adresse IP publique : aucune résolution, jamais appelée ici) ; secret montré une fois.
  await page.goto(`/p/${b.id}`);
  await openPanel(page);
  await dlg.getByRole('button', { name: 'Nouvelle automatisation' }).click();
  await dlg.getByLabel('Nom', { exact: true }).fill('Prévenir le service');
  await dlg.getByLabel('Quand').selectOption('button');
  await dlg.getByLabel('Libellé du bouton').fill('Prévenir');
  const action1 = dlg.getByRole('group', { name: 'Action 1' });
  await action1.getByLabel('Type d’action').selectOption('webhook');
  await action1.getByLabel('Adresse du webhook').fill('https://1.1.1.1/notabene-e2e');
  await dlg.getByRole('button', { name: 'Créer' }).click();
  const secret = dlg.getByLabel('Secret du webhook', { exact: true });
  await expect(secret).toHaveValue(/^whsec_/);
  await expect(dlg.getByRole('button', { name: 'Copier le secret' })).toBeFocused();
  await expect(dlg.getByRole('listitem', { name: 'Prévenir le service' })).toContainText('Appeler un webhook');
  // Le secret n'est plus montré ensuite ; la modification garde l'adresse sans la redemander.
  await dlg.getByRole('button', { name: 'Modifier Prévenir le service' }).click();
  await expect(dlg.getByText('Adresse enregistrée sur https://1.1.1.1. Laissez vide pour la garder.')).toBeVisible();
  await dlg.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(dlg.getByRole('listitem', { name: 'Prévenir le service' })).toBeVisible();
  await expect(dlg.getByLabel('Secret du webhook', { exact: true })).toHaveCount(0);
  await dlg.getByRole('button', { name: 'Supprimer Prévenir le service' }).click();
  await page.getByRole('dialog', { name: 'Supprimer l’automatisation' }).getByRole('button', { name: 'Supprimer' }).click();
  await expect(dlg.getByRole('listitem', { name: 'Prévenir le service' })).toHaveCount(0);
  await setWebhooks(browser, false);
});

for (const scheme of ['light', 'dark'] as const) {
  test(`accessibilité des automatisations, thème ${scheme}`, async ({ browser }) => {
    const b = await autoBase(browser, `Automatisations a11y ${scheme}`);
    const admin = await adminContext(browser);
    const created = await api(admin.request, 'POST', `/bases/${b.id}/automations`, {
      name: 'Marquer terminé', trigger: { type: 'button', label: 'Terminer' }, actions: [{ type: 'set_property', propertyId: b.statut.id, value: b.statut.options[2]!.id }],
    });
    expect(created.status()).toBe(201);
    await admin.close();
    const ctx = await browser.newContext({ colorScheme: scheme, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await loginUi(page, ADMIN.email, ADMIN.password);
    const found: string[] = [];
    const scan = async (label: string) => {
      const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      found.push(...r.violations.map((v) => `${label} | ${v.id} | ${v.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(' ; ')}`));
    };
    await page.goto(`/p/${b.id}`);
    await expect(page.getByRole('button', { name: 'Terminer (Existante)' })).toBeVisible();
    await scan('tableau avec boutons');
    await openPanel(page);
    await scan('liste des automatisations');
    const dlg = panel(page);
    await dlg.getByRole('button', { name: 'Nouvelle automatisation' }).click();
    await dlg.getByLabel('Quand').selectOption('recurrence');
    await dlg.getByRole('button', { name: 'Ajouter un filtre' }).click();
    await dlg.getByRole('button', { name: /^Ajouter une action/ }).click();
    await dlg.getByRole('group', { name: 'Action 2' }).getByLabel('Type d’action').selectOption('notify');
    await scan('formulaire');
    await dlg.getByRole('button', { name: 'Retour à la liste' }).click();
    await dlg.getByRole('button', { name: 'Journal de Marquer terminé' }).click();
    await scan('journal');
    expect(found).toEqual([]);
    await ctx.close();
  });
}

test('automatisations sur téléphone (375 px) : panneau et boutons sans défilement horizontal', async ({ browser }) => {
  const b = await autoBase(browser, 'Automatisations mobile');
  const admin = await adminContext(browser);
  expect((await api(admin.request, 'POST', `/bases/${b.id}/automations`, {
    name: 'Marquer terminé', trigger: { type: 'button', label: 'Terminer' }, actions: [{ type: 'set_property', propertyId: b.statut.id, value: b.statut.options[2]!.id }],
  })).status()).toBe(201);
  await admin.close();
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto(`/p/${b.id}`);
  const btn = page.getByRole('button', { name: 'Terminer (Existante)' });
  await btn.scrollIntoViewIfNeeded();
  await btn.click();
  await expect(page.locator('tbody tr').first()).toContainText(b.statut.options[2]!.name);
  await openPanel(page);
  const dlg = panel(page);
  const box = (await dlg.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(375);
  await dlg.getByRole('button', { name: 'Nouvelle automatisation' }).click();
  await dlg.getByLabel('Quand').selectOption('recurrence');
  await dlg.getByRole('button', { name: 'Ajouter un filtre' }).click();
  // Aucun champ du formulaire ne déborde du panneau.
  const overflow = await dlg.locator('.modal-body').evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await ctx.close();
});

test('automatisation : nom de la personne et titre de la page choisies, lus dans les libellés du serveur', async ({ page, browser }) => {
  const b = await autoBase(browser, 'Automatisations libellés e2e');
  const admin = await adminContext(browser);
  const me = (await (await admin.request.get('/api/v3/me')).json()) as { user: { id: string } };
  const qui = (await (await api(admin.request, 'POST', `/bases/${b.id}/properties`, { name: 'Responsable', type: 'person' })).json()) as Prop;
  const lien = (await (await api(admin.request, 'POST', `/bases/${b.id}/properties`, { name: 'Référence', type: 'page_link' })).json()) as Prop;
  expect((await api(admin.request, 'POST', `/bases/${b.id}/automations`, {
    name: 'Attribuer', trigger: { type: 'button', label: 'Attribuer' },
    actions: [{ type: 'set_property', propertyId: qui.id, value: me.user.id }, { type: 'set_property', propertyId: lien.id, value: b.id }],
  })).status()).toBe(201);
  await admin.close();
  await page.setViewportSize({ width: 1280, height: 900 });
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto(`/p/${b.id}`);
  await openPanel(page);
  const dlg = panel(page);
  await dlg.getByRole('button', { name: 'Modifier Attribuer' }).click();
  // Le nom et le titre remplacent le texte générique.
  const a1 = dlg.getByRole('group', { name: 'Action 1' });
  await expect(a1.locator('.au-chosen')).toContainText('Admin E2E');
  await expect(a1).not.toContainText('Personne déjà choisie');
  const a2 = dlg.getByRole('group', { name: 'Action 2' });
  await expect(a2.locator('.au-chosen')).toContainText('Automatisations libellés e2e');
  await expect(a2).not.toContainText('Page déjà choisie');
  await dlg.getByRole('button', { name: 'Annuler' }).click();
});

test('chronologie : boutons de ligne dans la fiche d’une barre et dans le tableau des dates, focus conservé', async ({ page, browser }) => {
  const b = await autoBase(browser, 'Chronologie boutons e2e');
  const [todo, , done] = b.statut.options;
  const admin = await adminContext(browser);
  const debut = (await (await api(admin.request, 'POST', `/bases/${b.id}/properties`, { name: 'Début', type: 'date' })).json()) as Prop;
  const detail = (await (await api(admin.request, 'GET', `/bases/${b.id}`)).json()) as { rows: { id: string }[]; views: { id: string }[] };
  const today = new Date().toISOString().slice(0, 10);
  expect((await api(admin.request, 'PATCH', `/bases/${b.id}/rows/${detail.rows[0]!.id}`, { values: { [debut.id]: today, [b.statut.id]: todo!.id } })).ok()).toBeTruthy();
  expect((await api(admin.request, 'PATCH', `/bases/${b.id}/settings`, { startPropertyId: debut.id })).ok()).toBeTruthy();
  expect((await api(admin.request, 'PATCH', `/bases/${b.id}/views/${detail.views[0]!.id}`, { config: { type: 'timeline', scale: 'week', sort: [], filters: [], hidden: [] } })).ok()).toBeTruthy();
  expect((await api(admin.request, 'POST', `/bases/${b.id}/automations`, {
    name: 'Marquer terminé', trigger: { type: 'button', label: 'Terminer' }, actions: [{ type: 'set_property', propertyId: b.statut.id, value: done!.id }],
  })).status()).toBe(201);
  await admin.close();
  await page.setViewportSize({ width: 1280, height: 900 });
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto(`/p/${b.id}`);

  // Barres : Entrée sur la barre ouvre la fiche, qui porte les boutons ; le clic ferme la fiche et rend le focus à la barre.
  const bar = page.getByRole('button', { name: /^Existante, le/ });
  await bar.focus();
  await page.keyboard.press('Enter');
  const fiche = page.getByRole('form', { name: 'Dates de Existante' });
  await expect(fiche.getByRole('group', { name: 'Boutons de Existante' })).toBeVisible();
  const run = page.waitForResponse((r) => r.url().includes('/run') && r.request().method() === 'POST');
  await fiche.getByRole('button', { name: 'Terminer (Existante)' }).click();
  expect((await run).ok()).toBeTruthy();
  await expect(page.locator('.toast').filter({ hasText: '« Terminer » : fait.' })).toBeVisible();
  await expect(fiche).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Existante, le/ })).toBeFocused();

  // Tableau des dates : colonne « Boutons », focus gardé sur le bouton après le nouveau rendu.
  await page.getByRole('button', { name: 'Tableau des dates' }).click();
  const table = page.getByRole('table', { name: 'Chronologie sous forme de tableau' });
  await expect(table.getByRole('columnheader', { name: 'Boutons' })).toBeVisible();
  const run2 = page.waitForResponse((r) => r.url().includes('/run') && r.request().method() === 'POST');
  await table.getByRole('button', { name: 'Terminer (Existante)' }).click();
  expect((await run2).ok()).toBeTruthy();
  await expect(page.getByRole('button', { name: 'Terminer (Existante)' })).toBeFocused();
});
