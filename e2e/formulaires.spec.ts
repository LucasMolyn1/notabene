// Formulaires des bases : activation (instance puis espace), création par le panneau, lien montré une fois, réponse anonyme
// dans un contexte sans session, réponse visible dans la base, notification, révocation (404) ; écran « connexion requise » ;
// axe en clair et en sombre sur le panneau et la page publique ; téléphone (375 px).
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { ADMIN } from './accounts';
import { adminContext, api, loginUi } from './helpers';

type Prop = { id: string; name: string; options: { id: string; name: string }[] };
const BASE_URL = 'http://localhost:3100';

/** Base : Nom (texte), Statut, Accord (case), Note (nombre) ; d'autres types à la demande (rendu de la page publique). */
async function formBase(browser: Browser, title: string, extra: [string, string][] = []) {
  const admin = await adminContext(browser);
  const spaces = (await (await api(admin.request, 'GET', '/spaces')).json()) as { id: string; name: string; visibility: string; kind?: string }[];
  const space = spaces.find((s) => s.visibility === 'public' && s.kind !== 'personal')!;
  const base = (await (await api(admin.request, 'POST', '/bases', { spaceId: space.id, title })).json()) as { page: { id: string }; properties: { id: string }[] };
  const id = base.page.id;
  const add = async (name: string, type: string) => (await (await api(admin.request, 'POST', `/bases/${id}/properties`, { name, type })).json()) as Prop;
  const statut = await add('Statut', 'status');
  const accord = await add('Accord', 'checkbox');
  const note = await add('Note', 'number');
  const others: Prop[] = [];
  for (const [name, type] of extra) others.push(await add(name, type));
  await admin.close();
  return { id, space, nom: base.properties[0]!.id, statut, accord, note, others };
}

async function setForms(browser: Browser, spaceId: string, instance: boolean, space: boolean) {
  const admin = await adminContext(browser);
  // PUT /admin/forms est limité à 10 par minute : on ne l'appelle que pour changer l'état.
  const cur = (await (await api(admin.request, 'GET', '/admin/forms')).json()) as { enabled: boolean };
  if (cur.enabled !== instance) expect((await api(admin.request, 'PUT', '/admin/forms', { enabled: instance })).ok()).toBeTruthy();
  expect((await api(admin.request, 'PATCH', `/spaces/${spaceId}`, { forms: space })).ok()).toBeTruthy();
  await admin.close();
}

/** Formulaire et lien créés par l'API ; rend le chemin /form/<jeton>. */
async function apiForm(browser: Browser, baseId: string, body: Record<string, unknown>) {
  const admin = await adminContext(browser);
  const created = await api(admin.request, 'POST', `/bases/${baseId}/forms`, body);
  expect(created.status()).toBe(201);
  const form = (await created.json()) as { id: string };
  const link = await api(admin.request, 'POST', `/bases/${baseId}/forms/${form.id}/link`, {});
  expect(link.status()).toBe(201);
  const { url } = (await link.json()) as { url: string };
  await admin.close();
  return { id: form.id, path: new URL(url).pathname };
}

const panel = (page: Page) => page.getByRole('dialog', { name: /^Formulaires de/ });

async function openPanel(page: Page) {
  await page.getByRole('button', { name: 'Formulaires', exact: true }).click();
  await expect(panel(page).getByRole('button', { name: 'Nouveau formulaire' })).toBeVisible();
}

const anonContext = (browser: Browser, opts: Parameters<Browser['newContext']>[0] = {}): Promise<BrowserContext> => browser.newContext({ baseURL: BASE_URL, ...opts });

