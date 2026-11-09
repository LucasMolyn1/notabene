// Accusé de lecture dans le navigateur : demander l'accusé, un second compte accuse réception (annonce, transparence
// visible avant le clic), la liste de l'auteur le montre, un lecteur ne voit pas la liste, page modifiée puis confirmée
// à nouveau, retrait de la demande qui efface les accusés ; liste paginée (erreur, « Réessayer », « Voir plus ») ; 375 px.
import { expect, test, type Page } from '@playwright/test';
import { ADMIN } from './accounts';
import { adminContext, api, createLocalUser, loginUi, PASSWORD, sessionContext } from './helpers';

const AUTHOR = { email: 'accuse.auteure@e2e.test', name: 'Auteure Accusé' };
const READER = { email: 'accuse.lecteur@e2e.test', name: 'Lecteur Accusé' };
const EDITOR = { email: 'accuse.editeur@e2e.test', name: 'Éditeur Accusé' };
const TRANSPARENCY = 'Votre accusé est visible du demandeur, de l’auteur de la page et des administrateurs.';

async function publicSpace(request: Parameters<typeof api>[0]) {
  const spaces = (await (await api(request, 'GET', '/spaces')).json()) as { id: string; visibility: string }[];
  return spaces.find((s) => s.visibility === 'public')!.id;
}

const bar = (page: Page) => page.locator('.rr-bar');
const toasts = (page: Page) => page.locator('.toasts');

async function openDialog(page: Page) {
  await page.getByRole('button', { name: 'Plus d’options' }).click();
  await page.getByRole('menuitem', { name: 'Accusé de lecture' }).click();
  const dialog = page.getByRole('dialog', { name: 'Accusé de lecture' });
  await dialog.locator('.rr-status').waitFor();
  return dialog;
}

