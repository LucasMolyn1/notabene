// Blocs synchronisés : une source éditée dans sa page, des copies en lecture seule ailleurs, un bloc neutre sans accès.
import { randomBytes } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { ADMIN } from './accounts';
import { adminContext, api, createLocalUser, loginUi, PASSWORD, sessionContext } from './helpers';

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
// Même format que le client et le serveur : 16 octets aléatoires en base64url sans remplissage.
const randomId = () => randomBytes(16).toString('base64url');

async function newPage(browser: Browser, title: string, content?: object) {
  const admin = await adminContext(browser);
  const spaces = (await (await api(admin.request, 'GET', '/spaces')).json()) as { id: string; visibility: string }[];
  const res = await api(admin.request, 'POST', '/pages', { spaceId: spaces.find((s) => s.visibility === 'public')!.id, title, ...(content ? { content } : {}) });
  expect(res.ok(), `création de ${title}`).toBeTruthy();
  const created = await res.json();
  await admin.close();
  return created.id as string;
}

async function storedContent(browser: Browser, id: string) {
  const admin = await adminContext(browser);
  const page = await (await api(admin.request, 'GET', `/pages/${id}`)).json();
  await admin.close();
  return JSON.stringify(page.content);
}

const blockIds = (json: string, type: string) => [...json.matchAll(new RegExp(`"type":"${type}","attrs":\\{"blockId":"([A-Za-z0-9_-]+)"`, 'g'))].map((m) => m[1]);

// Page avec une source, page avec sa copie : préparées par l'API. À la création, le serveur donne un nouvel identifiant à chaque
// source : on relit celui qu'il a retenu.
async function sourceAndCopy(browser: Browser, label: string, text: string) {
  const sourceId = await newPage(browser, `Source ${label}`, { type: 'doc', content: [{ type: 'syncedSource', attrs: { blockId: randomId() }, content: [para(text)] }, { type: 'paragraph' }] });
  const [blockId] = blockIds(await storedContent(browser, sourceId), 'syncedSource');
  expect(blockId).toBeTruthy();
  const copyId = await newPage(browser, `Copie ${label}`, { type: 'doc', content: [para('Avant la copie'), { type: 'syncedCopy', attrs: { blockId } }, para('Après la copie')] });
  return { blockId, sourceId, copyId };
}

const pageEditor = (page: Page) => page.getByRole('textbox', { name: 'Contenu de la page' });

test('créer une source, l’afficher dans une autre page, la copie suit la source', async ({ page, browser }) => {
  const a = await newPage(browser, 'Page source e2e');
  const b = await newPage(browser, 'Page copie e2e');
  await loginUi(page, ADMIN.email, ADMIN.password);

  await page.goto(`/p/${a}`);
  await pageEditor(page).click();
  await page.keyboard.type('/synchronise');
  await expect(page.locator('.slash-item.active')).toContainText('Bloc synchronisé');
  await page.keyboard.press('Enter');
  await expect(page.locator('.synced-source')).toHaveCount(1);
  await page.keyboard.type('Texte partagé v1');
  await expect(page.locator('.synced-source .synced-body')).toContainText('Texte partagé v1');
  // Pas de bloc synchronisé dans un bloc synchronisé : le menu ne le propose pas.
  await page.keyboard.press('Enter');
  await page.keyboard.type('/synchronise');
  await expect(page.locator('.slash-menu')).toBeHidden();
  await page.keyboard.press('Backspace');
  for (let i = 0; i < '/synchronise'.length; i++) await page.keyboard.press('Backspace');

  await page.getByRole('button', { name: /Copier le lien du bloc synchronisé/ }).click();
  await expect.poll(async () => storedContent(browser, a), { timeout: 15_000 }).toContain('Texte partagé v1');
  const [sourceBlock] = blockIds(await storedContent(browser, a), 'syncedSource');
  expect(sourceBlock).toMatch(/^[A-Za-z0-9_-]{21}[AQgw]$/);

  await page.goto(`/p/${b}`);
  await pageEditor(page).click();
  await page.keyboard.type('/copie');
  await expect(page.locator('.slash-item.active')).toContainText('Copie d’un bloc synchronisé');
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Copie d’un bloc synchronisé' });
  await expect(dialog.getByLabel('Lien du bloc')).toHaveValue(sourceBlock!);
  await dialog.getByRole('button', { name: 'Insérer' }).click();
  const copy = page.getByRole('group', { name: /Copie d’un bloc synchronisé/ });
  await expect(copy).toContainText('Texte partagé v1');
  // Lecture seule : rien d'éditable dans la copie.
  await expect(copy.locator('[contenteditable="true"]')).toHaveCount(0);
  await expect.poll(async () => storedContent(browser, b), { timeout: 15_000 }).toContain('"type":"syncedCopy"');
  expect(blockIds(await storedContent(browser, b), 'syncedCopy')).toEqual([sourceBlock]);
  // La copie n'enregistre que l'identifiant : pas le contenu de la source.
  expect(await storedContent(browser, b)).not.toContain('Texte partagé');

  // La source change : la copie suit.
  await page.goto(`/p/${a}`);
  await page.locator('.synced-source .synced-body p').first().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' puis v2');
  await expect.poll(async () => storedContent(browser, a), { timeout: 15_000 }).toContain('puis v2');
  await page.goto(`/p/${b}`);
  await expect(async () => {
    await page.reload();
    await expect(page.getByRole('group', { name: /Copie d’un bloc synchronisé/ })).toContainText('Texte partagé v1 puis v2', { timeout: 3000 });
  }).toPass({ timeout: 20_000 });
  // Aucun lien vers la page source n'est affiché.
  await expect(page.getByRole('link', { name: /source/i })).toHaveCount(0);
});

