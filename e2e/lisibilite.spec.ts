// Lisibilité pour les lecteurs et les bases : bandeau « Lecture seule » expliqué (page et base, absent pour un éditeur et en
// mode Lecture choisi), badge contrasté en clair et en sombre, base sur toute la largeur avec indice de défilement, bouton
// « Nouvelle ligne » en haut, barre d'outils compacte sur téléphone.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { ADMIN } from './accounts';
import { adminContext, api, createLocalUser, loginUi, PASSWORD, sessionContext } from './helpers';

test.use({ reducedMotion: 'reduce' });

const READER = { email: 'lecteur.lisibilite@e2e.test', name: 'Lecteur Lisibilité' };
type Base = { page: { id: string }; properties: { id: string }[] };

async function publicSpace(browser: Browser) {
  const admin = await adminContext(browser);
  const spaces = (await (await api(admin.request, 'GET', '/spaces')).json()) as { id: string; visibility: string }[];
  const me = (await (await admin.request.get('/api/v3/me')).json()) as { user: { id: string; name: string } };
  return { admin, spaceId: spaces.find((s) => s.visibility === 'public')!.id, me: me.user };
}

/** Base de `columns` colonnes texte et `rows` lignes, créée par l'administrateur. */
async function wideBase(browser: Browser, title: string, columns: number, rows: number) {
  const { admin, spaceId } = await publicSpace(browser);
  const base = (await (await api(admin.request, 'POST', '/bases', { spaceId, title })).json()) as Base;
  const id = base.page.id;
  const ids = [base.properties[0]!.id];
  for (let i = 1; i < columns; i += 1) {
    const p = (await (await api(admin.request, 'POST', `/bases/${id}/properties`, { name: i === columns - 1 ? 'Responsable' : `Colonne ${i}`, type: 'text' })).json()) as { id: string };
    ids.push(p.id);
  }
  for (let r = 0; r < rows; r += 1) {
    await api(admin.request, 'POST', `/bases/${id}/rows`, { values: Object.fromEntries(ids.map((pid, i) => [pid, i === 0 ? `Ligne ${r + 1}` : `Valeur ${r + 1}.${i}`])) });
  }
  await admin.close();
  return id;
}

const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

