// Vérification de page dans le navigateur : désigner un vérificateur, marquer vérifiée, pastille mise à jour (y compris en
// temps réel chez un autre), liste « Pages à revoir » (onglets, filtres), refus lisible, affichage en largeur téléphone.
import { expect, test, type Page } from '@playwright/test';
import { ADMIN } from './accounts';
import { adminContext, api, createLocalUser, loginUi, PASSWORD, sessionContext } from './helpers';

const REVIEWER = { email: 'verif.relectrice@e2e.test', name: 'Relectrice Vérif' };

async function publicSpace(request: Parameters<typeof api>[0]) {
  const spaces = (await (await api(request, 'GET', '/spaces')).json()) as { id: string; visibility: string }[];
  return spaces.find((s) => s.visibility === 'public')!.id;
}

const userId = async (request: Parameters<typeof api>[0], email: string) =>
  ((await (await api(request, 'GET', '/admin/users')).json()) as { id: string; email: string }[]).find((u) => u.email === email)!.id;

const badge = (page: Page) => page.locator('.verif-badge');

test('désigner un vérificateur, marquer vérifiée, voir la pastille et la liste à revoir', async ({ page, browser }) => {
  const admin = await adminContext(browser);
  await createLocalUser(admin.request, REVIEWER.email, REVIEWER.name, 'editor');
  const reviewerId = await userId(admin.request, REVIEWER.email);
  const spaceId = await publicSpace(admin.request);
  const created = await (await api(admin.request, 'POST', '/pages', { spaceId, title: 'Vérification parcours e2e' })).json();
  // Seconde page, en attente chez la relectrice seulement : visible de l'administrateur dans « Toutes », pas dans « À revoir ».
  const other = await (await api(admin.request, 'POST', '/pages', { spaceId, title: 'Vérification autre e2e' })).json();
  expect((await api(admin.request, 'PUT', `/pages/${other.id}/verification`, { verifierIds: [reviewerId], intervalDays: null })).ok()).toBeTruthy();

  // L'administrateur désigne la relectrice, avec une échéance de 90 jours.
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto(`/p/${created.id}`);
  await page.locator('.prose').first().waitFor();
  await expect(badge(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Plus d’options' }).click();
  await page.getByRole('menuitem', { name: 'Vérification' }).click();
  const dialog = page.getByRole('dialog', { name: 'Vérification de la page' });
  await expect(dialog.getByText('Aucune vérification n’est configurée sur cette page.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Choisissez au moins un vérificateur.');
  await dialog.getByRole('searchbox', { name: 'Vérificateurs' }).fill('Relectrice');
  await dialog.getByRole('button', { name: `Ajouter ${REVIEWER.name}` }).click();
  await expect(dialog.getByRole('list', { name: 'Vérificateurs choisis' }).getByText(REVIEWER.name)).toBeVisible();
  await dialog.getByLabel('Échéance après chaque vérification').selectOption('custom');
  await dialog.getByLabel('Nombre de jours (1 à 3650)').fill('5000');
  await dialog.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(dialog.getByRole('alert')).toContainText('de 1 à 3650');
  await dialog.getByLabel('Échéance après chaque vérification').selectOption('90');
  await dialog.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(page.getByText('Vérification enregistrée')).toBeVisible();
  await expect(dialog.locator('.verif-dl')).toContainText(REVIEWER.name);
  await expect(dialog.locator('.verif-dl')).toContainText('Jamais');
  await dialog.getByRole('button', { name: 'Fermer' }).first().click();
  await expect(badge(page)).toHaveText('En attente de vérification');

  // La relectrice retrouve la page dans « Pages à revoir » (sans onglet « Toutes ») et l'ouvre.
  const reviewer = await sessionContext(browser, REVIEWER.email, PASSWORD);
  const rPage = await reviewer.newPage();
  await rPage.goto('/');
  await rPage.getByRole('complementary', { name: 'Navigation' }).getByRole('button', { name: 'Pages à revoir' }).click();
  const list = rPage.getByRole('dialog', { name: 'Pages à revoir' });
  await expect(list.getByRole('tablist')).toHaveCount(0);
  const row = list.getByRole('link', { name: /Vérification parcours e2e/ });
  await expect(row).toContainText('En attente de vérification');
  await expect(list.getByRole('link', { name: /Vérification autre e2e/ })).toBeVisible();
  await list.getByRole('button', { name: 'Expirée' }).click();
  await expect(list.getByRole('button', { name: 'Expirée' })).toHaveAttribute('aria-pressed', 'true');
  await expect(list.getByText('Aucune de vos pages n’a ce statut.')).toBeVisible();
  await list.getByRole('button', { name: 'En attente' }).click();
  await row.click();
  await expect(list).toHaveCount(0);
  await expect(rPage).toHaveURL(new RegExp(`${created.id}$`));

  // Elle marque la page vérifiée depuis la pastille.
  await badge(rPage).click();
  const rDialog = rPage.getByRole('dialog', { name: 'Vérification de la page' });
  await rDialog.getByRole('button', { name: 'Marquer comme vérifiée' }).click();
  await expect(rPage.getByText('Page marquée comme vérifiée')).toBeVisible();
  await expect(rDialog.locator('.verif-dl')).toContainText(`par ${REVIEWER.name}`);
  await rPage.keyboard.press('Escape');
  await expect(badge(rPage)).toHaveText(/^Vérifiée jusqu’au [\d/]{5,10}$/);

  // Chez l'administrateur, la pastille suit sans recharger (flux temps réel).
  await expect(badge(page)).toHaveText(/^Vérifiée jusqu’au /);

  // L'administrateur voit la seconde page dans « Toutes », pas dans « À revoir » ; flèches du clavier entre les onglets.
  await page.getByRole('complementary', { name: 'Navigation' }).getByRole('button', { name: 'Pages à revoir' }).click();
  const aList = page.getByRole('dialog', { name: 'Pages à revoir' });
  const mine = aList.getByRole('tab', { name: 'À revoir' });
  await expect(mine).toHaveAttribute('aria-selected', 'true');
  await expect(aList.getByRole('tabpanel')).not.toHaveAttribute('aria-busy', 'true');
  await expect(aList.getByRole('link', { name: /Vérification autre e2e/ })).toHaveCount(0);
  await expect(aList.getByRole('link', { name: /Vérification parcours e2e/ })).toHaveCount(0);
  await mine.focus();
  await page.keyboard.press('ArrowRight');
  await expect(aList.getByRole('tab', { name: 'Toutes' })).toHaveAttribute('aria-selected', 'true');
  await expect(aList.getByRole('tab', { name: 'Toutes' })).toBeFocused();
  await expect(aList.getByRole('link', { name: /Vérification autre e2e/ })).toBeVisible();
  await page.keyboard.press('Escape');

  // Une modification après la vérification est signalée, sans invalider la vérification.
  await page.close();
  const read = await api(admin.request, 'GET', `/pages/${created.id}`);
  const me = await (await admin.request.get('/api/v3/me')).json();
  const patched = await admin.request.fetch(`/api/v3/pages/${created.id}`, {
    method: 'PATCH', headers: { 'x-csrf-token': me.csrf, 'if-match': read.headers().etag },
    data: { content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Modifiée après vérification' }] }] } },
  });
  expect(patched.ok()).toBeTruthy();
  await rPage.reload();
  await expect(badge(rPage)).toContainText('modifiée depuis la vérification');
  await expect(badge(rPage)).toContainText('Vérifiée jusqu’au');

  await api(admin.request, 'DELETE', `/pages/${other.id}/verification`);
  await Promise.all([admin.close(), reviewer.close()]);
});

test('un vérificateur refusé par le serveur est signalé lisiblement ; un lecteur voit la vérification en lecture seule', async ({ page, browser }) => {
  const admin = await adminContext(browser);
  await createLocalUser(admin.request, 'verif.lecteur@e2e.test', 'Lecteur Vérif', 'reader');
  const spaceId = await publicSpace(admin.request);
  const me = await (await api(admin.request, 'GET', '/me')).json();
  const created = await (await api(admin.request, 'POST', '/pages', { spaceId, title: 'Vérification refus e2e' })).json();

  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto(`/p/${created.id}`);
  await page.locator('.prose').first().waitFor();
  await page.getByRole('button', { name: 'Plus d’options' }).click();
  await page.getByRole('menuitem', { name: 'Vérification' }).click();
  const dialog = page.getByRole('dialog', { name: 'Vérification de la page' });
  await dialog.getByRole('searchbox', { name: 'Vérificateurs' }).fill('Admin E2E');
  await dialog.getByRole('button', { name: 'Ajouter Admin E2E', exact: true }).click();
  // Le serveur refuse (compte devenu inactif entre-temps, par exemple) : simulé ici.
  await page.route(`**/api/v3/pages/${created.id}/verification`, (route) => (route.request().method() === 'PUT'
    ? route.fulfill({ status: 422, contentType: 'application/problem+json', body: JSON.stringify({ status: 422, detail: 'Refusé', refused: [me.user.id] }) })
    : route.continue()));
  await dialog.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(dialog.getByRole('alert')).toContainText('ne peut pas être vérificateur : Admin E2E');
  await expect(dialog.locator('.verif-chip.refused')).toContainText('(refusé)');
  await page.unroute(`**/api/v3/pages/${created.id}/verification`);
  await dialog.getByRole('button', { name: 'Enregistrer' }).click();
  await expect(dialog.locator('.verif-dl')).toBeVisible();
  await expect(badge(page)).toHaveText('En attente de vérification');

  // Un lecteur : statut et vérificateurs visibles, aucun réglage ni bouton pour marquer.
  const reader = await sessionContext(browser, 'verif.lecteur@e2e.test', PASSWORD);
  const rPage = await reader.newPage();
  await rPage.goto(`/p/${created.id}`);
  await badge(rPage).click();
  const rDialog = rPage.getByRole('dialog', { name: 'Vérification de la page' });
  await expect(rDialog.locator('.verif-dl')).toContainText('En attente de vérification');
  await expect(rDialog.getByRole('button', { name: 'Marquer comme vérifiée' })).toHaveCount(0);
  await expect(rDialog.getByRole('button', { name: 'Enregistrer' })).toHaveCount(0);

  // Retrait par l'administrateur : la pastille disparaît.
  await dialog.getByRole('button', { name: 'Retirer la vérification' }).click();
  await page.getByRole('dialog', { name: 'Retirer la vérification ?' }).getByRole('button', { name: 'Retirer' }).click();
  await expect(page.getByText('Vérification retirée')).toBeVisible();
  await expect(badge(page)).toHaveCount(0);
  await Promise.all([admin.close(), reader.close()]);
});

test.describe('largeur téléphone (375 px)', () => {
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });
  const overflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

  test('pastille, boîte de dialogue et liste à revoir tiennent dans l’écran', async ({ page, browser }) => {
    const admin = await adminContext(browser);
    const spaceId = await publicSpace(admin.request);
    const me = await (await api(admin.request, 'GET', '/me')).json();
    // Titre long : l'adresse lisible (titre tronqué à 60 caractères et identifiant) dépasse 64 caractères et doit rester ouvrable.
    const created = await (await api(admin.request, 'POST', '/pages', { spaceId, title: 'Vérification mobile e2e avec un titre assez long pour être tronqué proprement' })).json();
    expect((await api(admin.request, 'PUT', `/pages/${created.id}/verification`, { verifierIds: [me.user.id], intervalDays: 30 })).ok()).toBeTruthy();
    await admin.close();

    await loginUi(page, ADMIN.email, ADMIN.password);
    await page.goto(`/p/${created.id}`);
    await expect(badge(page)).toHaveText('En attente de vérification');
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    const box = await badge(page).boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(40);

    // Le menu « … » donne aussi accès à la vérification sur téléphone.
    await page.getByRole('button', { name: 'Plus d’options' }).click();
    await page.getByRole('menuitem', { name: 'Vérification' }).click();
    const dialog = page.getByRole('dialog', { name: 'Vérification de la page' });
    await dialog.getByRole('button', { name: 'Marquer comme vérifiée' }).waitFor();
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    const width = await dialog.evaluate((el) => el.getBoundingClientRect().width);
    expect(width).toBeLessThanOrEqual(375);
    await dialog.getByRole('button', { name: 'Fermer' }).first().click();

    await page.getByRole('button', { name: /Barre latérale/ }).click();
    await page.getByRole('complementary', { name: 'Navigation' }).getByRole('button', { name: 'Pages à revoir' }).click();
    const list = page.getByRole('dialog', { name: 'Pages à revoir' });
    const row = list.getByRole('link', { name: /Vérification mobile e2e/ });
    await row.waitFor();
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    const rowBox = await row.boundingBox();
    expect(rowBox!.x + rowBox!.width).toBeLessThanOrEqual(375);
    await row.click();
    await expect(list).toHaveCount(0);
  });
});
