import { expect, test, type Browser } from '@playwright/test';
import { ADMIN } from './accounts';
import { adminContext, api, loginUi } from './helpers';

async function newPage(browser: Browser, title: string) {
  const admin = await adminContext(browser);
  const spaces = (await (await api(admin.request, 'GET', '/spaces')).json()) as { id: string; visibility: string }[];
  const created = await (await api(admin.request, 'POST', '/pages', { spaceId: spaces.find((s) => s.visibility === 'public')!.id, title })).json();
  await admin.close();
  return created.id as string;
}

const decoration = (loc: ReturnType<import('@playwright/test').Page['locator']>) => loc.evaluate((el) => getComputedStyle(el).textDecorationLine);

test('une liste de cases ne barre pas le texte coché, une liste de tâches le barre', async ({ page, browser }) => {
  const id = await newPage(browser, 'Liste de cases e2e');
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto(`/p/${id}`);
  const editor = page.locator('.ProseMirror[contenteditable="true"]').first();
  await editor.click();

  // Liste de cases : cocher une case ne barre pas le texte.
  await page.keyboard.type('/cases');
  await page.locator('.slash-menu').getByText('Liste de cases', { exact: true }).click();
  await page.keyboard.type('Appeler le client');
  await page.locator('ul[data-type="taskList"][data-checklist="true"] input[type="checkbox"]').first().check();
  const item = page.locator('ul[data-checklist="true"] li[data-checked="true"] > div').first();
  await expect(item).toContainText('Appeler le client');
  expect(await decoration(item)).toBe('none');

  // Liste de tâches ordinaire dans la même page : le texte coché reste barré.
  // (un paragraphe sépare les deux listes : deux listes voisines de même type fusionnent.)
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Suite');
  await page.keyboard.press('Enter');
  await page.keyboard.type('/tâches');
  await page.locator('.slash-menu').getByText('Liste de tâches', { exact: true }).click();
  await page.keyboard.type('Envoyer la facture');
  await page.locator('ul[data-type="taskList"]:not([data-checklist]) input[type="checkbox"]').first().check();
  const struck = page.locator('ul[data-type="taskList"]:not([data-checklist]) li[data-checked="true"] > div').first();
  await expect(struck).toContainText('Envoyer la facture');
  expect(await decoration(struck)).toBe('line-through');

  // L'attribut est enregistré dans la page et survit au rechargement.
  await expect.poll(async () => {
    const admin = await adminContext(browser);
    const p = await (await api(admin.request, 'GET', `/pages/${id}`)).json();
    await admin.close();
    return JSON.stringify(p.content).includes('"checklist":true');
  }, { timeout: 15_000 }).toBe(true);
  await page.reload();
  await expect(page.locator('ul[data-type="taskList"][data-checklist="true"]')).toHaveCount(1);
});