test('formulaires : activation, création, lien, réponse anonyme, notification et révocation', async ({ page, browser }) => {
  test.setTimeout(90_000);
  const b = await formBase(browser, 'Formulaires e2e');
  await setForms(browser, b.space.id, false, false);
  await page.setViewportSize({ width: 1280, height: 900 });
  await loginUi(page, ADMIN.email, ADMIN.password);

  // Désactivé par défaut : l'état est dit en clair, la création est impossible.
  await page.goto(`/p/${b.id}`);
  await openPanel(page);
  const dlg = panel(page);
  await expect(dlg.getByText('Les formulaires sont désactivés sur cette instance.', { exact: false })).toBeVisible();
  await expect(dlg.getByRole('button', { name: 'Nouveau formulaire' })).toBeDisabled();
  await dlg.getByRole('button', { name: 'Fermer' }).last().click();

  // Réglage d'administration, puis réglage de l'espace.
  await page.goto('/settings/forms');
  const toggle = page.getByLabel('Autoriser les formulaires des bases');
  await expect(toggle).not.toBeChecked();
  const put = page.waitForResponse((r) => r.url().endsWith('/admin/forms') && r.request().method() === 'PUT');
  await page.locator('.switch-row').filter({ hasText: 'Autoriser les formulaires des bases' }).click();
  expect((await put).ok()).toBeTruthy();
  await expect(page.getByLabel('Autoriser les formulaires des bases')).toBeChecked();
  await page.goto('/settings/spaces');
  await page.getByRole('button', { name: `Modifier ${b.space.name}` }).click();
  const spaceDlg = page.getByRole('dialog', { name: 'Paramètres de l’espace' });
  await spaceDlg.getByLabel('Autoriser les formulaires des bases').check();
  const patch = page.waitForResponse((r) => r.url().includes(`/spaces/${b.space.id}`) && r.request().method() === 'PATCH');
  await spaceDlg.getByRole('button', { name: 'Enregistrer' }).click();
  expect((await patch).ok()).toBeTruthy();

  // Création : anonyme, Nom obligatoire, Statut renommé, Accord monté avant Statut.
  await page.goto(`/p/${b.id}`);
  await openPanel(page);
  await dlg.getByRole('button', { name: 'Nouveau formulaire' }).click();
  await expect(dlg.getByLabel('Titre', { exact: true })).toBeFocused();
  await dlg.getByLabel('Titre', { exact: true }).fill('Inscription');
  await dlg.getByLabel('Qui peut répondre').selectOption('anonymous');
  await expect(dlg.getByText('Anonyme : toute personne qui obtient le lien', { exact: false })).toBeVisible();
  const q1 = dlg.getByRole('group', { name: 'Question 1 : Nom' });
  await q1.getByLabel('Obligatoire').check();
  await dlg.getByLabel('Colonne à ajouter').selectOption({ label: 'Statut (statut)' });
  await dlg.getByRole('button', { name: 'Ajouter la question' }).click();
  await expect(dlg.getByRole('group', { name: 'Question 2 : Statut' }).getByLabel('Libellé (facultatif)')).toBeFocused();
  await dlg.getByRole('group', { name: 'Question 2 : Statut' }).getByLabel('Libellé (facultatif)').fill('Votre statut');
  await dlg.getByLabel('Colonne à ajouter').selectOption({ label: 'Accord (case)' });
  await dlg.getByRole('button', { name: 'Ajouter la question' }).click();
  await dlg.getByRole('button', { name: 'Monter : Accord' }).click();
  await expect(dlg.getByRole('group', { name: 'Question 2 : Accord' })).toBeVisible();
  await expect(dlg.getByRole('button', { name: 'Monter : Accord' })).toBeFocused();
  await dlg.getByRole('button', { name: 'Créer' }).click();
  const item = dlg.getByRole('listitem', { name: 'Inscription' });
  await expect(item).toContainText('Anonyme');
  await expect(item).toContainText('Sans lien');
  await expect(item).toContainText('3 questions : Nom, Accord, Votre statut.');
  await expect(item).toContainText('0 réponse');

  // Lien montré une seule fois, bouton de copie focalisé.
  await dlg.getByRole('button', { name: 'Créer le lien de Inscription' }).click();
  const address = dlg.getByLabel('Adresse du formulaire');
  await expect(address).toHaveValue(/\/form\/[A-Za-z0-9_-]{32}$/);
  await expect(dlg.getByRole('button', { name: 'Copier l’adresse' })).toBeFocused();
  const path = new URL(await address.inputValue()).pathname;
  await expect(item).toContainText('Lien actif');

  // Réponse anonyme, sans session.
  const anon = await anonContext(browser);
  const pub = await anon.newPage();
  await pub.goto(path);
  await expect(pub.getByRole('heading', { name: 'Inscription' })).toBeVisible();
  await expect(pub.getByText('Réponse anonyme', { exact: false })).toBeVisible();
  await pub.getByRole('button', { name: 'Envoyer' }).click();
  const nom = pub.getByLabel(/^Nom/);
  await expect(nom).toBeFocused();
  await expect(nom).toHaveAccessibleDescription('Cette question est obligatoire.');
  await expect(nom).toHaveAttribute('aria-invalid', 'true');
  await nom.fill('Réponse anonyme e2e');
  await pub.getByLabel('Votre statut').selectOption({ label: b.statut.options[1]!.name });
  await pub.getByLabel('Accord').check();
  const sent = pub.waitForResponse((r) => r.url().includes('/public/forms/') && r.request().method() === 'POST');
  await pub.getByRole('button', { name: 'Envoyer' }).click();
  expect((await sent).status()).toBe(201);
  await expect(pub.getByRole('heading', { name: 'Merci' })).toBeFocused();
  await expect(pub.getByText('Votre réponse a été enregistrée.')).toBeVisible();

  // Réponse visible dans la base, compteur et notification.
  await dlg.getByRole('button', { name: 'Fermer' }).last().click();
  await page.reload();
  await expect(page.locator('tbody')).toContainText('Réponse anonyme e2e');
  await expect(page.locator('tbody')).toContainText(b.statut.options[1]!.name);
  await page.getByRole('button', { name: /^Notifications, \d+ non lue/ }).click();
  await expect(page.getByRole('dialog', { name: 'Notifications' })).toContainText('Nouvelle réponse à un formulaire de la base Formulaires e2e');
  await page.getByRole('dialog', { name: 'Notifications' }).getByRole('button', { name: 'Fermer' }).last().click();
  await openPanel(page);
  await expect(item).toContainText('1 réponse');

  // Révocation : le lien ne sert plus (404 uniforme).
  await dlg.getByRole('button', { name: 'Révoquer le lien de Inscription' }).click();
  await page.getByRole('dialog', { name: 'Révoquer le lien' }).getByRole('button', { name: 'Révoquer' }).click();
  await expect(item).toContainText('Sans lien');
  await pub.goto(path);
  await expect(pub.getByRole('heading', { name: 'Formulaire introuvable ou fermé' })).toBeVisible();
  expect((await anon.request.get(`/api/v3/public${path.replace('/form/', '/forms/')}`)).status()).toBe(404);
  await anon.close();
});

