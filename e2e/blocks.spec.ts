import { expect, test, type Browser } from '@playwright/test';
import { ADMIN } from './accounts';
import { adminContext, api, loginUi } from './helpers';

async function newPage(browser: Browser, title: string, content?: object) {
  const admin = await adminContext(browser);
  const spaces = (await (await api(admin.request, 'GET', '/spaces')).json()) as { id: string; visibility: string }[];
  const created = await (await api(admin.request, 'POST', '/pages', { spaceId: spaces.find((s) => s.visibility === 'public')!.id, title, ...(content ? { content } : {}) })).json();
  await admin.close();
  return created.id as string;
}

async function storedContent(browser: Browser, id: string) {
  const admin = await adminContext(browser);
  const page = await (await api(admin.request, 'GET', `/pages/${id}`)).json();
  await admin.close();
  return JSON.stringify(page.content);
}

test('insérer un bloc dépliable, des colonnes et une formule avec le menu /', async ({ page, browser }) => {
  const id = await newPage(browser, 'Blocs e2e');
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto(`/p/${id}`);
  const editor = page.locator('.prose');
  await editor.click();

  await page.keyboard.type('/dépliable');
  await page.keyboard.press('Enter');
  await expect(page.locator('.details')).toHaveCount(1);
  await expect(page.locator('.details')).toHaveClass(/open/);
  await page.keyboard.type('Mon titre');
  await expect(page.locator('.details-summary')).toHaveText('Mon titre');
  // Replier masque le contenu, déplier le montre.
  await page.getByRole('button', { name: 'Replier le bloc' }).click();
  await expect(page.locator('.details-content')).toBeHidden();
  await page.getByRole('button', { name: 'Déplier le bloc' }).click();
  await expect(page.locator('.details-content')).toBeVisible();

  await page.locator('.prose > p').last().click();
  await page.keyboard.type('/colonnes');
  await page.keyboard.press('Enter');
  await expect(page.locator('.columns .column')).toHaveCount(2);

  await page.locator('.prose > p').last().click();
  await page.keyboard.type('/formule');
  await page.keyboard.press('Enter');
  await expect(page.locator('.math-preview .katex')).toBeVisible();

  // Enregistré dans la page : types et attributs seuls, aucun style.
  await expect.poll(async () => storedContent(browser, id), { timeout: 15_000 }).toContain('"type":"math"');
  const stored = await storedContent(browser, id);
  expect(stored).toContain('"type":"details"');
  expect(stored).toContain('"type":"columns"');
  expect(stored).not.toContain('style');
});

test('une formule invalide affiche l’erreur sans casser la page', async ({ page, browser }) => {
  const id = await newPage(browser, 'Formule invalide e2e', { type: 'doc', content: [{ type: 'math', attrs: { code: '\\frac{1' } }, { type: 'math', attrs: { code: '\\href{javascript:alert(1)}{x}' } }, { type: 'paragraph', content: [{ type: 'text', text: 'fin' }] }] });
  await loginUi(page, ADMIN.email, ADMIN.password);
  const dialogs: string[] = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); void d.dismiss(); });
  await page.goto(`/p/${id}`);
  // Une formule invalide montre l'erreur ; une commande de lien est affichée comme du texte, sans lien.
  await expect(page.locator('.math-preview.error')).toHaveCount(1);
  await expect(page.locator('.math-preview')).toHaveCount(2);
  await expect(page.locator('.prose').getByText('fin')).toBeVisible();
  await expect(page.locator('.math-preview a')).toHaveCount(0);
  expect(dialogs).toEqual([]);
});

test('couleur du texte, fond et alignement depuis la barre flottante', async ({ page, browser }) => {
  const id = await newPage(browser, 'Couleurs e2e', { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Un texte à colorer' }] }] });
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto(`/p/${id}`);
  await page.locator('.prose p').first().selectText();
  await page.getByRole('button', { name: 'Couleurs et alignement' }).click();
  await page.getByRole('button', { name: 'Texte rouge' }).click();
  await expect(page.locator('[data-text-color][data-color="red"]')).toHaveText('Un texte à colorer');

  await page.locator('.prose p').first().selectText();
  await page.getByRole('button', { name: 'Couleurs et alignement' }).click();
  await page.getByRole('button', { name: 'Fond bleu' }).click();
  await expect(page.locator('mark[data-color="blue"]')).toHaveText('Un texte à colorer');

  await page.locator('.prose p').first().selectText();
  await page.getByRole('button', { name: 'Couleurs et alignement' }).click();
  await page.getByRole('button', { name: 'Centre', exact: true }).click();
  await expect(page.locator('.prose p[data-align="center"]')).toHaveCount(1);

  await expect.poll(async () => storedContent(browser, id), { timeout: 15_000 }).toContain('"align":"center"');
  const stored = await storedContent(browser, id);
  expect(stored).toContain('"type":"textColor","attrs":{"color":"red"}');
  expect(stored).toContain('"color":"blue"');
  expect(stored).not.toContain('style');
});

test('le serveur refuse une couleur ou un bloc mal formé envoyé par l’API', async ({ browser }) => {
  const id = await newPage(browser, 'Refus e2e');
  const admin = await adminContext(browser);
  const etag = (await api(admin.request, 'GET', `/pages/${id}`)).headers().etag;
  const me = await (await admin.request.get('/api/v3/me')).json();
  const patch = (content: object) => admin.request.fetch(`/api/v3/pages/${id}`, { method: 'PATCH', headers: { 'x-csrf-token': me.csrf, 'if-match': etag }, data: { content } });
  expect((await patch({ type: 'doc', content: [{ type: 'details', content: [] }] })).status()).toBe(400);
  expect((await patch({ type: 'doc', content: [{ type: 'columns', content: [{ type: 'column', content: [{ type: 'paragraph' }] }] }] })).status()).toBe(400);
  const stored = await patch({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'textColor', attrs: { color: 'red;background:url(//x)' } }] }] }] });
  expect(stored.ok()).toBeTruthy();
  expect(JSON.stringify((await stored.json()).content ?? '')).not.toContain('url(');
  await admin.close();
});
