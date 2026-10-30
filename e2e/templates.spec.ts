import { expect, test } from '@playwright/test';
import { ADMIN } from './accounts';
import { adminContext, api, createLocalUser, loginUi, PASSWORD, sessionContext } from './helpers';

async function publicSpaceId(admin: Awaited<ReturnType<typeof adminContext>>) {
  const spaces = (await (await api(admin.request, 'GET', '/spaces')).json()) as { id: string; visibility: string }[];
  return spaces.find((s) => s.visibility === 'public')!.id;
}

test('créer une page depuis un modèle fourni, enregistrer un modèle puis le réutiliser et le supprimer', async ({ page, browser }) => {
  const admin = await adminContext(browser);
  const source = await (await api(admin.request, 'POST', '/pages', {
    spaceId: await publicSpaceId(admin), title: 'Fiche projet e2e',
    content: { type: 'doc', content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Objectif du projet e2e' }] }, { type: 'paragraph' }] },
  })).json();
  await admin.close();

  await loginUi(page, ADMIN.email, ADMIN.password);

  // Modèle fourni.
  await page.getByRole('button', { name: 'Depuis un modèle' }).click();
  const dialog = page.getByRole('dialog', { name: 'Nouvelle page depuis un modèle' });
  await expect(dialog.getByRole('button', { name: /Compte rendu de réunion/ })).toBeVisible();
  await expect(dialog).not.toContainText('false');
  await dialog.getByRole('button', { name: /Compte rendu de réunion/ }).click();
  await expect(page.getByRole('heading', { name: 'Ordre du jour' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Titre de la page' })).toBeFocused();

  // Enregistrer une page comme modèle.
  await page.goto(`/p/${source.id}`);
  await page.locator('.prose').first().waitFor();
  await page.getByRole('button', { name: 'Plus d’options' }).click();
  await page.getByRole('menuitem', { name: 'Enregistrer comme modèle' }).click();
  await page.getByRole('textbox', { name: 'Nom du modèle' }).fill('Fiche projet (modèle e2e)');
  await page.getByRole('button', { name: 'Enregistrer', exact: true }).click();
  await expect(page.getByText('Modèle enregistré')).toBeVisible();

  // Le modèle n'est ni une page, ni dans la recherche.
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox', { name: 'Rechercher' }).fill('modèle e2e');
  await expect(page.getByText('Aucun résultat')).toBeVisible();
  await page.keyboard.press('Escape');

  // Réutilisation.
  await page.getByRole('button', { name: 'Depuis un modèle' }).click();
  await dialog.getByRole('button', { name: /^Fiche projet \(modèle e2e\)/ }).click();
  await expect(page.getByText('Objectif du projet e2e').first()).toBeVisible();
  await expect(page).not.toHaveURL(new RegExp(source.id));

  // Suppression avec confirmation.
  await page.getByRole('button', { name: 'Depuis un modèle' }).click();
  await dialog.getByRole('button', { name: 'Supprimer le modèle Fiche projet (modèle e2e)' }).click();
  await page.getByRole('dialog', { name: 'Supprimer le modèle' }).getByRole('button', { name: 'Supprimer' }).click();
  await expect(dialog.getByRole('button', { name: /^Fiche projet \(modèle e2e\)/ })).toHaveCount(0);
});

test('une page restreinte ne devient pas un modèle et un lecteur ne peut pas en créer', async ({ browser }) => {
  const admin = await adminContext(browser);
  await createLocalUser(admin.request, 'tpl.keeper@e2e.test', 'Gardien modèle', 'editor');
  await createLocalUser(admin.request, 'tpl.reader@e2e.test', 'Lecteur modèle', 'reader');
  const users = (await (await api(admin.request, 'GET', '/admin/users')).json()) as { id: string; email: string }[];
  const keeper = users.find((u) => u.email === 'tpl.keeper@e2e.test')!;
  const created = await (await api(admin.request, 'POST', '/pages', { spaceId: await publicSpaceId(admin), title: 'Réservée modèles e2e' })).json();
  expect((await api(admin.request, 'PUT', `/pages/${created.id}/permissions`, { entries: [{ userId: keeper.id, level: 'write' }] })).ok()).toBeTruthy();

  const keeperCtx = await sessionContext(browser, 'tpl.keeper@e2e.test', PASSWORD);
  expect((await api(keeperCtx.request, 'POST', '/templates', { pageId: created.id })).status()).toBe(403);
  const reader = await sessionContext(browser, 'tpl.reader@e2e.test', PASSWORD);
  expect((await api(reader.request, 'POST', '/templates', { pageId: created.id })).status()).toBe(403);
  expect((await api(reader.request, 'GET', '/templates')).status()).toBe(200);
  await Promise.all([admin.close(), keeperCtx.close(), reader.close()]);
});