test('formulaires : passer en anonyme révoque le lien, prévenu avant, lien à recréer', async ({ page, browser }) => {
  const b = await formBase(browser, 'Formulaires bascule e2e');
  await setForms(browser, b.space.id, true, true);
  const form = await apiForm(browser, b.id, { title: 'Bascule', questions: [{ propertyId: b.nom }] });
  await page.setViewportSize({ width: 1280, height: 900 });
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto(`/p/${b.id}`);
  await openPanel(page);
  const dlg = panel(page);
  await expect(dlg.getByRole('listitem', { name: 'Bascule' })).toContainText('Lien actif');
  await dlg.getByRole('button', { name: 'Modifier Bascule' }).click();
  await dlg.getByLabel('Qui peut répondre').selectOption('anonymous');
  await expect(dlg.getByText('Le lien actuel sera révoqué à l’enregistrement', { exact: false })).toBeVisible();
  await dlg.getByRole('button', { name: 'Enregistrer' }).click();
  await page.getByRole('dialog', { name: 'Passer en anonyme' }).getByRole('button', { name: 'Passer en anonyme' }).click();
  const item = dlg.getByRole('listitem', { name: 'Bascule' });
  await expect(item).toContainText('Lien à recréer');
  await expect(item).toContainText('Anonyme');
  const anon = await anonContext(browser);
  expect((await anon.request.get(`/api/v3/public${form.path.replace('/form/', '/forms/')}`)).status()).toBe(404);
  await anon.close();
  await dlg.getByRole('button', { name: 'Créer le lien de Bascule' }).click();
  await expect(dlg.getByLabel('Adresse du formulaire')).toHaveValue(/\/form\/[A-Za-z0-9_-]{32}$/);
  await expect(item).toContainText('Lien actif');
});

