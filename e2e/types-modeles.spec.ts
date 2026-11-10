// Nouveaux types de colonne (adresse web, courriel, téléphone, identifiant unique, colonnes tenues par le serveur, plage de dates),
// leur lecture par la chronologie et le calendrier, et les modèles de ligne (créer depuis une ligne, appliquer, renommer, supprimer).
import { expect, test, type Browser } from '@playwright/test';
import { ADMIN } from './accounts';
import { adminContext, api, loginUi } from './helpers';

type Prop = { id: string; name: string; options: { id: string; name: string }[] };
type Row = { id: string; values: Record<string, unknown> };

const frDate = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('fr-FR');
function day(days: number) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function typedBase(browser: Browser, title: string) {
  const admin = await adminContext(browser);
  const me = (await (await admin.request.get('/api/v3/me')).json()) as { user: { id: string; name: string } };
  const spaces = (await (await api(admin.request, 'GET', '/spaces')).json()) as { id: string; visibility: string }[];
  const base = (await (await api(admin.request, 'POST', '/bases', { spaceId: spaces.find((s) => s.visibility === 'public')!.id, title })).json()) as { page: { id: string }; properties: { id: string }[] };
  const id = base.page.id;
  const nom = base.properties[0]!.id;
  const prop = async (body: object) => {
    const res = await api(admin.request, 'POST', `/bases/${id}/properties`, body);
    expect(res.ok(), JSON.stringify(body)).toBeTruthy();
    return (await res.json()) as Prop;
  };
  const site = await prop({ name: 'Site', type: 'url' });
  const mail = await prop({ name: 'Courriel', type: 'email' });
  const tel = await prop({ name: 'Téléphone', type: 'phone' });
  const statut = await prop({ name: 'Statut', type: 'status' });
  const periode = await prop({ name: 'Période', type: 'date_range' });
  const row = async (values: Record<string, unknown>) => {
    const res = await api(admin.request, 'POST', `/bases/${id}/rows`, { values });
    expect(res.ok(), JSON.stringify(values)).toBeTruthy();
    return (await res.json()) as Row;
  };
  const a = await row({ [nom]: 'Alpha', [site.id]: 'https://exemple.fr/doc/guide?x=1', [mail.id]: 'jean.dupont@exemple.fr', [tel.id]: '+33 1 23 45 67 89', [statut.id]: statut.options[1]!.id, [periode.id]: { start: day(0), end: day(3) } });
  const b = await row({ [nom]: 'Bêta' });
  // Colonnes ajoutées après les lignes : l'identifiant numérote les lignes existantes dans l'ordre.
  const uid = await prop({ name: 'Réf', type: 'unique_id', config: { prefix: 'TCH' } });
  const creation = await prop({ name: 'Créée le', type: 'created_time' });
  const auteur = await prop({ name: 'Créée par', type: 'created_by' });
  await admin.close();
  return { id, nom, site, mail, tel, statut, periode, uid, creation, auteur, a, b, me: me.user };
}

async function rowsOf(browser: Browser, baseId: string) {
  const admin = await adminContext(browser);
  const data = (await (await api(admin.request, 'GET', `/bases/${baseId}`)).json()) as { rows: Row[]; rowTemplates?: { id: string; name: string; values: Record<string, unknown> }[] };
  await admin.close();
  return data;
}

