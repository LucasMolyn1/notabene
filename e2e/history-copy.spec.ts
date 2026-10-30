import { expect, test, type Browser } from '@playwright/test';
import { ADMIN } from './accounts';
import { adminContext, api, createLocalUser, loginUi, PASSWORD, sessionContext } from './helpers';

const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const doc = (...content: object[]) => ({ type: 'doc', content });

async function spaces(browser: Browser) {
  const admin = await adminContext(browser);
  const list = (await (await api(admin.request, 'GET', '/spaces')).json()) as { id: string; name: string; visibility: string }[];
  await admin.close();
  return { pub: list.find((s) => s.visibility === 'public')!, team: list.find((s) => s.visibility === 'private')! };
}

// Deux auteurs différents : l'historique regroupe les modifications d'une même personne dans les cinq minutes.
async function pageWithTwoVersions(browser: Browser, title: string, first: object, second: object) {
  const admin = await adminContext(browser);
  await createLocalUser(admin.request, 'hist.auteur@e2e.test', 'Auteur historique', 'editor');
  const { pub } = await spaces(browser);
  const created = await (await api(admin.request, 'POST', '/pages', { spaceId: pub.id, title, content: first })).json();
  const author = await sessionContext(browser, 'hist.auteur@e2e.test', PASSWORD);
  const read = await api(author.request, 'GET', `/pages/${created.id}`);
  const me = await (await author.request.get('/api/v3/me')).json();
  const patch = await author.request.fetch(`/api/v3/pages/${created.id}`, { method: 'PATCH', headers: { 'x-csrf-token': me.csrf, 'if-match': read.headers().etag }, data: { content: second } });
  expect(patch.ok()).toBeTruthy();
  await Promise.all([admin.close(), author.close()]);
  return created.id as string;
}

test('l’historique montre les différences avec la version actuelle', async ({ page, browser }) => {
  const id = await pageWithTwoVersions(browser, 'Historique e2e',
    doc(para('Premier paragraphe'), para('Le chat dort'), para('Paragraphe supprimé')),
    doc(para('Premier paragraphe'), para('Le chien dort'), para('Paragraphe ajouté')));
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto(`/p/${id}`);
  await page.locator('.prose p').first().waitFor();
  await page.getByRole('button', { name: 'Historique des versions' }).click();
  const dialog = page.getByRole('dialog', { name: 'Historique de la page' });
  await dialog.locator('.hist-item').nth(1).click();
  await expect(dialog.getByText('Premier paragraphe')).toBeVisible();
  await dialog.getByRole('button', { name: 'Différences avec la version actuelle' }).click();
  await expect(dialog.locator('.diff-w-del')).toHaveText(['chat', 'supprimé']);
  await expect(dialog.locator('.diff-w-add')).toHaveText(['chien', 'ajouté']);
  await expect(dialog.locator('.diff-chg').first()).toHaveText('Le chatchien dort'); // mot supprimé puis mot ajouté, sur la même ligne
  await expect(dialog.locator('.diff-same')).toHaveText('Premier paragraphe');
  await expect(dialog.locator('.diff-del, .diff-add')).toHaveCount(0); // un paragraphe remplacé est une modification, pas deux blocs
  await expect(dialog).not.toContainText('false');
  await dialog.getByRole('button', { name: 'Aperçu' }).click();
  await expect(dialog.locator('.diff')).toHaveCount(0);
  await expect(dialog.locator('.prose.readonly')).toContainText('Paragraphe supprimé');
});

test('une page indique les pages qui renvoient vers elle', async ({ page, browser }) => {
  const admin = await adminContext(browser);
  const { pub } = await spaces(browser);
  const target = await (await api(admin.request, 'POST', '/pages', { spaceId: pub.id, title: 'Cible rétroliens e2e' })).json();
  await api(admin.request, 'POST', '/pages', { spaceId: pub.id, title: 'Page qui renvoie e2e', content: doc({ type: 'paragraph', content: [{ type: 'pageLink', attrs: { id: target.id } }] }) });
  await admin.close();
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto(`/p/${target.id}`);
  await page.getByRole('button', { name: '1 page renvoie ici' }).click();
  await page.getByRole('menuitem', { name: 'Page qui renvoie e2e' }).click();
  await expect(page.getByRole('textbox', { name: 'Titre de la page' })).toHaveValue('Page qui renvoie e2e');
});

test('copier une page vers un autre espace depuis la barre latérale', async ({ page, browser }) => {
  const admin = await adminContext(browser);
  const { pub, team } = await spaces(browser);
  const root = await (await api(admin.request, 'POST', '/pages', { spaceId: pub.id, title: 'À copier e2e', content: doc(para('contenu copié')) })).json();
  await api(admin.request, 'POST', '/pages', { spaceId: pub.id, parentId: root.id, title: 'Sous-page à copier e2e' });
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto(`/p/${root.id}`);
  const row = page.getByRole('treeitem', { name: 'À copier e2e' });
  await row.focus();
  await page.keyboard.press('Shift+F10');
  await page.getByRole('menuitem', { name: `Copier vers ${team.name}` }).click();
  await expect(page.getByText(/Copiée vers .* \(2 pages\)/)).toBeVisible();
  const listed = (await (await api(admin.request, 'GET', `/pages?spaceId=${team.id}&limit=200`)).json()).items as { title: string; spaceId: string }[];
  expect(listed.map((p) => p.title)).toEqual(expect.arrayContaining(['À copier e2e', 'Sous-page à copier e2e']));
  const original = (await (await api(admin.request, 'GET', `/pages?spaceId=${pub.id}&limit=200`)).json()).items as { title: string }[];
  expect(original.map((p) => p.title)).toContain('À copier e2e');
  await admin.close();
});
