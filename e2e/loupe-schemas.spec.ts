// Loupe des schémas : ouverture depuis le bouton « Agrandir », zoom (boutons, clavier, Ctrl + molette, pincement),
// déplacement (glisser, flèches), réinitialisation, Échap et retour du focus. La copie est une image, sans script.
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { adminContext, api, createLocalUser, PASSWORD, sessionContext } from './helpers';

async function mermaidPage(request: APIRequestContext, title: string) {
  const spaces = (await (await api(request, 'GET', '/spaces')).json()) as { id: string; visibility: string }[];
  const res = await api(request, 'POST', '/pages', {
    spaceId: spaces.find((s) => s.visibility === 'public')!.id, title,
    content: { type: 'doc', content: [{ type: 'mermaid', attrs: { code: 'flowchart LR\n  A[Début du chantier] --> B{Validé ?}\n  B -->|oui| C[Fin]' } }] },
  });
  expect(res.ok()).toBeTruthy();
  return ((await res.json()) as { id: string }).id;
}

const transform = (page: Page) => page.locator('.zoom-img').evaluate((el) => (el as HTMLElement).style.transform);
const width = (page: Page) => page.locator('.zoom-img').evaluate((el) => (el as HTMLElement).getBoundingClientRect().width);

test('loupe : zoom, déplacement, réinitialisation, Échap et retour du focus', async ({ browser }) => {
  const ctx = await adminContext(browser);
  const id = await mermaidPage(ctx.request, 'Schéma à agrandir');
  const page = await ctx.newPage();
  await page.goto(`/p/${id}`);
  await page.locator('.mermaid-preview svg').waitFor();
  const open = page.getByRole('button', { name: 'Agrandir le schéma Mermaid' });
  await open.click();

  const dialog = page.getByRole('dialog', { name: 'Schéma Mermaid agrandi' });
  await expect(dialog).toBeVisible();
  const img = dialog.getByRole('img', { name: 'Schéma Mermaid agrandi' });
  await expect(img).toHaveAttribute('src', /^data:image\/svg\+xml;base64,/);
  // Une copie en image : aucun SVG en ligne ni script dans la fenêtre.
  await expect(dialog.locator('svg:not(.ico svg)')).toHaveCount(0);
  await expect(dialog.locator('script')).toHaveCount(0);
  const stage = dialog.getByRole('region', { name: /Schéma Mermaid agrandi/ });
  await expect(stage).toBeFocused();
  const level = dialog.locator('.zoom-level');
  await expect(level).toHaveText('100 %');
  const w0 = await width(page);
  const t0 = await transform(page);

  await dialog.getByRole('button', { name: 'Zoom avant' }).click();
  await expect(level).toHaveText('125 %');
  expect(await width(page)).toBeGreaterThan(w0);
  await dialog.getByRole('button', { name: 'Zoom arrière' }).click();
  await expect(level).toHaveText('100 %');

  // Clavier : + et -, flèches pour déplacer, 0 pour revenir.
  await stage.focus();
  await page.keyboard.press('+');
  await expect(level).toHaveText('125 %');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  expect(await transform(page)).not.toBe(t0);
  await page.keyboard.press('0');
  await expect(level).toHaveText('100 %');
  expect(await transform(page)).toBe(t0);

  // Ctrl + molette : zoom ; glisser à la souris : déplacement.
  const box = (await stage.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -300);
  await page.keyboard.up('Control');
  await expect.poll(async () => parseInt(await level.textContent() ?? '0', 10)).toBeGreaterThan(100);
  const before = await transform(page);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 40, { steps: 4 });
  await page.mouse.up();
  expect(await transform(page)).not.toBe(before);
  await dialog.getByRole('button', { name: 'Réinitialiser' }).click();
  await expect(level).toHaveText('100 %');
  expect(await transform(page)).toBe(t0);

  // Pincement (deux pointeurs tactiles) : le zoom augmente quand les doigts s'écartent.
  await stage.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const ev = (type: string, id: number, x: number) => el.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: r.left + x, clientY: r.top + 100, bubbles: true }));
    ev('pointerdown', 11, 100);
    ev('pointerdown', 12, 200);
    ev('pointermove', 12, 300);
    ev('pointerup', 12, 300);
    ev('pointerup', 11, 100);
  });
  await expect.poll(async () => parseInt(await level.textContent() ?? '0', 10)).toBeGreaterThan(150);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(open).toBeFocused();

  // Bouton « Fermer » de la fenêtre.
  await open.click();
  await dialog.getByRole('button', { name: 'Fermer' }).click();
  await expect(dialog).toBeHidden();
  await expect(open).toBeFocused();
  await ctx.close();
});

test('loupe : disponible pour un lecteur, et sur téléphone sans débordement', async ({ browser }) => {
  const admin = await adminContext(browser);
  const id = await mermaidPage(admin.request, 'Schéma pour lecteur');
  await createLocalUser(admin.request, 'loupe.lecteur@e2e.test', 'Lecteur loupe', 'reader');
  await admin.close();
  const reader = await sessionContext(browser, 'loupe.lecteur@e2e.test', PASSWORD);
  const page = await reader.newPage();
  await page.setViewportSize({ width: 375, height: 740 });
  await page.goto(`/p/${id}`);
  await page.locator('.mermaid-preview svg').waitFor();
  await expect(page.locator('.diagram-edit')).toBeHidden();
  await page.getByRole('button', { name: 'Agrandir le schéma Mermaid' }).click();
  const dialog = page.getByRole('dialog', { name: 'Schéma Mermaid agrandi' });
  await expect(dialog).toBeVisible();
  const box = (await dialog.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(375);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
  for (const name of ['Zoom avant', 'Zoom arrière', 'Réinitialiser', 'Fermer']) await expect(dialog.getByRole('button', { name })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await reader.close();
});