test('demander, accuser réception, voir la liste, confirmer à nouveau après modification, retirer la demande', async ({ browser }) => {
  const admin = await adminContext(browser);
  await createLocalUser(admin.request, AUTHOR.email, AUTHOR.name, 'editor');
  await createLocalUser(admin.request, READER.email, READER.name, 'reader');
  await createLocalUser(admin.request, EDITOR.email, EDITOR.name, 'editor');
  const spaceId = await publicSpace(admin.request);
  const author = await sessionContext(browser, AUTHOR.email, PASSWORD);
  const res = await api(author.request, 'POST', '/pages', { spaceId, title: 'Accusé de lecture parcours e2e' });
  expect(res.ok()).toBeTruthy();
  const created = await res.json();

  // L'auteure demande l'accusé depuis le menu « … ».
  const aPage = await author.newPage();
  await aPage.goto(`/p/${created.id}`);
  await aPage.locator('.prose').first().waitFor();
  await expect(bar(aPage)).toBeHidden();
  let dialog = await openDialog(aPage);
  await expect(dialog.getByText('Aucun accusé de lecture n’est demandé sur cette page.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Demander un accusé de lecture' }).click();
  await expect(toasts(aPage).getByText('Accusé de lecture demandé')).toBeVisible();
  await expect(dialog.locator('.rr-status')).toBeFocused();
  await expect(dialog.locator('.rr-status')).toContainText(`par ${AUTHOR.name}`);
  await expect(dialog.getByRole('heading', { name: 'Lecteurs' })).toBeVisible();
  await expect(dialog.getByText('Personne n’a encore confirmé la lecture.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Fermer' }).first().click();
  await expect(bar(aPage)).toContainText('Accusé de lecture demandé');

  // Le lecteur voit le bandeau et le texte de transparence avant de cliquer ; l'enregistrement est annoncé.
  const reader = await sessionContext(browser, READER.email, PASSWORD);
  const rPage = await reader.newPage();
  await rPage.goto(`/p/${created.id}`);
  const rBar = rPage.getByRole('region', { name: 'Accusé de lecture' });
  await expect(rBar).toContainText(`Accusé de lecture demandé par ${AUTHOR.name}`);
  await expect(rBar.getByText(TRANSPARENCY)).toBeVisible();
  await rBar.getByRole('button', { name: 'J’ai lu' }).click();
  await expect(rBar.getByRole('status')).toHaveText('Accusé de lecture enregistré.');
  await expect(rBar.locator('.rr-text')).toHaveText(/^Lu le \d{2}\/\d{2}\/\d{4}$/);
  await expect(rBar.locator('.rr-text')).toBeFocused();
  await expect(rBar.getByRole('button', { name: 'J’ai lu' })).toHaveCount(0);

  // Il ne voit que son propre accusé, ni liste ni nombre, ni retrait de la demande ; l'API lui refuse la liste.
  dialog = await openDialog(rPage);
  await expect(dialog.locator('.rr-mine')).toHaveText(/^Lu le \d{2}\/\d{2}\/\d{4}$/);
  await expect(dialog.getByText(`${TRANSPARENCY} Seules ces personnes voient la liste des lecteurs.`)).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Lecteurs' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Retirer la demande' })).toHaveCount(0);
  expect((await api(reader.request, 'GET', `/pages/${created.id}/read-receipt/readers`)).status()).toBe(403);
  await rPage.keyboard.press('Escape');

  // Un autre éditeur ne peut pas retirer la demande : il le lit au lieu d'un bouton qui échouerait.
  const editor = await sessionContext(browser, EDITOR.email, PASSWORD);
  const ePage = await editor.newPage();
  await ePage.goto(`/p/${created.id}`);
  dialog = await openDialog(ePage);
  await expect(dialog.getByText('Seuls la personne qui a demandé l’accusé, l’auteur de la page et les administrateurs peuvent retirer cette demande.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Retirer la demande' })).toHaveCount(0);
  await ePage.close();

  // La liste de l'auteure montre le lecteur (relue à l'ouverture : un accusé n'est pas diffusé en temps réel).
  dialog = await openDialog(aPage);
  await expect(dialog.getByText('1 personne a confirmé la lecture.')).toBeVisible();
  const list = dialog.getByRole('list', { name: 'Personnes qui ont confirmé la lecture' });
  await expect(list.getByRole('listitem')).toHaveCount(1);
  await expect(list.getByRole('listitem')).toContainText(READER.name);
  await expect(list.getByRole('listitem')).toContainText(/Lu le \d{2}\/\d{2}\/\d{4}/);
  await aPage.keyboard.press('Escape');

  // La page est modifiée : l'accusé du lecteur est antérieur, signalé chez lui et dans la liste.
  const read = await api(admin.request, 'GET', `/pages/${created.id}`);
  const me = await (await admin.request.get('/api/v3/me')).json();
  const patched = await admin.request.fetch(`/api/v3/pages/${created.id}`, {
    method: 'PATCH', headers: { 'x-csrf-token': me.csrf, 'if-match': read.headers().etag },
    data: { content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Modifiée après lecture' }] }] } },
  });
  expect(patched.ok()).toBeTruthy();
  dialog = await openDialog(aPage);
  await expect(dialog.getByRole('listitem').filter({ hasText: READER.name })).toContainText('lu avant la dernière modification');
  await aPage.keyboard.press('Escape');
  await rPage.reload();
  await expect(rBar.locator('.rr-text')).toHaveText('Lu avant la dernière modification');
  await rBar.getByRole('button', { name: 'Confirmer à nouveau' }).click();
  await expect(rBar.getByRole('status')).toHaveText('Lecture confirmée à nouveau.');
  await expect(rBar.locator('.rr-text')).toHaveText(/^Lu le /);

  // L'auteure retire la demande : confirmation explicite avec le nombre, accusés effacés, bandeau retiré chez le lecteur.
  dialog = await openDialog(aPage);
  await expect(dialog.getByRole('listitem').filter({ hasText: READER.name })).not.toContainText('lu avant la dernière modification');
  await dialog.getByRole('button', { name: 'Retirer la demande' }).click();
  const confirm = aPage.getByRole('dialog', { name: 'Retirer la demande ?' });
  await expect(confirm).toContainText('Retirer la demande efface les accusés déjà enregistrés (1 accusé enregistré).');
  await confirm.getByRole('button', { name: 'Retirer la demande' }).click();
  await expect(toasts(aPage).getByText('Demande retirée. 1 accusé effacé.')).toBeVisible();
  await expect(dialog.getByText('Aucun accusé de lecture n’est demandé sur cette page.')).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Lecteurs' })).toHaveCount(0);
  await aPage.keyboard.press('Escape');
  await expect(bar(aPage)).toBeHidden();
  await expect(bar(rPage)).toBeHidden();
  const state = await (await api(reader.request, 'GET', `/pages/${created.id}/read-receipt`)).json();
  expect(state).toMatchObject({ requested: false, myAck: null });

  // Sans demande, le menu du lecteur ne propose plus l'entrée.
  await rPage.getByRole('button', { name: 'Plus d’options' }).click();
  await expect(rPage.getByRole('menuitem', { name: 'Vérification' })).toBeVisible();
  await expect(rPage.getByRole('menuitem', { name: 'Accusé de lecture' })).toHaveCount(0);
  await Promise.all([admin.close(), author.close(), reader.close(), editor.close()]);
});

