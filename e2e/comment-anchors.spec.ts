import { expect, test, type Browser } from '@playwright/test';
import { ADMIN } from './accounts';
import { adminContext, api, createLocalUser, loginUi, PASSWORD, sessionContext } from './helpers';

async function newPage(browser: Browser, title: string, text: string) {
  const admin = await adminContext(browser);
  const spaces = (await (await api(admin.request, 'GET', '/spaces')).json()) as { id: string; visibility: string }[];
  const created = await (await api(admin.request, 'POST', '/pages', {
    spaceId: spaces.find((s) => s.visibility === 'public')!.id, title,
    content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
  })).json();
  await admin.close();
  return created.id as string;
}

test('commenter un texte : surlignage, retour au fil, résolution, texte supprimé', async ({ page, browser }) => {
  const id = await newPage(browser, 'Ancres e2e', 'Le passage à commenter');
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto(`/p/${id}`);
  await page.locator('.prose p').first().waitFor();

  await page.locator('.prose p').first().selectText();
  await page.getByRole('button', { name: 'Commenter la sélection' }).click();
  const dialog = page.getByRole('dialog', { name: 'Commentaires' });
  await expect(dialog.getByText('Commentaire sur ce texte :')).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Nouveau commentaire' }).fill('Voir cette phrase');
  await dialog.getByRole('button', { name: 'Commenter', exact: true }).click();
  await expect(dialog.getByText('Voir cette phrase')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Voir dans la page' })).toBeVisible();
  await dialog.getByText('Fermer', { exact: true }).click();

  // Le texte est surligné ; un clic rouvre le fil.
  const anchor = page.locator('.comment-live');
  await expect(anchor).toHaveText('Le passage à commenter');
  await anchor.click();
  await expect(dialog.locator('.comment.focused')).toContainText('Voir cette phrase');

  // Résolution : le surlignage change.
  await dialog.getByRole('button', { name: 'Résoudre' }).click();
  await dialog.getByText('Fermer', { exact: true }).click();
  await expect(page.locator('.comment-resolved')).toHaveCount(1);
  await expect(page.locator('.comment-live')).toHaveCount(0);

  // Texte supprimé : le fil est signalé comme orphelin.
  await page.locator('.prose p').first().selectText();
  await page.keyboard.type('Autre texte');
  await expect(page.locator('[data-comment-id]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Commentaires' }).click();
  await expect(dialog.getByText('Texte supprimé de la page')).toBeVisible();
  await expect(dialog.locator('.comment-quote')).toHaveText('Le passage à commenter');
});

test('mentionner quelqu’un dans un commentaire et dans la page, sans notifier une personne sans accès', async ({ page, browser }) => {
  const admin = await adminContext(browser);
  await createLocalUser(admin.request, 'ment.cible@e2e.test', 'Ment Cible', 'editor');
  await createLocalUser(admin.request, 'ment.exclu@e2e.test', 'Ment Exclu', 'editor');
  const users = (await (await api(admin.request, 'GET', '/admin/users')).json()) as { id: string; email: string }[];
  const target = users.find((u) => u.email === 'ment.cible@e2e.test')!;
  await admin.close();
  const id = await newPage(browser, 'Mentions e2e', 'Page de mentions');
  const adminCtx = await adminContext(browser);
  expect((await api(adminCtx.request, 'PUT', `/pages/${id}/permissions`, { entries: [{ userId: target.id, level: 'write' }] })).ok()).toBeTruthy();

  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto(`/p/${id}`);
  await page.locator('.prose p').first().waitFor();

  // Dans un commentaire : la liste ne propose que les personnes qui ont accès à la page restreinte.
  await page.getByRole('button', { name: 'Commentaires' }).click();
  const dialog = page.getByRole('dialog', { name: 'Commentaires' });
  const box = dialog.getByRole('textbox', { name: 'Nouveau commentaire' });
  await box.fill('Bonjour @Ment');
  const list = page.getByRole('listbox', { name: 'Personnes à mentionner' });
  await expect(list.getByRole('option', { name: 'Ment Cible' })).toBeVisible();
  await expect(list.getByRole('option', { name: 'Ment Exclu' })).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect(box).toHaveValue('Bonjour @Ment Cible ');
  await dialog.getByRole('button', { name: 'Commenter', exact: true }).click();
  await expect(dialog.locator('.comment-body .mention')).toHaveText('@Ment Cible');
  await dialog.getByText('Fermer', { exact: true }).click();

  const targetCtx = await sessionContext(browser, 'ment.cible@e2e.test', PASSWORD);
  const inbox = async () => ((await (await api(targetCtx.request, 'GET', '/notifications')).json()) as { items: { type: string }[] }).items.map((n) => n.type);
  expect(await inbox()).toEqual(['mention']);

  // Dans la page.
  await page.locator('.prose p').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' voir @Ment');
  await page.getByRole('listbox', { name: 'Personnes à mentionner' }).getByRole('option', { name: 'Ment Cible' }).waitFor();
  await page.keyboard.press('Enter');
  await expect(page.locator('.prose .mention')).toHaveText('@Ment Cible');
  // La mention est enregistrée avec la page : une seule notification de plus, et rien pour une personne sans accès.
  await expect.poll(async () => (await inbox()).length, { timeout: 15_000 }).toBe(1);
  const notified = await (await api(targetCtx.request, 'GET', '/notifications')).json();
  expect(JSON.stringify(notified)).toContain('Mentions e2e');
  const excluded = await sessionContext(browser, 'ment.exclu@e2e.test', PASSWORD).catch(() => null);
  if (excluded) expect(((await (await api(excluded.request, 'GET', '/notifications')).json()) as { items: unknown[] }).items).toEqual([]);
  await Promise.all([adminCtx.close(), targetCtx.close(), excluded?.close()]);
});