test('copier-coller : une source collée change d’identifiant, une copie collée garde le sien', async ({ page, browser }) => {
  const { blockId, sourceId, copyId } = await sourceAndCopy(browser, 'collage e2e', 'Contenu à coller');
  const target = await newPage(browser, 'Cible du collage e2e');
  await loginUi(page, ADMIN.email, ADMIN.password);

  await page.goto(`/p/${sourceId}`);
  await expect(page.locator('.synced-source')).toContainText('Contenu à coller');
  await pageEditor(page).click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('ControlOrMeta+c');
  await page.goto(`/p/${target}`);
  await pageEditor(page).click();
  await page.keyboard.press('ControlOrMeta+v');
  await expect(page.locator('.synced-source')).toContainText('Contenu à coller');

  await page.goto(`/p/${copyId}`);
  await expect(page.locator('.synced-copy')).toContainText('Contenu à coller');
  await pageEditor(page).click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('ControlOrMeta+c');
  await page.goto(`/p/${target}`);
  await page.locator('.prose > p').last().click();
  await page.keyboard.press('ControlOrMeta+v');
  await expect(page.locator('.synced-copy')).toHaveCount(1);

  await expect.poll(async () => storedContent(browser, target), { timeout: 15_000 }).toContain('"type":"syncedCopy"');
  const stored = await storedContent(browser, target);
  const sources = blockIds(stored, 'syncedSource');
  expect(sources).toHaveLength(1);
  expect(sources[0]).not.toBe(blockId);
  expect(blockIds(stored, 'syncedCopy')).toEqual([blockId]);
});

test('un lecteur voit la copie sans pouvoir la modifier', async ({ browser }) => {
  const { copyId, sourceId } = await sourceAndCopy(browser, 'lecteur e2e', 'Visible par la lectrice');
  const admin = await adminContext(browser);
  await createLocalUser(admin.request, 'synced.reader@e2e.test', 'Lectrice blocs', 'reader');
  await admin.close();
  const ctx = await sessionContext(browser, 'synced.reader@e2e.test', PASSWORD);
  const page = await ctx.newPage();
  await page.goto(`/p/${copyId}`);
  await expect(page.getByRole('group', { name: /Copie d’un bloc synchronisé/ })).toContainText('Visible par la lectrice');
  await expect(pageEditor(page)).toHaveAttribute('contenteditable', 'false');
  await expect(page.locator('.synced-copy [contenteditable="true"]')).toHaveCount(0);
  // Dans la page source, ni édition ni bouton de copie pour un compte en lecture.
  await page.goto(`/p/${sourceId}`);
  await expect(page.locator('.synced-source')).toContainText('Visible par la lectrice');
  await expect(pageEditor(page)).toHaveAttribute('contenteditable', 'false');
  await expect(page.getByRole('button', { name: /Copier le lien du bloc/ })).toHaveCount(0);
  await ctx.close();
});

