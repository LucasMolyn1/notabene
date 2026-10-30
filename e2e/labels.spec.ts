import { expect, test } from '@playwright/test';
import { ADMIN } from './accounts';
import { adminContext, api, createLocalUser, loginUi, PASSWORD, sessionContext } from './helpers';

test('poser, retrouver, filtrer et retirer un libellé dans le navigateur', async ({ page, browser }) => {
  const TITLE = 'Libellés navigateur e2e';
  const admin = await adminContext(browser);
  const spaces = (await (await api(admin.request, 'GET', '/spaces')).json()) as { id: string; visibility: string }[];
  const created = await (await api(admin.request, 'POST', '/pages', { spaceId: spaces.find((s) => s.visibility === 'public')!.id, title: TITLE })).json();
  await admin.close();

  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto(`/p/${created.id}`);
  await page.locator('.prose').first().waitFor();

  await page.locator('.label-add').click();
  await page.getByRole('combobox', { name: 'Nouveau libellé' }).fill('Démarrage Rapide');
  await page.keyboard.press('Enter');
  const group = page.getByRole('group', { name: 'Libellés de la page' });
  const chip = group.getByRole('link', { name: 'démarrage-rapide' });
  await expect(chip).toBeVisible();
  // Le nom est affiché comme texte, jamais interprété.
  await page.locator('.label-add').click();
  await page.getByRole('combobox', { name: 'Nouveau libellé' }).fill('<b>x</b>');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Libellé invalide')).toBeVisible();
  await page.keyboard.press('Escape');

  // Persistant après rechargement.
  await page.reload();
  await expect(group.getByRole('link', { name: 'démarrage-rapide' })).toBeVisible();

  // Recherche rapide : « #libellé » liste les pages qui le portent.
  await page.keyboard.press('Control+k');
  const search = page.getByRole('combobox', { name: 'Rechercher' });
  await search.fill('#démarrage-rapide');
  await expect(page.getByRole('option', { name: /Libellés navigateur e2e/ })).toBeVisible();
  await search.fill('#inexistant-e2e');
  await expect(page.getByText('Aucun résultat')).toBeVisible();
  await page.keyboard.press('Escape');

  // La page du libellé.
  await group.getByRole('link', { name: 'démarrage-rapide' }).click();
  await expect(page).toHaveURL(/\/labels\/d%C3%A9marrage-rapide$/);
  await expect(page.getByRole('heading', { name: 'démarrage-rapide' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Libellés navigateur e2e/ })).toBeVisible();
  await page.getByRole('link', { name: /Libellés navigateur e2e/ }).click();

  // Retrait.
  await page.getByRole('button', { name: 'Retirer le libellé démarrage-rapide' }).click();
  await expect(group.getByRole('link', { name: 'démarrage-rapide' })).toHaveCount(0);
});

test('le libellé d’une page restreinte reste invisible pour les autres', async ({ browser }) => {
  const admin = await adminContext(browser);
  await createLocalUser(admin.request, 'label.keeper@e2e.test', 'Gardien libellé', 'editor');
  await createLocalUser(admin.request, 'label.curious@e2e.test', 'Curieux libellé', 'editor');
  const users = (await (await api(admin.request, 'GET', '/admin/users')).json()) as { id: string; email: string }[];
  const keeper = users.find((u) => u.email === 'label.keeper@e2e.test')!;
  const spaces = (await (await api(admin.request, 'GET', '/spaces')).json()) as { id: string; visibility: string }[];
  const team = spaces.find((s) => s.visibility === 'private')!;
  const created = await (await api(admin.request, 'POST', '/pages', { spaceId: team.id, title: 'Réservée libellés e2e' })).json();
  expect((await api(admin.request, 'PUT', `/pages/${created.id}/permissions`, { entries: [{ userId: keeper.id, level: 'write' }] })).ok()).toBeTruthy();

  const keeperCtx = await sessionContext(browser, 'label.keeper@e2e.test', PASSWORD);
  expect((await api(keeperCtx.request, 'POST', `/pages/${created.id}/labels`, { name: 'secret-e2e' })).ok()).toBeTruthy();

  const curious = await sessionContext(browser, 'label.curious@e2e.test', PASSWORD);
  expect((await api(curious.request, 'GET', `/pages/${created.id}/labels`)).status()).toBe(404);
  expect((await api(curious.request, 'POST', `/pages/${created.id}/labels`, { name: 'intrus' })).status()).toBe(404);
  expect(JSON.stringify(await (await api(curious.request, 'GET', '/labels')).json())).not.toContain('secret-e2e');
  expect(JSON.stringify(await (await api(curious.request, 'GET', '/pages?label=secret-e2e&limit=200')).json())).not.toContain('Réservée');
  expect(JSON.stringify(await (await api(keeperCtx.request, 'GET', '/labels')).json())).toContain('secret-e2e');

  // Dans le navigateur : pas de pastille ni de page pour le curieux.
  const page = await curious.newPage();
  await page.goto('/labels/secret-e2e');
  await expect(page.getByText('Aucune page ne porte ce libellé')).toBeVisible();
  await Promise.all([admin.close(), keeperCtx.close(), curious.close()]);
});
