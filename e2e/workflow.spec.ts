// Bloc « Workflow » : insertion par « / », ajout de nœuds, liens, libellés, clavier, suppression, annuler, persistance,
// lecture seule, Vue texte, largeur téléphone et audit axe (clair et sombre).
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { ADMIN } from './accounts';
import { adminContext, api, createLocalUser, loginUi, PASSWORD, sessionContext } from './helpers';

const GRAPH = JSON.stringify({
  v: 1,
  nodes: [
    { id: 'a1', kind: 'start', label: 'Demande reçue', x: 40, y: 80, color: null },
    { id: 'a2', kind: 'decision', label: 'Validée ?', x: 260, y: 80, color: null },
    { id: 'a3', kind: 'step', label: 'Documenter', x: 500, y: 20, color: null },
    { id: 'a4', kind: 'end', label: 'Archiver', x: 500, y: 160, color: 'green' },
  ],
  edges: [
    { id: 'b1', from: 'a1', port: 'out', to: 'a2', label: null },
    { id: 'b2', from: 'a2', port: 'yes', to: 'a3', label: null },
    { id: 'b3', from: 'a2', port: 'no', to: 'a4', label: null },
  ],
});

async function newPage(request: APIRequestContext, title: string, graph?: string) {
  const spaces = (await (await api(request, 'GET', '/spaces')).json()) as { id: string; visibility: string }[];
  const res = await api(request, 'POST', '/pages', {
    spaceId: spaces.find((s) => s.visibility === 'public')!.id, title,
    ...(graph ? { content: { type: 'doc', content: [{ type: 'workflow', attrs: { graph } }] } } : {}),
  });
  expect(res.ok()).toBeTruthy();
  return ((await res.json()) as { id: string }).id;
}
async function adminPage(browser: Browser, title: string, graph?: string) {
  const ctx = await adminContext(browser);
  const id = await newPage(ctx.request, title, graph);
  await ctx.close();
  return id;
}
const node = (page: Page, label: string) => page.locator('.wf-node').filter({ hasText: label }).first();
const left = (page: Page, label: string) => node(page, label).evaluate((el) => (el as HTMLElement).style.left);

test('insérer, ajouter, relier, renommer, déplacer, supprimer, annuler, recharger', async ({ page, browser }) => {
  const id = await adminPage(browser, 'Workflow complet');
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto(`/p/${id}`);
  await page.getByRole('textbox', { name: 'Contenu de la page' }).click();
  await page.keyboard.type('/workflow');
  await page.keyboard.press('Enter');
  await expect(page.locator('.wf-node')).toHaveCount(3);
  await expect(page.locator('.wf-edge')).toHaveCount(2);

  // Ajouter une décision, la renommer au clavier.
  await page.getByRole('button', { name: 'Ajouter Décision' }).click();
  await expect(page.locator('.wf-node')).toHaveCount(4);
  const decision = page.getByRole('group', { name: /^Décision : / });
  await expect(decision).toBeFocused();
  await page.keyboard.press('Enter');
  await page.getByRole('textbox', { name: 'Libellé : Décision' }).fill('Validée ?');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('group', { name: 'Décision : Validée ?' })).toBeFocused();

  // Relier par le menu « Relier à… » (touche L) : sortie Oui vers Fin.
  await page.keyboard.press('l');
  await page.getByRole('menuitem', { name: 'Oui vers Fin : Fin' }).click();
  await expect(page.locator('.wf-edge')).toHaveCount(3);
  await expect(page.locator('.wf-chip', { hasText: 'Oui' })).toHaveCount(1);

  // Déplacer au clavier (20 px), puis annuler par l'historique.
  // L'historique regroupe les modifications rapprochées (moins d'une demi-seconde) : on laisse passer ce délai.
  await page.waitForTimeout(700);
  const step = page.getByRole('group', { name: 'Étape : Étape' });
  await step.focus();
  const x0 = await left(page, 'Étape');
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => left(page, 'Étape')).toBe(`${parseInt(x0, 10) + 20}px`);
  await page.waitForTimeout(700); // un autre cran d'historique que l'ajout précédent
  await page.keyboard.press('Control+z');
  await expect.poll(() => left(page, 'Étape')).toBe(x0);
  await page.keyboard.press('Control+Shift+z');
  await expect.poll(() => left(page, 'Étape')).toBe(`${parseInt(x0, 10) + 20}px`);

  // Persistance : le serveur garde le graphe (renommage compris).
  await expect.poll(async () => {
    const ctx = await adminContext(browser);
    const p = (await (await api(ctx.request, 'GET', `/pages/${id}`)).json()) as { content?: unknown };
    await ctx.close();
    return JSON.stringify(p.content ?? '').includes('Validée');
  }, { timeout: 15_000 }).toBe(true);
  await page.reload();
  await expect(page.locator('.wf-node')).toHaveCount(4);
  await expect(page.getByRole('group', { name: 'Décision : Validée ?' })).toBeVisible();
  await expect(page.locator('.wf-edge')).toHaveCount(3);

  // Suppression : Suppr sur le nœud retire aussi ses liens.
  await page.getByRole('group', { name: 'Décision : Validée ?' }).focus();
  await page.keyboard.press('Delete');
  await expect(page.locator('.wf-node')).toHaveCount(3);
  await expect(page.locator('.wf-edge')).toHaveCount(2);
});

