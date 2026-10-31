import { createServer, type Server } from 'node:http';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { ADMIN } from './accounts';
import { adminContext, api, createLocalUser, loginUi, PASSWORD, sessionContext } from './helpers';

const PROVIDER_PORT = 3199;
const received: string[] = [];
let provider: Server;

// Faux fournisseur compatible OpenAI : répond toujours « Texte corrigé » et garde ce qu'il a reçu.
test.beforeAll(async () => {
  provider = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      received.push(raw);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Texte ' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'corrigé' } }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((ok) => provider.listen(PROVIDER_PORT, '127.0.0.1', ok));
});

async function setAi(browser: Browser, enabled: boolean) {
  const root = await adminContext(browser);
  await createLocalUser(root.request, 'assist.admin@e2e.test', 'Admin assistant', 'admin');
  await root.close();
  const admin = await sessionContext(browser, 'assist.admin@e2e.test', PASSWORD);
  let res = await api(admin.request, 'PUT', '/admin/ai', {
    enabled, provider: 'openai', baseUrl: `http://127.0.0.1:${PROVIDER_PORT}/v1`, model: 'test-model', apiKey: 'cle-e2e-0001', reauth: { password: PASSWORD },
  });
  for (let i = 0; i < 4 && res.status() === 429; i++) {
    await new Promise((r) => setTimeout(r, 15_000));
    res = await api(admin.request, 'PUT', '/admin/ai', {
      enabled, provider: 'openai', baseUrl: `http://127.0.0.1:${PROVIDER_PORT}/v1`, model: 'test-model', apiKey: 'cle-e2e-0001', reauth: { password: PASSWORD },
    });
  }
  expect(res.ok()).toBeTruthy();
  await admin.close();
}

test.beforeEach(async ({ browser }) => { received.length = 0; await setAi(browser, true); });
test.afterAll(async ({ browser }) => { await setAi(browser, false).catch(() => undefined); await new Promise<void>((ok) => provider.close(() => ok())); });

async function newPage(browser: Browser, title: string, text: string) {
  const admin = await adminContext(browser);
  const spaces = (await (await api(admin.request, 'GET', '/spaces')).json()) as { id: string; visibility: string }[];
  const content = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
  const created = await (await api(admin.request, 'POST', '/pages', { spaceId: spaces.find((s) => s.visibility === 'public')!.id, title, content })).json();
  await admin.close();
  return created.id as string;
}
async function storedContent(browser: Browser, id: string) {
  const admin = await adminContext(browser);
  const page = await (await api(admin.request, 'GET', `/pages/${id}`)).json();
  await admin.close();
  return JSON.stringify(page.content);
}

async function select(page: Page) {
  const editor = page.locator('.prose');
  await editor.click();
  await editor.locator('p').first().selectText();
}

test('assistant de rédaction : aperçu, destinataire annoncé, rien d’écrit avant « Remplacer »', async ({ page, browser }) => {
  const id = await newPage(browser, 'Assistant e2e', 'Ceci est un texte avec des fautes.');
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto(`/p/${id}`);
  await select(page);
  await page.getByRole('button', { name: 'Assistant de rédaction' }).click();

  const dialog = page.getByRole('dialog', { name: 'Assistant de rédaction' });
  await expect(dialog).toContainText(`127.0.0.1:${PROVIDER_PORT}`);
  await expect(dialog).toContainText('Ceci est un texte avec des fautes.');
  await dialog.getByRole('button', { name: 'Corriger' }).click();
  await expect(dialog.getByLabel('Texte proposé')).toHaveText('Texte corrigé');

  // L'aperçu n'a rien changé dans la page.
  expect(await storedContent(browser, id)).not.toContain('Texte corrigé');
  expect(received).toHaveLength(1);
  expect(received[0]).toContain('Ceci est un texte avec des fautes.');
  expect(received[0]).not.toContain('Assistant e2e'); // le titre de la page ne part pas

  await dialog.getByRole('button', { name: 'Remplacer' }).click();
  await expect(page.locator('.prose p').first()).toHaveText('Texte corrigé');
  await expect.poll(async () => storedContent(browser, id), { timeout: 15_000 }).toContain('Texte corrigé');
});

test('assistant de rédaction : « Insérer après » garde le texte d’origine', async ({ page, browser }) => {
  const id = await newPage(browser, 'Assistant e2e après', 'Phrase de départ.');
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto(`/p/${id}`);
  await select(page);
  await page.getByRole('button', { name: 'Assistant de rédaction' }).click();
  const dialog = page.getByRole('dialog', { name: 'Assistant de rédaction' });
  await dialog.getByRole('button', { name: 'Améliorer' }).click();
  await expect(dialog.getByLabel('Texte proposé')).toHaveText('Texte corrigé');
  await dialog.getByRole('button', { name: 'Insérer après' }).click();
  await expect(page.locator('.prose p').nth(0)).toHaveText('Phrase de départ.');
  await expect(page.locator('.prose p').nth(1)).toHaveText('Texte corrigé');
});

test('un lecteur ne voit pas le bouton de l’assistant', async ({ page, browser }) => {
  const id = await newPage(browser, 'Assistant e2e lecteur', 'Texte en lecture.');
  const root = await adminContext(browser);
  await createLocalUser(root.request, 'assist.reader@e2e.test', 'Lecteur', 'reader');
  await root.close();
  await loginUi(page, 'assist.reader@e2e.test', PASSWORD);
  await page.goto(`/p/${id}`);
  await page.locator('.prose p').first().selectText();
  await expect(page.getByRole('button', { name: 'Assistant de rédaction' })).toHaveCount(0);
});

const paste = (page: Page, html: string) => page.evaluate((h) => {
  const dt = new DataTransfer();
  dt.setData('text/html', h);
  dt.setData('text/plain', 'Coucou');
  document.querySelector('.prose')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
}, html);

test('coller du HTML d’un autre site n’y garde aucune mention ; une copie de Notabene la garde', async ({ page, browser }) => {
  const id = await newPage(browser, 'Collage e2e', 'Début.');
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto(`/p/${id}`);
  await page.locator('.prose').click();
  await page.keyboard.press('End');
  await paste(page, '<p>Étranger <span data-mention-id="adminxyz">@quelqu\'un</span></p>');
  await expect(page.locator('.prose')).toContainText('Étranger');
  await expect(page.locator('.prose .mention')).toHaveCount(0);

  await paste(page, '<p data-pm-slice="1 1 []">Copie <span data-mention-id="adminxyz">@quelqu\'un</span></p>');
  await expect(page.locator('.prose')).toContainText('Copie');
  await expect(page.locator('.prose .mention')).toHaveCount(1);
});

test.describe('sur écran tactile', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('la barre de l’éditeur donne accès à la couleur et à l’assistant sur la sélection', async ({ page, browser }) => {
    const id = await newPage(browser, 'Assistant e2e tactile', 'Texte à colorer.');
    await loginUi(page, ADMIN.email, ADMIN.password);
    await page.goto(`/p/${id}`);
    await select(page);
    await page.getByRole('button', { name: /Texte sélectionné/ }).click();
    const sheet = page.getByRole('dialog', { name: 'Texte sélectionné' });
    await expect(sheet.getByRole('button', { name: 'Assistant de rédaction' })).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Commenter' })).toBeVisible();
    await sheet.getByRole('button', { name: 'Texte rouge' }).click();
    await expect.poll(async () => storedContent(browser, id), { timeout: 15_000 }).toContain('"textColor"');
    expect(await storedContent(browser, id)).toContain('"red"');
  });
});