test('liste des lecteurs : erreur et « Réessayer », puis « Voir plus » par curseur', async ({ browser }) => {
  const admin = await adminContext(browser);
  const spaceId = await publicSpace(admin.request);
  const created = await (await api(admin.request, 'POST', '/pages', { spaceId, title: 'Accusé de lecture liste e2e' })).json();
  expect((await api(admin.request, 'PUT', `/pages/${created.id}/read-receipt`)).ok()).toBeTruthy();
  const page = await admin.newPage();
  const at = Date.UTC(2026, 10, 2, 9);
  let calls = 0;
  await page.route(`**/api/v3/pages/${created.id}/read-receipt/readers?**`, (route) => {
    calls += 1;
    const cursor = new URL(route.request().url()).searchParams.get('cursor');
    if (calls === 1) return route.fulfill({ status: 500, contentType: 'application/problem+json', body: JSON.stringify({ status: 500, detail: 'Panne simulée' }) });
    const body = cursor
      ? { items: [{ user: { id: 'u2', name: 'Seconde Personne' }, ackedAt: at, modifiedSinceAck: true }], nextCursor: null }
      : { items: [{ user: { id: 'u1', name: 'Première Personne' }, ackedAt: at, modifiedSinceAck: false }], nextCursor: 'suite' };
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto(`/p/${created.id}`);
  await bar(page).waitFor();
  const dialog = await openDialog(page);
  await expect(dialog.getByRole('alert')).toContainText('Panne simulée');
  await dialog.getByRole('button', { name: 'Réessayer' }).click();
  const list = dialog.getByRole('list', { name: 'Personnes qui ont confirmé la lecture' });
  await expect(list.getByRole('listitem')).toHaveText(['Première PersonneLu le 02/11/2026']);
  await dialog.getByRole('button', { name: 'Voir plus' }).click();
  await expect(list.getByRole('listitem')).toHaveCount(2);
  await expect(list.getByRole('listitem').nth(1)).toContainText('Seconde Personne');
  await expect(list.getByRole('listitem').nth(1)).toContainText('lu avant la dernière modification');
  await expect(list.getByRole('listitem').nth(1)).toBeFocused();
  await expect(dialog.getByRole('button', { name: 'Voir plus' })).toHaveCount(0);
  await page.unroute(`**/api/v3/pages/${created.id}/read-receipt/readers?**`);
  await api(admin.request, 'DELETE', `/pages/${created.id}/read-receipt`);
  await admin.close();
});

test.describe('largeur téléphone (375 px)', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });
  const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

  test('bandeau et fenêtre tiennent dans l’écran', async ({ page, browser }) => {
    const admin = await adminContext(browser);
    const spaceId = await publicSpace(admin.request);
    const created = await (await api(admin.request, 'POST', '/pages', { spaceId, title: 'Accusé de lecture mobile e2e' })).json();
    expect((await api(admin.request, 'PUT', `/pages/${created.id}/read-receipt`)).ok()).toBeTruthy();
    await admin.close();
    await loginUi(page, ADMIN.email, ADMIN.password);
    await page.goto(`/p/${created.id}`);
    const ack = bar(page).getByRole('button', { name: 'J’ai lu' });
    await ack.waitFor();
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    const box = await ack.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(40);
    expect(box!.x + box!.width).toBeLessThanOrEqual(375);
    await ack.click();
    await expect(bar(page).locator('.rr-text')).toHaveText(/^Lu le /);

    const dialog = await openDialog(page);
    await dialog.getByRole('list', { name: 'Personnes qui ont confirmé la lecture' }).waitFor();
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    const width = await dialog.evaluate((el) => el.getBoundingClientRect().width);
    expect(width).toBeLessThanOrEqual(375);
    await dialog.getByRole('button', { name: 'Retirer la demande' }).click();
    await page.getByRole('dialog', { name: 'Retirer la demande ?' }).getByRole('button', { name: 'Retirer la demande' }).click();
    await expect(bar(page)).toBeHidden();
  });
});
