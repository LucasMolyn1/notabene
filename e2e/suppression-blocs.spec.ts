// Les blocs conteneurs (isolants) se suppriment au clavier : bloc vide d'emblée, bloc avec texte en deux frappes.
import { expect, test, type Browser, type Page } from '@playwright/test';
import { ADMIN } from './accounts';
import { adminContext, api, loginUi } from './helpers';

async function newPage(browser: Browser, title: string) {
  const admin = await adminContext(browser);
  const spaces = (await (await api(admin.request, 'GET', '/spaces')).json()) as { id: string; visibility: string }[];
  const res = await api(admin.request, 'POST', '/pages', { spaceId: spaces.find((s) => s.visibility === 'public')!.id, title });
  const created = await res.json();
  await admin.close();
  return created.id as string;
}
const editor = (page: Page) => page.getByRole('textbox', { name: 'Contenu de la page' });

test('un bloc synchronisé vide se supprime avec Retour arrière', async ({ page, browser }) => {
  const id = await newPage(browser, 'Suppression bloc synchronisé vide');
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto(`/p/${id}`);
  await editor(page).click();
  await page.keyboard.type('/synchronise');
  await page.keyboard.press('Enter');
  await expect(page.locator('.synced-source')).toHaveCount(1);
  await page.keyboard.press('Backspace');
  await expect(page.locator('.synced-source')).toHaveCount(0);
});

test('un bloc synchronisé avec texte : une frappe le sélectionne, la suivante le supprime', async ({ page, browser }) => {
  const id = await newPage(browser, 'Suppression bloc synchronisé texte');
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto(`/p/${id}`);
  await editor(page).click();
  await page.keyboard.type('/synchronise');
  await page.keyboard.press('Enter');
  await page.keyboard.type('abc');
  for (let i = 0; i < 3; i++) await page.keyboard.press('Backspace');
  await expect(page.locator('.synced-source')).toHaveCount(1);
  await page.keyboard.press('Backspace');
  await expect(page.locator('.synced-source')).toHaveCount(0);
});

test('un bloc dépliable se supprime au clavier', async ({ page, browser }) => {
  const id = await newPage(browser, 'Suppression bloc dépliable');
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto(`/p/${id}`);
  await editor(page).click();
  await page.keyboard.type('/depliable');
  await page.keyboard.press('Enter');
  await expect(page.locator('.details')).toHaveCount(1);
  // Titre sélectionné : un premier Retour arrière l'efface, le second supprime le bloc entièrement vide.
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await expect(page.locator('.details')).toHaveCount(0);
});