test('types : liens sûrs, identifiant, colonnes tenues par le serveur, plage de dates', async ({ page, browser }) => {
  const p = await typedBase(browser, 'Types e2e');

  // Le serveur refuse les adresses dangereuses (schéma, identifiants, retour à la ligne).
  const admin = await adminContext(browser);
  for (const bad of ['javascript:alert(1)', 'https://user:pass@exemple.fr', 'data:text/html,x', 'https://exemple.fr/\r\nx']) {
    expect((await api(admin.request, 'PATCH', `/bases/${p.id}/rows/${p.b.id}`, { values: { [p.site.id]: bad } })).status(), bad).toBe(400);
  }
  expect((await api(admin.request, 'PATCH', `/bases/${p.id}/rows/${p.b.id}`, { values: { [p.uid.id]: 'TCH-99' } })).status()).toBe(400);
  await admin.close();

  await page.setViewportSize({ width: 1600, height: 950 });
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto(`/p/${p.id}`);
  const rowA = page.locator(`tr[data-row="${p.a.id}"]`);
  const rowB = page.locator(`tr[data-row="${p.b.id}"]`);

  // Liens construits par le DOM : texte = hôte et chemin ; rel et cible ; mailto et tel encodés.
  const link = rowA.getByRole('link', { name: /exemple\.fr\/doc\/guide/ });
  await expect(link).toHaveAttribute('href', 'https://exemple.fr/doc/guide?x=1');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer nofollow');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(rowA.getByRole('link', { name: 'jean.dupont@exemple.fr' })).toHaveAttribute('href', 'mailto:jean.dupont@exemple.fr');
  await expect(rowA.getByRole('link', { name: '+33 1 23 45 67 89' })).toHaveAttribute('href', 'tel:+33123456789');

  // Identifiant : numéros dans l'ordre des lignes, lecture seule ; création : date et auteur, lecture seule.
  await expect(rowA.locator('td').filter({ hasText: 'TCH-1' })).toHaveCount(1);
  await expect(rowB.locator('td').filter({ hasText: 'TCH-2' })).toHaveCount(1);
  await expect(rowA.getByRole('button', { name: /modifier Réf/ })).toHaveCount(0);
  await expect(rowA.getByText(frDate(day(0))).first()).toBeVisible();
  await expect(rowA.getByText(p.me.name).first()).toBeVisible();
  await expect(rowA.getByRole('button', { name: /modifier Créée/ })).toHaveCount(0);

  // Saisie d'une adresse sans schéma : https:// ajouté ; un schéma interdit est refusé sans envoi.
  await rowB.getByRole('button', { name: 'Modifier Site' }).click();
  await page.getByRole('textbox', { name: 'Site' }).fill('javascript:alert(1)');
  let sent = false;
  page.on('request', (r) => { if (r.method() === 'PATCH' && r.url().includes(`/rows/${p.b.id}`)) sent = true; });
  await page.keyboard.press('Enter');
  await expect(page.getByText(/Adresse web invalide/)).toBeVisible();
  expect(sent).toBe(false);
  await rowB.getByRole('button', { name: 'Modifier Site' }).click();
  await page.getByRole('textbox', { name: 'Site' }).fill('exemple.org/page');
  await page.keyboard.press('Enter');
  await expect(rowB.getByRole('link', { name: 'exemple.org/page' })).toHaveAttribute('href', 'https://exemple.org/page');
  // Le bouton de modification reste distinct du lien.
  await expect(rowB.getByRole('button', { name: /Modifier Site/ })).toBeVisible();

  // Plage de dates : deux champs étiquetés ; la fin avant le début est refusée.
  await rowB.getByRole('button', { name: 'Modifier Période' }).click();
  const form = page.getByRole('form', { name: /Période/ });
  await form.getByLabel('Début').fill(day(5));
  await form.getByLabel('Fin (facultative)').fill(day(2));
  await form.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(form.getByRole('alert')).toContainText('La fin ne peut pas précéder le début.');
  await form.getByLabel('Fin (facultative)').fill(day(8));
  await form.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(rowB.getByRole('button', { name: `${frDate(day(5))} – ${frDate(day(8))}` })).toBeVisible();
  const data = await rowsOf(browser, p.id);
  expect(data.rows.find((r) => r.id === p.b.id)!.values[p.periode.id]).toEqual({ start: day(5), end: day(8) });

  // Filtre sur la plage (par son début) : seule Bêta commence après demain.
  await page.getByRole('button', { name: /^Filtrer/ }).click();
  await page.getByRole('button', { name: 'Ajouter un filtre' }).click();
  const pop = page.locator('.bt-popover');
  await pop.getByLabel('Colonne').selectOption({ label: 'Période' });
  await pop.getByLabel('Condition').selectOption('gt');
  await pop.getByLabel('Valeur').fill(day(1));
  await pop.getByLabel('Valeur').press('Tab');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.locator('tbody tr')).toContainText('Bêta');
});

test('plage de dates lue par la chronologie et le calendrier', async ({ page, browser }) => {
  const p = await typedBase(browser, 'Plages e2e');
  const admin = await adminContext(browser);
  expect((await api(admin.request, 'PATCH', `/bases/${p.id}/settings`, { startPropertyId: p.periode.id, endPropertyId: null })).ok()).toBeTruthy();
  // Une plage porte déjà sa fin : une colonne de fin en plus est refusée.
  const other = (await (await api(admin.request, 'POST', `/bases/${p.id}/properties`, { name: 'Fin', type: 'date' })).json()) as Prop;
  expect((await api(admin.request, 'PATCH', `/bases/${p.id}/settings`, { startPropertyId: p.periode.id, endPropertyId: other.id })).status()).toBe(400);
  await admin.close();

  await page.setViewportSize({ width: 1400, height: 950 });
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto(`/p/${p.id}`);
  await page.getByRole('button', { name: 'Nouvelle vue' }).click();
  await page.getByRole('menuitem', { name: 'Nouvelle chronologie' }).click();
  const bar = page.getByRole('button', { name: /^Alpha, du / });
  await expect(bar).toBeVisible();
  // Clavier : décaler d'un jour, la plage entière suit.
  await bar.focus();
  const done = page.waitForResponse((r) => r.url().includes(`/rows/${p.a.id}`) && r.request().method() === 'PATCH');
  await page.keyboard.press('ArrowRight');
  await done;
  let data = await rowsOf(browser, p.id);
  expect(data.rows.find((r) => r.id === p.a.id)!.values[p.periode.id]).toEqual({ start: day(1), end: day(4) });
  await page.getByRole('button', { name: 'Tableau des dates' }).click();
  await expect(page.getByLabel('Fin de Alpha')).toHaveValue(day(4));

  // Calendrier sur la plage.
  await page.getByRole('button', { name: 'Nouvelle vue' }).click();
  await page.getByRole('menuitem', { name: 'Nouveau calendrier' }).click();
  await expect(page.getByRole('grid')).toBeVisible();
  await expect(page.getByLabel('Colonne de date')).toHaveValue(p.periode.id);
  await expect(page.getByLabel('Colonne de fin')).toHaveCount(0);
  const ev = page.getByRole('button', { name: /^Alpha, du / });
  await ev.focus();
  const moved = page.waitForResponse((r) => r.url().includes(`/rows/${p.a.id}`) && r.request().method() === 'PATCH');
  await page.keyboard.press('Alt+ArrowLeft');
  await moved;
  data = await rowsOf(browser, p.id);
  expect(data.rows.find((r) => r.id === p.a.id)!.values[p.periode.id]).toEqual({ start: day(0), end: day(3) });
});