test('lien et libellé : déplacer à la souris, relier par glisser, renommer un lien, supprimer', async ({ page, browser }) => {
  const id = await adminPage(browser, 'Workflow souris', GRAPH);
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto(`/p/${id}`);
  await expect(page.locator('.wf-node')).toHaveCount(4);
  await page.getByRole('button', { name: 'Ajuster à l’écran' }).click();

  // Glisser d'une prise de sortie (Oui) vers un autre nœud : le lien existe déjà, rien ne change ; vers « Archiver » : nouveau lien.
  const port = node(page, 'Validée ?').locator('.wf-port[data-port="yes"]');
  const target = (await node(page, 'Archiver').boundingBox())!;
  const from = (await port.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator('.wf-edge')).toHaveCount(4);

  // Déplacer un nœud à la souris : une seule transaction, position alignée sur la grille de 20 px.
  const before = await left(page, 'Documenter');
  const box = (await node(page, 'Documenter').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 90, box.y + 10, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => parseInt(await left(page, 'Documenter'), 10) % 20).toBe(0);
  expect(await left(page, 'Documenter')).not.toBe(before);

  // Libellé d'un lien : Entrée sur la pastille, saisie, Entrée ; Suppr retire le lien.
  const chip = page.getByRole('button', { name: /Lien de « Validée \? » vers « Documenter »/ });
  await chip.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('textbox', { name: 'Libellé du lien' }).fill('Conforme');
  await page.keyboard.press('Enter');
  await expect(page.locator('.wf-chip', { hasText: 'Conforme' })).toHaveCount(1);
  await page.locator('.wf-chip', { hasText: 'Conforme' }).focus();
  await page.keyboard.press('Delete');
  await expect(page.locator('.wf-edge')).toHaveCount(3);
});

