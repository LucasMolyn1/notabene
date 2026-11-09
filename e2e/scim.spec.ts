// Provisionnement SCIM : activation avec ressaisie du mot de passe, jeton affiché une seule fois, révocation,
// groupes gérés par SCIM non modifiables dans Groupes. Accessibilité (clair et sombre) et largeur téléphone.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';
import { ADMIN } from './accounts';
import { adminContext, loginUi } from './helpers';

const BASE = 'http://localhost:3100';
const GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const STATE = /\/api\/v3\/admin\/scim$/;
const TOKENS = /\/api\/v3\/admin\/scim\/tokens$/;

// Requête SCIM sans session (le jeton seul fait foi).
async function scim(browser: Browser, token: string | null, method: 'GET' | 'POST', url: string, data?: object) {
  const ctx = await browser.newContext({ baseURL: BASE });
  const res = await ctx.request.fetch(`/scim/v2${url}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(data ? { 'content-type': 'application/scim+json' } : {}) },
    ...(data ? { data: JSON.stringify(data) } : {}),
  });
  const status = res.status();
  await ctx.close();
  return status;
}

// Ressaisie éventuelle (une session déjà confirmée depuis moins de 10 minutes ne la redemande pas).
async function confirmIfAsked(page: Page, done: Locator) {
  const dialog = page.getByRole('dialog', { name: 'Confirmez votre identité' });
  await expect(dialog.or(done).first()).toBeVisible();
  if (await dialog.isVisible()) {
    await dialog.getByLabel('Mot de passe', { exact: true }).fill(ADMIN.password);
    await dialog.getByRole('button', { name: 'Confirmer' }).click();
  }
  await expect(done).toBeVisible();
}

const overflow = (page: Page) => page.evaluate(() => {
  const scroller = document.querySelector('.scroller');
  return Math.max(document.documentElement.scrollWidth - window.innerWidth, scroller ? scroller.scrollWidth - scroller.clientWidth : 0);
});

test('activer SCIM, créer un jeton affiché une seule fois, gérer un groupe SCIM, révoquer', async ({ browser }) => {
  // Session neuve : la première action sensible exige le mot de passe.
  const ctx = await browser.newContext({ baseURL: BASE });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  const page = await ctx.newPage();
  await loginUi(page, ADMIN.email, ADMIN.password);
  expect(await scim(browser, null, 'GET', '/Users')).toBe(404);

  await page.goto('/settings/scim');
  const state = page.locator('.set-card').first();
  await expect(state.getByText('Inactif', { exact: true })).toBeVisible();
  await expect(state.getByText(`${BASE}/scim/v2`)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Enregistrer' })).toBeDisabled();

  // Activation : mot de passe obligatoire.
  await page.getByRole('checkbox', { name: 'Activer le provisionnement SCIM' }).check();
  await page.getByLabel('Rôle des comptes créés').selectOption('editor');
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirmez votre identité' });
  await expect(dialog).toBeVisible();
  const put = page.waitForRequest((r) => r.method() === 'PUT' && r.url().endsWith('/api/v3/admin/scim/settings'));
  await dialog.getByLabel('Mot de passe', { exact: true }).fill(ADMIN.password);
  await dialog.getByRole('button', { name: 'Confirmer' }).click();
  expect((await put).postDataJSON()).toMatchObject({ enabled: true, defaultRole: 'editor', reauth: { password: ADMIN.password } });
  await expect(state.getByText('Actif', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Rôle des comptes créés')).toHaveValue('editor');

  // Nom obligatoire.
  await page.getByRole('button', { name: 'Créer le jeton' }).click();
  await expect(page.getByText('Donnez un nom au jeton.')).toBeVisible();
  await expect(page.getByLabel('Nom du jeton')).toHaveAttribute('aria-invalid', 'true');

  // Création du jeton (dans la fenêtre de 10 minutes ouverte par la saisie précédente).
  await page.getByLabel('Nom du jeton').fill('Authentik e2e');
  await page.getByLabel('Expiration').selectOption('90');
  const created = page.waitForResponse((r) => TOKENS.test(r.url()) && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Créer le jeton' }).click();
  expect((await created).status()).toBe(201);
  const value = page.locator('.token-value');
  await expect(value).toHaveText(/^nbscim_/);
  const token = (await value.textContent())!;
  await expect(page.getByText('il ne sera plus jamais affiché')).toBeVisible();
  await page.getByRole('button', { name: 'Copier le jeton' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(token);

  // Rien n'est conservé côté navigateur.
  const stored = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]));
  expect(stored).not.toContain(token);

  // Le jeton ouvre SCIM : création d'un groupe géré par SCIM.
  expect(await scim(browser, token, 'GET', '/ServiceProviderConfig')).toBe(200);
  expect(await scim(browser, token, 'POST', '/Groups', { schemas: [GROUP], displayName: 'Groupe SCIM e2e' })).toBe(201);

  // « J'ai copié » efface le jeton ; il ne réapparaît pas au rechargement.
  await page.getByRole('button', { name: 'J’ai copié le jeton' }).click();
  await expect(value).toHaveCount(0);
  await page.reload();
  const list = page.getByRole('list', { name: 'Jetons SCIM' });
  const row = list.getByRole('listitem').filter({ hasText: 'Authentik e2e' });
  await expect(row).toContainText(`${token.slice(0, 12)}…`);
  await expect(row).toContainText('expire le');
  expect(await page.content()).not.toContain(token);
  await expect(page.getByText('1 groupe', { exact: true })).toBeVisible();

  // Groupes : marqué « Géré par SCIM », adhésion en lecture seule, suppression possible.
  await page.goto('/settings/groups');
  const groupRow = page.locator('.table-row').filter({ hasText: 'Groupe SCIM e2e' });
  await expect(groupRow.getByText('Géré par SCIM')).toBeVisible();
  await groupRow.getByRole('button', { name: 'Membres de Groupe SCIM e2e' }).click();
  const members = page.getByRole('dialog', { name: /Membres de/ });
  await expect(members.getByText('Ce groupe est géré par SCIM')).toBeVisible();
  await expect(members.getByLabel('Ajouter une personne')).toHaveCount(0);
  await members.getByRole('button', { name: 'Fermer' }).first().click();
  await groupRow.getByRole('button', { name: 'Supprimer Groupe SCIM e2e' }).click();
  await page.getByRole('dialog', { name: 'Supprimer ce groupe ?' }).getByRole('button', { name: 'Supprimer' }).click();
  await expect(page.locator('.table-row').filter({ hasText: 'Groupe SCIM e2e' })).toHaveCount(0);

  // Révocation avec confirmation : le jeton cesse de fonctionner.
  await page.goto('/settings/scim');
  await page.getByRole('button', { name: 'Révoquer le jeton Authentik e2e' }).click();
  await page.getByRole('dialog', { name: 'Révoquer ce jeton ?' }).getByRole('button', { name: 'Révoquer' }).click();
  await expect(page.getByRole('list', { name: 'Jetons SCIM' }).getByRole('listitem').filter({ hasText: 'Authentik e2e' })).toContainText('Révoqué');
  await expect(page.getByRole('button', { name: 'Révoquer le jeton Authentik e2e' })).toHaveCount(0);
  expect(await scim(browser, token, 'GET', '/ServiceProviderConfig')).toBe(401);

  // Retour à l'état initial.
  await page.getByRole('checkbox', { name: 'Activer le provisionnement SCIM' }).uncheck();
  await page.getByLabel('Rôle des comptes créés').selectOption('reader');
  await page.getByRole('button', { name: 'Enregistrer' }).click();
  await confirmIfAsked(page, page.locator('.set-card').first().getByText('Inactif', { exact: true }));
  expect(await scim(browser, null, 'GET', '/Users')).toBe(404);
  await ctx.close();
});

test('configuration verrouillée : activation et rôle en lecture seule', async ({ browser }) => {
  const ctx = await adminContext(browser);
  const page = await ctx.newPage();
  await page.route(STATE, (route) => route.fulfill({ json: {
    enabled: true, defaultRole: 'reader', locked: true, source: 'env', endpoint: `${BASE}/scim/v2`, tokens: [], stats: { users: 3, groups: 2 },
  } }));
  await page.goto('/settings/scim');
  await expect(page.getByText('Configuration verrouillée (CONFIG_LOCKED)')).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Activer le provisionnement SCIM' })).toBeDisabled();
  await expect(page.getByLabel('Rôle des comptes créés')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Enregistrer' })).toBeDisabled();
  await expect(page.getByText('Défini dans l’environnement')).toBeVisible();
  await expect(page.getByText('3 comptes')).toBeVisible();
  // Les jetons restent gérables.
  await expect(page.getByRole('button', { name: 'Créer le jeton' })).toBeEnabled();
  await ctx.close();
});

// État simulé avec jetons de tous états et jeton tout juste créé (rien n'atteint le serveur).
async function mockedPage(browser: Browser, colorScheme: 'light' | 'dark') {
  const ctx = await adminContext(browser);
  const page = await ctx.newPage();
  await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
  const now = Date.now();
  await page.route(STATE, (route) => route.fulfill({ json: {
    enabled: true, defaultRole: 'editor', locked: false, source: 'db', endpoint: `${BASE}/scim/v2`, stats: { users: 12, groups: 1 },
    tokens: [
      { id: 'a', name: 'Authentik', prefix: 'nbscim_abcde', createdAt: now, expiresAt: now + 86_400_000 * 300, lastUsedAt: now - 60_000, revokedAt: null },
      { id: 'b', name: 'Ancien', prefix: 'nbscim_fghij', createdAt: now, expiresAt: now - 1000, lastUsedAt: null, revokedAt: null },
      { id: 'c', name: 'Révoqué', prefix: 'nbscim_klmno', createdAt: now, expiresAt: now + 1000_000, lastUsedAt: null, revokedAt: now },
    ],
  } }));
  await page.route(TOKENS, (route) => route.fulfill({ status: 201, json: { id: 'd', name: 'Nouveau', token: `nbscim_${'x'.repeat(43)}`, prefix: 'nbscim_xxxxx', expiresAt: now + 86_400_000 * 365 } }));
  return { ctx, page };
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`SCIM : accessibilité, thème ${colorScheme}`, async ({ browser }) => {
    const { ctx, page } = await mockedPage(browser, colorScheme);
    const found: string[] = [];
    const check = async (label: string) => {
      const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      found.push(...r.violations.map((v) => `${label} | ${v.id} | ${v.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(' ; ')}`));
    };
    await page.goto('/settings/scim');
    await expect(page.getByRole('list', { name: 'Jetons SCIM' }).getByRole('listitem')).toHaveCount(3);
    await page.getByRole('button', { name: 'Créer le jeton' }).click();
    await expect(page.getByText('Donnez un nom au jeton.')).toBeVisible();
    await check('scim (erreur)');
    await page.getByLabel('Nom du jeton').fill('Nouveau');
    await page.getByRole('button', { name: 'Créer le jeton' }).click();
    await confirmIfAsked(page, page.locator('.token-value'));
    await check('scim (jeton créé)');
    expect(found).toEqual([]);
    await ctx.close();
  });
}

test('SCIM : rien ne déborde en largeur 375 px', async ({ browser }) => {
  const { ctx, page } = await mockedPage(browser, 'light');
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto('/settings/scim');
  await page.locator('.set-card').first().waitFor();
  await page.getByLabel('Nom du jeton').fill('Nouveau');
  await page.getByRole('button', { name: 'Créer le jeton' }).click();
  await confirmIfAsked(page, page.locator('.token-value'));
  await page.waitForTimeout(300);
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await ctx.close();
});
