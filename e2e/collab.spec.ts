import { expect, test } from '@playwright/test';
import { adminContext, api, createLocalUser, PASSWORD, sessionContext } from './helpers';

test('deux personnes éditent la même page en temps réel', async ({ browser }) => {
  const admin = await adminContext(browser);
  await createLocalUser(admin.request, 'co.editor@e2e.test', 'Co-éditeur', 'editor');
  const pages = ((await (await api(admin.request, 'GET', '/pages?limit=200')).json()) as { items: { id: string; title: string }[] }).items;
  const target = pages.find((p) => p.title === 'Guide de l’éditeur')!;

  const other = await sessionContext(browser, 'co.editor@e2e.test', PASSWORD);
  const a = await admin.newPage();
  const b = await other.newPage();
  await a.goto(`/#/p/${target.id}`);
  await b.goto(`/#/p/${target.id}`);
  const editorA = a.locator('.ProseMirror[contenteditable="true"]');
  const editorB = b.locator('.ProseMirror[contenteditable="true"]');
  await expect(editorA).toBeVisible();
  await expect(editorB).toBeVisible();

  await editorA.click();
  await a.keyboard.press('Control+End');
  await a.keyboard.type(' ECRIT-PAR-A');
  await expect(editorB).toContainText('ECRIT-PAR-A', { timeout: 10_000 });

  await editorB.click();
  await b.keyboard.press('Control+End');
  await b.keyboard.type(' ECRIT-PAR-B');
  await expect(editorA).toContainText('ECRIT-PAR-B', { timeout: 10_000 });

  // Persisté côté serveur (synchronisé toutes les 2 s) : un rechargement garde les deux textes.
  await a.waitForTimeout(2500);
  await a.reload();
  await expect(a.locator('.ProseMirror')).toContainText('ECRIT-PAR-A');
  await expect(a.locator('.ProseMirror')).toContainText('ECRIT-PAR-B');
  await Promise.all([admin.close(), other.close()]);
});

test('le texte d’un bloc de code se partage en temps réel', async ({ browser }) => {
  const admin = await adminContext(browser);
  await createLocalUser(admin.request, 'code.editor@e2e.test', 'Code', 'editor');
  const pages = ((await (await api(admin.request, 'GET', '/pages?limit=200')).json()) as { items: { id: string; title: string }[] }).items;
  const target = pages.find((p) => p.title === 'Guide de l’éditeur')!;
  const other = await sessionContext(browser, 'code.editor@e2e.test', PASSWORD);
  const a = await admin.newPage();
  const b = await other.newPage();
  await a.goto(`/#/p/${target.id}`);
  await b.goto(`/#/p/${target.id}`);
  const editorA = a.locator('.ProseMirror[contenteditable="true"]').first();
  await expect(editorA).toBeVisible();
  await expect(b.locator('.ProseMirror[contenteditable="true"]').first()).toBeVisible();

  await editorA.locator('p').last().click();
  await a.keyboard.press('End');
  await a.keyboard.press('Enter');
  await a.keyboard.type('```sh ');
  await a.keyboard.type('echo bonjour');
  await expect(b.locator('.code-block .cm-content').last()).toContainText('echo bonjour', { timeout: 10_000 });

  // B tape dans le bloc de code ; A voit le texte arriver dans le sien.
  await b.locator('.code-block .cm-content').last().click();
  await b.keyboard.press('End');
  await b.keyboard.type(' depuis-B');
  await expect(a.locator('.code-block .cm-content').last()).toContainText('echo bonjour depuis-B', { timeout: 10_000 });

  // A et B écrivent en même temps à deux endroits : aucun texte ne se perd.
  await a.locator('.code-block .cm-content').last().click();
  await a.keyboard.press('Home');
  await a.keyboard.type('A1 ');
  await b.keyboard.press('End');
  await b.keyboard.type(' B2');
  await expect(a.locator('.code-block .cm-content').last()).toContainText('A1 echo bonjour depuis-B B2', { timeout: 10_000 });
  await expect(b.locator('.code-block .cm-content').last()).toContainText('A1 echo bonjour depuis-B B2', { timeout: 10_000 });
  await Promise.all([admin.close(), other.close()]);
});