test('lecture seule : aucun contrôle de modification, loupe, Vue texte', async ({ browser }) => {
  const admin = await adminContext(browser);
  const id = await newPage(admin.request, 'Workflow lecture', GRAPH);
  await createLocalUser(admin.request, 'wf-lecteur@e2e.test', 'Lectrice Workflow', 'reader');
  await admin.close();
  const ctx = await sessionContext(browser, 'wf-lecteur@e2e.test', PASSWORD);
  const page = await ctx.newPage();
  await page.goto(`/p/${id}`);
  await expect(page.locator('.wf-node')).toHaveCount(4);
  await expect(page.locator('.wf').getByRole('button', { name: /^Ajouter / })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Supprimer la sélection' })).toHaveCount(0);
  await expect(page.locator('.wf-port')).toHaveCount(0);
  const before = await left(page, 'Documenter');
  await node(page, 'Documenter').focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect(page.locator('.wf-edit')).toHaveCount(0);
  expect(await left(page, 'Documenter')).toBe(before);

  // Vue texte : présente pour les lecteurs d'écran, affichable par le bouton.
  const list = page.getByRole('list', { name: /Vue texte du schéma/ });
  await expect(list.getByRole('listitem')).toHaveCount(4);
  await expect(list).toContainText('Décision : Validée ? Oui vers Documenter, Non vers Archiver');
  await expect(list).toContainText('Début : Demande reçue. Suite vers Validée ?');
  await expect(list).toHaveClass(/sr-only/);
  const toggle = page.getByRole('button', { name: 'Vue texte' });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(list).not.toHaveClass(/sr-only/);

  // Loupe : le schéma est recopié en image (aucun script).
  await page.getByRole('button', { name: 'Agrandir le schéma Workflow' }).click();
  const dialog = page.getByRole('dialog', { name: 'Schéma Workflow agrandi' });
  await expect(dialog.getByRole('img', { name: 'Schéma Workflow agrandi' })).toHaveAttribute('src', /^data:image\/svg\+xml;base64,/);
  await expect(dialog.locator('script')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('libellé hostile : affiché comme du texte, jamais interprété', async ({ browser }) => {
  const hostile = JSON.stringify({ v: 1, nodes: [{ id: 'h1', kind: 'step', label: '<img src=x onerror="window.__wf=1"><b>gras</b>', x: 40, y: 40, color: null }], edges: [] });
  const id = await adminPage(browser, 'Workflow hostile', hostile);
  const ctx = await adminContext(browser);
  const page = await ctx.newPage();
  await page.goto(`/p/${id}`);
  await expect(page.locator('.wf-node')).toHaveCount(1);
  await expect(node(page, '<b>gras</b>')).toBeVisible();
  await expect(page.locator('.wf-node img, .wf-node b')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __wf?: number }).__wf)).toBeUndefined();
});

test.describe('téléphone', () => {
  test.use({ viewport: { width: 375, height: 800 }, hasTouch: true });
  test('largeur 375 px : pas de défilement horizontal, barre d’outils utilisable', async ({ browser }) => {
    const id = await adminPage(browser, 'Workflow téléphone', GRAPH);
    const ctx = await browser.newContext({ baseURL: 'http://localhost:3100', viewport: { width: 375, height: 800 }, hasTouch: true });
    const page = await ctx.newPage();
    await loginUi(page, ADMIN.email, ADMIN.password);
    await page.goto(`/p/${id}`);
    await expect(page.locator('.wf-node')).toHaveCount(4);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(over).toBeLessThanOrEqual(0);
    const wf = (await page.locator('.wf').boundingBox())!;
    expect(wf.x + wf.width).toBeLessThanOrEqual(375);
    await page.getByRole('button', { name: 'Ajouter Étape' }).tap();
    await expect(page.locator('.wf-node')).toHaveCount(5);
    await ctx.close();
  });
});

for (const scheme of ['light', 'dark'] as const) {
  test(`accessibilité (axe), thème ${scheme}`, async ({ browser }) => {
    const id = await adminPage(browser, `Workflow axe ${scheme}`, GRAPH);
    const ctx = await browser.newContext({ baseURL: 'http://localhost:3100', colorScheme: scheme, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await loginUi(page, ADMIN.email, ADMIN.password);
    await page.goto(`/p/${id}`);
    await expect(page.locator('.wf-node')).toHaveCount(4);
    await page.getByRole('button', { name: 'Vue texte' }).click();
    await node(page, 'Documenter').focus();
    const result = await new AxeBuilder({ page }).include('.wf').withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(result.violations.map((v) => `${v.id} | ${v.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(' ; ')}`)).toEqual([]);
    await ctx.close();
  });
}