test('une source illisible et une source inexistante donnent le même bloc neutre', async ({ browser }) => {
  const { blockId, sourceId } = await sourceAndCopy(browser, 'secrète e2e', 'Contenu confidentiel');
  const host = await newPage(browser, 'Copies neutres e2e', {
    type: 'doc',
    content: [{ type: 'syncedCopy', attrs: { blockId } }, para('entre les deux'), { type: 'syncedCopy', attrs: { blockId: randomId() } }],
  });
  const admin = await adminContext(browser);
  await createLocalUser(admin.request, 'synced.other@e2e.test', 'Autre blocs', 'editor');
  const me = await (await admin.request.get('/api/v3/me')).json();
  expect((await api(admin.request, 'PUT', `/pages/${sourceId}/permissions`, { entries: [{ userId: me.user?.id ?? me.id, level: 'write' }] })).ok()).toBeTruthy();
  await admin.close();

  const ctx = await sessionContext(browser, 'synced.other@e2e.test', PASSWORD);
  const page = await ctx.newPage();
  await page.goto(`/p/${host}`);
  const copies = page.locator('.synced-copy');
  await expect(copies).toHaveCount(2);
  await expect(copies.nth(0).locator('.synced-body')).toHaveText('Contenu indisponible');
  await expect(copies.nth(1).locator('.synced-body')).toHaveText('Contenu indisponible');
  await expect(page.getByText('Contenu confidentiel')).toHaveCount(0);
  await expect(page.getByText('Source secrète e2e')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Réessayer' })).toHaveCount(0);
  await ctx.close();
});

test('largeur téléphone : la copie tient dans 375 px', async ({ page, browser }) => {
  const { copyId } = await sourceAndCopy(browser, 'téléphone e2e', 'Un texte assez long pour passer à la ligne sur un téléphone, sans faire défiler la page de côté.');
  await page.setViewportSize({ width: 375, height: 800 });
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto(`/p/${copyId}`);
  const copy = page.locator('.synced-copy');
  await expect(copy).toContainText('Un texte assez long');
  const box = await copy.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(375);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
});

for (const scheme of ['light', 'dark'] as const) {
  test(`accessibilité : page avec source et copie (thème ${scheme})`, async ({ page, browser }) => {
    // Source et copies dans la même page : le serveur renomme la source à la création, la copie est donc ajoutée ensuite.
    const id = await newPage(browser, `Source et copie a11y ${scheme}`, {
      type: 'doc', content: [{ type: 'syncedSource', attrs: { blockId: randomId() }, content: [para('Contenu partagé')] }, para('entre')],
    });
    const stored = JSON.parse(await storedContent(browser, id)) as { content: object[] };
    const [blockId] = blockIds(JSON.stringify(stored), 'syncedSource');
    const admin = await adminContext(browser);
    const current = await api(admin.request, 'GET', `/pages/${id}`);
    const put = await admin.request.patch(`/api/v3/pages/${id}`, {
      data: { content: { type: 'doc', content: [...stored.content, { type: 'syncedCopy', attrs: { blockId } }, { type: 'syncedCopy', attrs: { blockId: randomId() } }] } },
      headers: { 'If-Match': current.headers().etag!, 'X-CSRF-Token': (await (await admin.request.get('/api/v3/me')).json()).csrf },
    });
    expect(put.ok()).toBeTruthy();
    await admin.close();
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await loginUi(page, ADMIN.email, ADMIN.password);
    await page.goto(`/p/${id}`);
    await expect(page.locator('.synced-copy').first()).toContainText('Contenu partagé');
    await expect(page.locator('.synced-copy').nth(1)).toContainText('Contenu indisponible');
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(result.violations.map((v) => `${v.id} (${v.impact}) | ${v.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(' ; ')}`)).toEqual([]);
  });
}

test('lien public : la copie montre la source publique, rien d’une source restreinte', async ({ browser }) => {
  const open = await sourceAndCopy(browser, 'publique e2e', 'Texte public synchronisé');
  const secret = await sourceAndCopy(browser, 'restreinte e2e', 'Texte restreint synchronisé');
  const host = await newPage(browser, 'Partage avec copies e2e', {
    type: 'doc', content: [{ type: 'syncedCopy', attrs: { blockId: open.blockId } }, para('entre'), { type: 'syncedCopy', attrs: { blockId: secret.blockId } }],
  });
  const admin = await adminContext(browser);
  const me = await (await admin.request.get('/api/v3/me')).json();
  expect((await api(admin.request, 'PUT', `/pages/${secret.sourceId}/permissions`, { entries: [{ userId: me.user?.id ?? me.id, level: 'write' }] })).ok()).toBeTruthy();
  expect((await api(admin.request, 'PUT', '/admin/sharing', { enabled: true })).ok()).toBeTruthy();
  try {
    const share = await (await api(admin.request, 'PUT', `/pages/${host}/share`, {})).json();
    const visitor = await browser.newContext({ baseURL: 'http://localhost:3100' });
    const tab = await visitor.newPage();
    await tab.goto(new URL(share.url).pathname);
    // Le serveur remplace chaque copie par le contenu lisible sans compte, ou par un bloc neutre.
    await expect(tab.getByText('Texte public synchronisé')).toBeVisible();
    await expect(tab.getByText('entre', { exact: true })).toBeVisible();
    await expect(tab.getByText('Texte restreint synchronisé')).toHaveCount(0);
    await visitor.close();
  } finally {
    await api(admin.request, 'PUT', '/admin/sharing', { enabled: false });
    await admin.close();
  }
});
