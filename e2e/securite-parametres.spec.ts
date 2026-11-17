// Journal d'audit lisible (libellés, cibles, personne, détails repliés ; tolère un serveur plus ancien),
// page « Sécurité » (administrateur et autre compte) et clé d'API limitée à des espaces.
import { expect, test } from '@playwright/test';
import { adminContext, api, createLocalUser, PASSWORD, sessionContext } from './helpers';

const EVENTS = /\/api\/v3\/admin\/audit\/events\?/;

test('journal d’audit : libellés, cible en lien, personne, code discret et détails repliés', async ({ browser }) => {
  const ctx = await adminContext(browser);
  const spaces = (await (await api(ctx.request, 'GET', '/spaces')).json()) as { id: string; visibility: string }[];
  const target = (await (await api(ctx.request, 'POST', '/pages', { spaceId: spaces.find((s) => s.visibility === 'public')!.id, title: 'Page partagée auditée' })).json()) as { id: string };
  const page = await ctx.newPage();
  const now = Date.now();
  await page.route(EVENTS, (route) => route.fulfill({ json: { nextCursor: null, items: [
    // Format récent : libellé et cible décrite.
    { schema: 'notabene.audit/1', id: 3, timestamp: new Date(now - 60_000).toISOString(), action: 'share.create', label: 'Lien public créé', outcome: 'success', actor: { id: 'u1', name: 'Karim Admin' }, target: target.id, targetInfo: { type: 'page', id: target.id, title: 'Page partagée auditée' }, ip: '10.0.0.5', meta: { expiresInDays: 7 } },
    { schema: 'notabene.audit/1', id: 2, timestamp: new Date(now - 120_000).toISOString(), action: 'page.destroy', label: 'Page supprimée définitivement', outcome: 'success', actor: { id: 'u1', name: 'Karim Admin' }, target: 'pagedisparue1', targetInfo: { type: 'page', id: 'pagedisparue1', title: null }, ip: '10.0.0.5', meta: {} },
    // Ancien format : pas de libellé, cible en identifiant brut.
    { schema: 'notabene.audit/1', id: 1, timestamp: new Date(now - 180_000).toISOString(), action: 'auth.login', outcome: 'success', actor: { id: 'u2', name: 'Sophie' }, target: 'u2', ip: '10.0.0.6', meta: { provider: 'local' } },
  ] } }));
  await page.goto('/settings/audit');
  const list = page.getByRole('list', { name: 'Entrées du journal' });
  const rows = list.getByRole('listitem');
  await expect(rows).toHaveCount(3);

  const shared = rows.nth(0);
  await expect(shared.locator('strong')).toHaveText('Lien public créé');
  await expect(shared.locator('strong')).toHaveAttribute('title', 'share.create');
  await expect(shared.locator('code.audit-code')).toHaveText('share.create');
  await expect(shared).toContainText('Karim Admin');
  await expect(shared.getByRole('link', { name: 'Page partagée auditée' })).toHaveAttribute('href', `/p/${target.id}`);
  // Métadonnées : repliées, accessibles en un clic.
  const details = shared.locator('details.audit-meta');
  await expect(details.locator('pre')).toBeHidden();
  await details.locator('summary').click();
  await expect(details.locator('pre')).toContainText('"expiresInDays": 7');

  // Page disparue : pas de lien, l'identifiant reste lisible.
  await expect(rows.nth(1).getByRole('link')).toHaveCount(0);
  await expect(rows.nth(1)).toContainText('Page pagedisparue1');
  await expect(rows.nth(1).locator('details')).toHaveCount(0);

  // Serveur plus ancien : libellé local, cible brute.
  await expect(rows.nth(2).locator('strong')).toHaveText('Connexion');
  await expect(rows.nth(2)).toContainText('cible u2');
  await expect(rows.nth(2)).toContainText('Sophie');

  // Sans simulation : le vrai journal s'affiche sans erreur, quel que soit le format renvoyé par le serveur.
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.unroute(EVENTS);
  await page.reload();
  await expect(page.locator('.audit-status')).toContainText(/affichée|Aucune entrée/);
  await expect(list.getByRole('listitem').first().locator('strong')).not.toBeEmpty();
  expect(errors).toEqual([]);
  await ctx.close();
});

test('page Sécurité : synthèse complète pour un administrateur, réduite pour les autres', async ({ browser }) => {
  const ctx = await adminContext(browser);
  const page = await ctx.newPage();
  await page.goto('/settings/security');
  await expect(page.getByRole('heading', { level: 1, name: 'Sécurité' })).toBeVisible();
  // Dans le groupe « Administration » du menu des sections.
  const nav = page.getByRole('navigation', { name: 'Sections des paramètres' });
  const groups = await nav.locator('.set-nav-group, .set-nav-item').allTextContents();
  const admin = groups.indexOf('Administration');
  expect(admin).toBeGreaterThan(-1);
  expect(groups.indexOf('Sécurité')).toBeGreaterThan(admin);
  for (const t of ['Double authentification', 'Sessions actives', 'Durée de session', 'Conservation des données', 'Journal d’audit', 'Envoi vers un SIEM', 'Jetons d’API', 'Partages publics']) {
    await expect(page.locator('.sec-item strong').filter({ hasText: t }).first()).toBeVisible();
  }
  await expect(page.locator('.sec-item', { hasText: 'Durée de session' })).toContainText('SESSION_TTL_HOURS');
  await expect(page.locator('.sec-item', { hasText: 'Durée de session' })).toContainText(/\d+ h/);
  await expect(page.locator('.sec-item', { hasText: 'Double authentification' }).locator('.pill')).toHaveText(/Activée|Désactivée/);
  await page.locator('.sec-item', { hasText: 'Journal d’audit' }).getByRole('link', { name: 'Consulter' }).click();
  await expect(page).toHaveURL(/\/settings\/audit$/);
  await ctx.close();

  const root = await adminContext(browser);
  await createLocalUser(root.request, 'securite.editeur@e2e.test', 'Éditeur sécurité', 'editor');
  await root.close();
  const editor = await sessionContext(browser, 'securite.editeur@e2e.test', PASSWORD);
  const p2 = await editor.newPage();
  await p2.goto('/settings/security');
  // Pour un compte non administrateur, la synthèse est une partie de l'onglet « Compte ».
  await expect(p2.getByRole('heading', { level: 1, name: 'Compte' })).toBeVisible();
  await expect(p2.getByRole('heading', { level: 2, name: 'Sécurité', exact: true })).toBeVisible();
  const items = await p2.getByRole('navigation', { name: 'Sections des paramètres' }).locator('.set-nav-group, .set-nav-item').allTextContents();
  expect(items).not.toContain('Administration');
  expect(items).not.toContain('Sécurité');
  await expect(p2.locator('.sec-item strong').filter({ hasText: 'Double authentification' })).toBeVisible();
  await expect(p2.locator('.sec-item strong').filter({ hasText: 'Durée de session' })).toHaveCount(0);
  await expect(p2.getByText('réservés aux administrateurs')).toBeVisible();
  await editor.close();
});