for (const scheme of ['light', 'dark'] as const) {
  test(`accessibilité des formulaires, thème ${scheme}`, async ({ browser }) => {
    test.setTimeout(90_000);
    const b = await formBase(browser, `Formulaires a11y ${scheme}`, [['Date', 'date'], ['Période', 'date_range'], ['Étiquettes', 'multi_select'], ['Site', 'url'], ['Courriel', 'email'], ['Téléphone', 'phone']]);
    await setForms(browser, b.space.id, true, true);
    const questions = [b.nom, b.statut.id, b.accord.id, b.note.id, ...b.others.map((p) => p.id)].map((propertyId, i) => ({ propertyId, required: i === 0 }));
    const anonymous = await apiForm(browser, b.id, { title: 'Questionnaire', description: 'Merci de répondre.\nDeux minutes suffisent.', mode: 'anonymous', questions });
    const accounts = await apiForm(browser, b.id, { title: 'Réservé', questions: [{ propertyId: b.nom }] });
    const found: string[] = [];
    const scan = async (page: Page, label: string) => {
      const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      found.push(...r.violations.map((v) => `${label} | ${v.id} | ${v.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(' ; ')}`));
    };

    // Panneau de la base.
    const ctx = await browser.newContext({ colorScheme: scheme, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await loginUi(page, ADMIN.email, ADMIN.password);
    await page.goto(`/p/${b.id}`);
    await openPanel(page);
    await expect(panel(page).getByRole('listitem', { name: 'Questionnaire' })).toBeVisible();
    await scan(page, 'liste des formulaires');
    await panel(page).getByRole('button', { name: 'Modifier Questionnaire' }).click();
    await expect(panel(page).getByText('Anonyme : toute personne qui obtient le lien', { exact: false })).toBeVisible();
    await scan(page, 'configuration');
    await ctx.close();

    // Page publique, sans session.
    const anon = await anonContext(browser, { colorScheme: scheme, reducedMotion: 'reduce' });
    const pub = await anon.newPage();
    await pub.goto(anonymous.path);
    await expect(pub.getByRole('heading', { name: 'Questionnaire' })).toBeVisible();
    await expect(pub.getByRole('group', { name: 'Période' })).toBeVisible();
    await scan(pub, 'page publique');
    await pub.getByRole('button', { name: 'Envoyer' }).click();
    await expect(pub.getByLabel(/^Nom/)).toHaveAccessibleDescription('Cette question est obligatoire.');
    await scan(pub, 'erreurs');
    await pub.getByLabel(/^Nom/).fill('Réponse a11y');
    await pub.getByRole('button', { name: 'Envoyer' }).click();
    await expect(pub.getByRole('heading', { name: 'Merci' })).toBeVisible({ timeout: 10_000 });
    await scan(pub, 'remerciement');
    await pub.goto(accounts.path);
    await expect(pub.getByRole('heading', { name: 'Connexion requise' })).toBeVisible();
    await expect(pub.getByRole('link', { name: 'Se connecter' })).toHaveAttribute('href', new RegExp(`returnTo=${encodeURIComponent(accounts.path)}`));
    await scan(pub, 'connexion requise');
    await pub.goto('/form/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    await expect(pub.getByRole('heading', { name: 'Formulaire introuvable ou fermé' })).toBeVisible();
    await scan(pub, 'formulaire fermé');
    await anon.close();
    expect(found).toEqual([]);
  });
}

test('formulaires sur téléphone (375 px) : panneau et page publique sans défilement horizontal', async ({ browser }) => {
  const b = await formBase(browser, 'Formulaires mobile', [['Période', 'date_range']]);
  await setForms(browser, b.space.id, true, true);
  const form = await apiForm(browser, b.id, { title: 'Formulaire mobile', mode: 'anonymous', questions: [{ propertyId: b.nom, required: true }, { propertyId: b.statut.id }, { propertyId: b.others[0]!.id }] });
  const mobile = { viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true };
  const ctx = await browser.newContext(mobile);
  const page = await ctx.newPage();
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto(`/p/${b.id}`);
  const open = page.getByRole('button', { name: 'Formulaires', exact: true });
  await open.scrollIntoViewIfNeeded();
  await openPanel(page);
  const dlg = panel(page);
  const box = (await dlg.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(375);
  await dlg.getByRole('button', { name: 'Modifier Formulaire mobile' }).click();
  const overflow = await dlg.locator('.modal-body').evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await ctx.close();

  const anon = await anonContext(browser, mobile);
  const pub = await anon.newPage();
  await pub.goto(form.path);
  await expect(pub.getByRole('heading', { name: 'Formulaire mobile' })).toBeVisible();
  expect(await pub.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  // Erreur affichée sans débordement (pas d'envoi : 5 réponses par minute et par adresse, toute la série confondue).
  await pub.getByRole('button', { name: 'Envoyer' }).click();
  await expect(pub.getByLabel(/^Nom/)).toHaveAccessibleDescription('Cette question est obligatoire.');
  expect(await pub.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await anon.close();
});