test('modèles de ligne : créer depuis une ligne, appliquer, renommer, supprimer', async ({ page, browser }) => {
  const p = await typedBase(browser, 'Modèles e2e');
  await page.setViewportSize({ width: 1500, height: 950 });
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto(`/p/${p.id}`);

  await page.getByRole('button', { name: 'Actions de la ligne Alpha' }).click();
  await page.getByRole('menuitem', { name: 'Enregistrer comme modèle' }).click();
  const nameDlg = page.getByRole('dialog', { name: 'Enregistrer comme modèle' });
  await nameDlg.getByRole('textbox', { name: 'Nom du modèle' }).fill('Fiche client');
  await nameDlg.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(page.getByRole('button', { name: 'Modèles de ligne (1)' })).toBeVisible();
  let data = await rowsOf(browser, p.id);
  const tpl = data.rowTemplates!.find((t) => t.name === 'Fiche client')!;
  expect(tpl).toBeTruthy();
  // Ni identifiant ni colonne tenue par le serveur dans un modèle.
  expect(Object.keys(tpl.values)).not.toContain(p.uid.id);
  expect(Object.keys(tpl.values)).not.toContain(p.creation.id);

  // Appliquer : nouvelle ligne avec les valeurs du modèle et un nouveau numéro.
  await page.getByRole('button', { name: 'Modèles de ligne (1)' }).click();
  const created = page.waitForResponse((r) => r.url().endsWith(`/bases/${p.id}/rows`) && r.request().method() === 'POST');
  await page.getByRole('menuitem', { name: 'Fiche client' }).click();
  const body = (await created).request().postDataJSON() as { templateId?: string };
  expect(body.templateId).toBe(tpl.id);
  await expect(page.locator('tbody tr')).toHaveCount(3);
  data = await rowsOf(browser, p.id);
  const fresh = data.rows.find((r) => r.id !== p.a.id && r.id !== p.b.id)!;
  expect(fresh.values[p.mail.id]).toBe('jean.dupont@exemple.fr');
  expect(fresh.values[p.statut.id]).toBe(p.statut.options[1]!.id);
  expect(fresh.values[p.uid.id]).toBe('TCH-3');

  // Gérer : renommer puis supprimer.
  await page.getByRole('button', { name: 'Modèles de ligne (1)' }).click();
  await page.getByRole('menuitem', { name: 'Gérer les modèles' }).click();
  const manage = page.getByRole('dialog', { name: 'Modèles de ligne' });
  await manage.getByRole('button', { name: 'Renommer le modèle Fiche client' }).click();
  const rename = page.getByRole('dialog', { name: 'Renommer le modèle' });
  await rename.getByRole('textbox', { name: 'Nom du modèle' }).fill('Fiche prospect');
  await rename.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(manage.getByText('Fiche prospect')).toBeVisible();
  // Créer un second modèle depuis la ligne Bêta, dans la même fenêtre.
  await manage.getByLabel('Créer un modèle depuis la ligne').selectOption({ label: 'Bêta' });
  await manage.getByRole('button', { name: 'Créer' }).click();
  await page.getByRole('dialog', { name: 'Enregistrer comme modèle' }).getByRole('button', { name: 'Enregistrer' }).click();
  await expect(manage.getByRole('listitem')).toHaveCount(2);
  await manage.getByRole('button', { name: 'Supprimer le modèle Fiche prospect' }).click();
  await expect(manage.getByRole('listitem')).toHaveCount(1);
  await expect(manage.getByText('Fiche prospect')).toHaveCount(0);
  data = await rowsOf(browser, p.id);
  expect(data.rowTemplates!.map((t) => t.name)).toEqual(['Bêta']);
});