test('lecture seule d’une page : bandeau expliqué pour un lecteur, rien pour un éditeur ni en mode Lecture', async ({ page, browser }) => {
  const { admin, spaceId, me } = await publicSpace(browser);
  await createLocalUser(admin.request, READER.email, READER.name, 'reader');
  const created = await api(admin.request, 'POST', '/pages', { spaceId, title: 'Page lisibilité', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Texte de la page.' }] }] } });
  const { id } = (await created.json()) as { id: string };
  await admin.close();

  const reader = await sessionContext(browser, READER.email, PASSWORD);
  const rp = await reader.newPage();
  await rp.goto(`/p/${id}`);
  const notice = rp.getByRole('note');
  await expect(notice).toBeVisible();
  await expect(notice.locator('.ro-badge')).toHaveText('Lecture seule');
  await expect(notice).toContainText('Vous pouvez lire cette page et y chercher, mais pas la modifier.');
  await expect(notice).toContainText(`demandez à ${me.name}`);
  await expect(notice).toContainText('ou à un administrateur');
  await expect(notice).not.toContainText('rôle');
  // Commentaires : plus de « rôle », une piste pour obtenir le droit.
  await rp.getByRole('button', { name: 'Commentaires' }).click();
  const dlg = rp.getByRole('dialog', { name: 'Commentaires' });
  await expect(dlg).toContainText('Votre accès est en lecture seule');
  await expect(dlg).not.toContainText('rôle');
  await rp.keyboard.press('Escape');
  await reader.close();

  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto(`/p/${id}`);
  await expect(page.locator('.ProseMirror')).toContainText('Texte de la page.');
  await expect(page.locator('.ro-notice')).toHaveCount(0);
  // Mode Lecture choisi : rien n'est interdit, aucun bandeau.
  await page.getByRole('button', { name: 'Lecture' }).click();
  await expect(page.getByRole('button', { name: 'Éditer' })).toBeVisible();
  await expect(page.locator('.ro-notice')).toHaveCount(0);
  await page.getByRole('button', { name: 'Éditer' }).click();
});

test('lecture seule d’une base : bandeau, titre en lecture seule, ni « Nouvelle ligne » ni actions d’écriture', async ({ page, browser }) => {
  const id = await wideBase(browser, 'Base lisibilité lecteur', 3, 2);
  const admin = await adminContext(browser);
  await createLocalUser(admin.request, READER.email, READER.name, 'reader');
  await admin.close();
  const reader = await sessionContext(browser, READER.email, PASSWORD);
  const rp = await reader.newPage();
  await rp.goto(`/p/${id}`);
  await expect(rp.getByText('Ligne 1', { exact: true })).toBeVisible();
  const notice = rp.getByRole('note');
  await expect(notice.locator('.ro-badge')).toHaveText('Lecture seule');
  await expect(notice).toContainText('pas le modifier');
  await expect(rp.getByRole('textbox', { name: 'Titre de la base' })).not.toBeEditable();
  await expect(rp.getByRole('button', { name: 'Nouvelle ligne' })).toHaveCount(0);
  await expect(rp.getByRole('button', { name: 'Automatisations' })).toHaveCount(0);
  // La zone du tableau se fait défiler au clavier (rien d'autre n'y est focalisable pour un lecteur).
  await expect(rp.getByRole('region', { name: /Lignes de la base/ })).toHaveAttribute('tabindex', '0');
  await reader.close();

  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto(`/p/${id}`);
  await expect(page.getByText('Ligne 1', { exact: true })).toBeVisible();
  await expect(page.locator('.ro-notice')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Titre de la base' })).toBeEditable();
});

for (const scheme of ['light', 'dark'] as const) {
  test(`badge et bandeau de lecture seule : contrastes AA (thème ${scheme})`, async ({ browser }) => {
    const id = await wideBase(browser, `Base contraste ${scheme}`, 2, 1);
    const admin = await adminContext(browser);
    await createLocalUser(admin.request, READER.email, READER.name, 'reader');
    await admin.close();
    const reader = await sessionContext(browser, READER.email, PASSWORD);
    const rp = await reader.newPage();
    await rp.emulateMedia({ colorScheme: scheme });
    await rp.goto(`/p/${id}`);
    await rp.getByRole('note').waitFor();
    const result = await new AxeBuilder({ page: rp }).include('.ro-notice').include('.bt-head').withTags(['wcag2a', 'wcag2aa']).analyze();
    expect(result.violations.map((v) => `${v.id} : ${v.nodes.map((n) => n.target.join(' ')).join(' ; ')}`)).toEqual([]);
    await reader.close();
  });
}

test.describe('base sur grand écran (1366 px)', () => {
  test.use({ viewport: { width: 1366, height: 768 } });

  test('pleine largeur, indice de défilement horizontal, « Nouvelle ligne » en haut qui crée une ligne', async ({ page, browser }) => {
    const id = await wideBase(browser, 'Base large e2e', 12, 3);
    await loginUi(page, ADMIN.email, ADMIN.password);
    await page.goto(`/p/${id}`);
    await expect(page.locator('tbody tr')).toHaveCount(3);
    // La zone de la base occupe la largeur du contenu (moins les marges), pas une colonne de lecture de 760 px.
    const widths = await page.evaluate(() => ({ main: document.getElementById('main')!.clientWidth, frame: document.querySelector('.bt-frame')!.getBoundingClientRect().width }));
    expect(widths.frame).toBeGreaterThan(widths.main - 120);
    expect(widths.frame).toBeGreaterThan(900);
    // Douze colonnes ne tiennent pas : ombre à droite, pas à gauche ; au bout, l'inverse.
    const frame = page.locator('.bt-frame');
    await expect(frame).toHaveClass(/more-right/);
    await expect(frame).not.toHaveClass(/more-left/);
    await page.locator('.bt-scroll').evaluate((el) => { el.scrollLeft = el.scrollWidth; });
    await expect(frame).toHaveClass(/more-left/);
    await expect(frame).not.toHaveClass(/more-right/);
    await expect(page.getByRole('columnheader', { name: /Responsable/ })).toBeInViewport();

    // Bouton du haut, dans la barre d'outils : il crée une ligne et place le focus dessus.
    const top = page.locator('.bt-toolbar').getByRole('button', { name: 'Nouvelle ligne' });
    await expect(top).toBeVisible();
    await top.click();
    await expect(page.locator('tbody tr')).toHaveCount(4);
    await expect(page.locator('.bt-foot')).toContainText('4 lignes');
  });
});

test.describe('base sur téléphone (375 px)', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });

  test('pas de débordement, actions secondaires dans « Plus », « Nouvelle ligne » et vues accessibles', async ({ page, browser }) => {
    const id = await wideBase(browser, 'Base mobile e2e', 6, 2);
    await loginUi(page, ADMIN.email, ADMIN.password);
    await page.goto(`/p/${id}`);
    await expect(page.locator('tbody tr')).toHaveCount(2);
    await page.waitForTimeout(300);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    // Une rangée d'actions : Nouvelle ligne et Plus visibles, les secondaires cachées.
    const tools = page.locator('.bt-tools');
    await expect(tools.getByRole('button', { name: 'Nouvelle ligne' })).toBeVisible();
    await expect(tools.getByRole('button', { name: /^Filtrer/ })).toBeHidden();
    await expect(tools.getByRole('button', { name: 'Automatisations' })).toBeHidden();
    const toolbarHeight = await page.locator('.bt-toolbar').evaluate((el) => el.getBoundingClientRect().height);
    expect(toolbarHeight).toBeLessThan(120);
    await expect(page.getByRole('tab').first()).toBeVisible();
    // Le menu « Plus » donne les mêmes actions ; « Filtrer » ouvre le panneau des filtres.
    await page.getByRole('button', { name: 'Plus d’actions' }).click();
    for (const name of ['Trier', 'Colonnes', 'Exporter en CSV', 'Automatisations', 'Formulaires', 'Réglages de la base']) {
      await expect(page.getByRole('menuitem', { name })).toBeVisible();
    }
    await page.getByRole('menuitem', { name: 'Filtrer' }).click();
    await expect(page.getByRole('button', { name: 'Ajouter un filtre' })).toBeVisible();
    await page.keyboard.press('Escape');
    // Le bouton du haut crée une ligne ici aussi.
    await tools.getByRole('button', { name: 'Nouvelle ligne' }).click();
    await expect(page.locator('tbody tr')).toHaveCount(3);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
  });
});