test('clé d’API limitée à un espace : choix, garde-fous et affichage dans la liste', async ({ browser }) => {
  const ctx = await adminContext(browser);
  const spaces = (await (await api(ctx.request, 'GET', '/spaces')).json()) as { id: string; name: string; visibility: string }[];
  const space = spaces.find((s) => s.visibility === 'public')!;
  const page = await ctx.newPage();
  await page.goto('/settings/tokens');
  const name = `Clé limitée ${Math.random().toString(36).slice(2, 6)}`;
  await page.getByLabel('Nom', { exact: true }).fill(name);
  await expect(page.getByLabel('Tous mes espaces', { exact: true })).toBeChecked();
  const adminScope = page.getByRole('checkbox', { name: /Administration/ });
  await expect(adminScope).toBeEnabled();
  await adminScope.check();
  await page.getByLabel('Seulement ces espaces').check();
  // Une clé limitée ne peut pas administrer : la portée est décochée, désactivée, et l'explication s'affiche.
  await expect(adminScope).toBeDisabled();
  await expect(adminScope).not.toBeChecked();
  await expect(page.getByText('Une clé limitée à des espaces ne peut pas administrer l’instance.')).toBeVisible();
  await page.getByRole('button', { name: 'Créer le jeton' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Choisissez au moins un espace, ou « Tous mes espaces ».' })).toBeVisible();

  await page.getByRole('group', { name: 'Espaces autorisés' }).getByLabel(space.name, { exact: true }).check();
  const sent = page.waitForRequest((r) => r.url().endsWith('/api/v3/tokens') && r.method() === 'POST');
  await page.getByRole('button', { name: 'Créer le jeton' }).click();
  expect((await sent).postDataJSON()).toMatchObject({ name, spaceIds: [space.id] });
  await expect(page.getByText('Copiez ce jeton maintenant')).toBeVisible();
  const row = page.locator('.table-row', { hasText: name });
  await expect(row.locator('.token-spaces-line')).toHaveText(`Espaces : ${space.name}`);

  // Contrat du serveur : la liste porte les espaces autorisés.
  const tokens = (await (await api(ctx.request, 'GET', '/tokens')).json()) as { name: string; spaces?: { id: string; name: string }[] | null }[];
  expect(tokens.find((t) => t.name === name)?.spaces).toEqual([{ id: space.id, name: space.name }]);
  // Une clé sans restriction : « Tous les espaces ».
  await page.getByLabel('Nom', { exact: true }).fill(`${name} globale`);
  await page.getByRole('button', { name: 'Créer le jeton' }).click();
  await expect(page.locator('.table-row', { hasText: `${name} globale` }).locator('.token-spaces-line')).toHaveText('Espaces : Tous les espaces');
  await ctx.close();
});

test('jetons : liste vide d’espaces signalée, nombre de requêtes affiché', async ({ browser }) => {
  const ctx = await adminContext(browser);
  const page = await ctx.newPage();
  await page.route(/\/api\/v3\/tokens$/, (route) => (route.request().method() === 'GET' ? route.fulfill({ json: [
    { id: 't1', name: 'Clé orpheline', prefix: 'nb_abcd', scopes: ['read'], spaces: [], expiresAt: Date.now() + 86_400_000, createdAt: Date.now(), lastUsedAt: Date.now() - 3_600_000, requestCount: 42, revokedAt: null },
    { id: 't2', name: 'Clé ancienne', prefix: 'nb_efgh', scopes: ['read'], expiresAt: Date.now() + 86_400_000, createdAt: Date.now(), lastUsedAt: null, revokedAt: null },
  ] }) : route.fallback()));
  await page.goto('/settings/tokens');
  const orphan = page.locator('.table-row', { hasText: 'Clé orpheline' });
  await expect(orphan.locator('.token-spaces-line')).toHaveText('Espaces : Aucun espace (le jeton n’ouvre plus rien)');
  await expect(orphan).toContainText('42 requêtes');
  await expect(orphan).toContainText('dernier usage le');
  const old = page.locator('.table-row', { hasText: 'Clé ancienne' });
  await expect(old.locator('.token-spaces-line')).toHaveText('Espaces : Tous les espaces');
  await expect(old).toContainText('jamais utilisé');
  await ctx.close();
});
