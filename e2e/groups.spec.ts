import { expect, test, type Browser } from '@playwright/test';
import { ADMIN } from './accounts';
import { adminContext, api, createLocalUser, loginUi, PASSWORD, sessionContext } from './helpers';

const MEMBER = 'groupe.membre@e2e.test';
const OTHER = 'groupe.autre@e2e.test';
const MANAGER = 'groupe.gestionnaire@e2e.test';

async function spacesFor(browser: Browser, email: string) {
  const ctx = await sessionContext(browser, email, PASSWORD);
  const list = (await (await api(ctx.request, 'GET', '/spaces')).json()) as { id: string; name: string; role: string }[];
  await ctx.close();
  return list;
}

test.beforeAll(async ({ browser }) => {
  const admin = await adminContext(browser);
  for (const [email, name] of [[MEMBER, 'Membre Groupe'], [OTHER, 'Autre Éditeur'], [MANAGER, 'Gestionnaire Espace']] as const) await createLocalUser(admin.request, email, name, 'editor');
  await admin.close();
});

test('un groupe créé et rempli par un administrateur ouvre un espace fermé à ses membres seulement', async ({ page, browser }) => {
  await loginUi(page, ADMIN.email, ADMIN.password);

  // Groupe local avec un membre.
  await page.goto('/settings/groups');
  await page.getByRole('button', { name: 'Nouveau groupe' }).click();
  await page.getByLabel('Nom du groupe', { exact: true }).fill('Équipe e2e');
  await page.getByRole('button', { name: 'Créer', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Membres de Équipe e2e' })).toBeVisible();
  await page.getByRole('button', { name: 'Membres de Équipe e2e' }).click();
  const members = page.getByRole('dialog', { name: /Membres de/ });
  await members.getByLabel('Ajouter une personne').selectOption({ label: `Membre Groupe (${MEMBER})` });
  await members.getByRole('button', { name: 'Ajouter', exact: true }).click();
  await expect(members.getByText('Membre Groupe')).toBeVisible();
  await members.getByRole('button', { name: 'Fermer' }).first().click();

  // Espace créé fermé par défaut.
  await page.goto('/settings/spaces');
  await page.getByRole('button', { name: 'Nouvel espace' }).click();
  await page.getByLabel('Nom de l’espace').fill('Espace fermé e2e');
  await expect(page.getByLabel('Qui y a accès au départ')).toHaveValue('admins');
  await page.getByRole('button', { name: 'Créer l’espace' }).click();
  await page.waitForURL(/\/s\//);
  expect((await spacesFor(browser, MEMBER)).map((s) => s.name)).not.toContain('Espace fermé e2e');

  // Ajout du groupe à l'espace, en édition.
  await page.goto('/settings/spaces');
  await page.getByRole('button', { name: 'Membres de Espace fermé e2e' }).click();
  const dialog = page.getByRole('dialog', { name: /Membres de/ });
  await dialog.getByLabel('Rôle à donner').selectOption('edit');
  await dialog.getByLabel('Chercher une personne ou un groupe').fill('Équipe');
  await dialog.getByRole('button', { name: 'Ajouter Équipe e2e' }).click();
  await expect(dialog.getByLabel('Rôle de Équipe e2e')).toHaveValue('edit');

  // Effet : le membre du groupe le voit et y écrit, un autre éditeur ne le voit pas.
  const seen = (await spacesFor(browser, MEMBER)).find((s) => s.name === 'Espace fermé e2e');
  expect(seen?.role).toBe('edit');
  expect((await spacesFor(browser, OTHER)).map((s) => s.name)).not.toContain('Espace fermé e2e');
  const ctx = await sessionContext(browser, MEMBER, PASSWORD);
  expect((await api(ctx.request, 'POST', '/pages', { spaceId: seen!.id, title: 'Page du groupe' })).status()).toBe(201);
  const other = await sessionContext(browser, OTHER, PASSWORD);
  expect((await api(other.request, 'POST', '/pages', { spaceId: seen!.id, title: 'Intrus' })).status()).toBe(404);
  await ctx.close(); await other.close();
});

test('un gestionnaire d’espace gère les membres de son espace sans accéder au reste de l’administration', async ({ page, browser }) => {
  const admin = await adminContext(browser);
  const created = await (await api(admin.request, 'POST', '/spaces', { name: 'Espace gestionnaire e2e', access: 'admins' })).json();
  const me = (await spacesFor(browser, MANAGER)).length;
  expect(me).toBeGreaterThanOrEqual(0);
  const users = (await (await api(admin.request, 'GET', '/admin/users')).json()) as { id: string; email: string }[];
  const managerId = users.find((u) => u.email === MANAGER)!.id;
  expect((await api(admin.request, 'PUT', `/spaces/${created.id}/members`, { userId: managerId, role: 'full' })).status()).toBe(204);
  await admin.close();

  await loginUi(page, MANAGER, PASSWORD);
  await page.goto('/settings/spaces');
  await expect(page.getByRole('button', { name: 'Membres de Espace gestionnaire e2e' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Nouvel espace' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Groupes' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Utilisateurs' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Modifier Espace gestionnaire e2e' }).click();
  await expect(page.getByLabel('Visibilité')).toHaveCount(0); // réservé aux administrateurs
  await page.keyboard.press('Escape');
  const ctx = await sessionContext(browser, MANAGER, PASSWORD);
  expect((await api(ctx.request, 'POST', '/groups', { name: 'Pirate' })).status()).toBe(403);
  expect((await api(ctx.request, 'PATCH', `/spaces/${created.id}`, { visibility: 'public' })).status()).toBe(403);
  await ctx.close();
});
