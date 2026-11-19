import { deflateSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import { ADMIN } from './accounts';
import { adminContext, api, loginUi } from './helpers';

// ---- Petite image PNG unie, construite ici (aucun fichier binaire dans le dépôt) ----
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf: Buffer) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
function png(size: number, [r, g, b]: [number, number, number]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // profondeur
  ihdr[9] = 2; // RVB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function openPicker(page: Page) {
  // Icône présente : le bouton de l'icône ; sinon « Ajouter une icône ».
  const head = page.locator('.page-head');
  const iconBtn = head.locator('.page-icon');
  if (await iconBtn.isVisible()) await iconBtn.click();
  else await head.getByRole('button', { name: 'Ajouter une icône' }).click();
  await expect(page.locator('.emoji-picker')).toBeVisible();
  await page.locator('.emoji-picker').getByRole('button', { name: 'Importer une image' }).click();
  return page.getByRole('group', { name: 'Importer une image' });
}

test('une image importée sert d’icône de page, se remplace et se retire', async ({ page, browser }) => {
  const title = 'Icône image e2e';
  const admin = await adminContext(browser);
  const spaces = (await (await api(admin.request, 'GET', '/spaces')).json()) as { id: string; visibility: string }[];
  const created = await (await api(admin.request, 'POST', '/pages', { spaceId: spaces.find((s) => s.visibility === 'public')!.id, title })).json();
  await admin.close();

  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto(`/p/${created.id}`);
  await page.locator('.prose').first().waitFor();

  // Import : aperçu, puis validation.
  let panel = await openPicker(page);
  await expect(panel.getByRole('button', { name: 'Choisir une image' })).toBeFocused();
  await panel.locator('input[type=file]').setInputFiles({ name: 'rouge.png', mimeType: 'image/png', buffer: png(16, [220, 30, 30]) });
  await expect(panel.getByRole('img', { name: 'Aperçu de la nouvelle icône' })).toBeVisible();
  await expect(panel.getByRole('status')).toContainText('Image prête');
  await panel.getByRole('button', { name: 'Utiliser cette image' }).click();
  await expect(page.locator('.emoji-picker')).toHaveCount(0);
  await expect(page.getByText('Icône de la page mise à jour')).toBeVisible();

  const titleIcon = page.locator('.page-head .page-icon img.icon-img');
  const treeIcon = page.locator('.tree-row').filter({ hasText: title }).locator('.tree-icon img.icon-img').first();
  await expect(titleIcon).toBeVisible();
  await expect(treeIcon).toBeVisible();
  await expect(titleIcon).toHaveAttribute('alt', '');
  const first = await titleIcon.getAttribute('src');
  expect(first).toMatch(/^\/api\/v3\/page-icons\/[A-Za-z0-9_-]{22}$/);
  // L'image se charge réellement (droit de lecture vérifié par le serveur).
  await expect.poll(() => titleIcon.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(16);

  // Persistant après rechargement.
  await page.reload();
  await expect(page.locator('.page-head .page-icon img.icon-img')).toHaveAttribute('src', first!);

  // Remplacement : nouvelle adresse, l'ancienne cesse de répondre.
  panel = await openPicker(page);
  await expect(panel.getByRole('button', { name: 'Retirer l’image' })).toBeVisible();
  await panel.locator('input[type=file]').setInputFiles({ name: 'bleu.png', mimeType: 'image/png', buffer: png(24, [30, 60, 220]) });
  await panel.getByRole('button', { name: 'Utiliser cette image' }).click();
  await expect(page.locator('.emoji-picker')).toHaveCount(0);
  await expect(titleIcon).not.toHaveAttribute('src', first!);
  await expect.poll(() => titleIcon.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(24);
  expect((await page.request.get(first!)).status()).toBe(404);

  // Retrait : l'icône redevient vide.
  panel = await openPicker(page);
  await panel.getByRole('button', { name: 'Retirer l’image' }).click();
  await expect(page.locator('.emoji-picker')).toHaveCount(0);
  await expect(page.locator('.page-head .page-icon')).toBeHidden();
  await expect(page.locator('.page-head').getByRole('button', { name: 'Ajouter une icône' })).toBeAttached();
  await expect(page.locator('.tree-icon img.icon-img')).toHaveCount(0);
});

test('un fichier trop lourd ou d’un mauvais type est refusé avant l’envoi', async ({ page, browser }) => {
  const admin = await adminContext(browser);
  const spaces = (await (await api(admin.request, 'GET', '/spaces')).json()) as { id: string; visibility: string }[];
  const created = await (await api(admin.request, 'POST', '/pages', { spaceId: spaces.find((s) => s.visibility === 'public')!.id, title: 'Icône refusée e2e' })).json();
  await admin.close();

  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto(`/p/${created.id}`);
  await page.locator('.prose').first().waitFor();
  let sent = 0;
  page.on('request', (r) => { if (r.url().includes('/icon-image')) sent++; });

  const panel = await openPicker(page);
  const input = panel.locator('input[type=file]');
  const status = panel.getByRole('status');
  const useBtn = panel.getByRole('button', { name: 'Utiliser cette image' });

  // Trop lourd : signature PNG valide, plus de 512 Ko.
  const heavy = Buffer.concat([png(16, [0, 0, 0]), Buffer.alloc(600 * 1024)]);
  await input.setInputFiles({ name: 'lourde.png', mimeType: 'image/png', buffer: heavy });
  await expect(status).toContainText('Image trop lourde');
  await expect(useBtn).toBeDisabled();

  // Mauvais type : un SVG.
  await input.setInputFiles({ name: 'dessin.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"/>') });
  await expect(status).toContainText('Format non pris en charge');
  await expect(useBtn).toBeDisabled();

  // Extension trompeuse : du texte nommé .png.
  await input.setInputFiles({ name: 'faux.png', mimeType: 'image/png', buffer: Buffer.from('pas une image du tout') });
  await expect(status).toContainText('Format non pris en charge');

  // Trop petit : 4 pixels de côté.
  await input.setInputFiles({ name: 'minuscule.png', mimeType: 'image/png', buffer: png(4, [0, 0, 0]) });
  await expect(status).toContainText('Dimensions non acceptées');
  await expect(useBtn).toBeDisabled();

  expect(sent).toBe(0);
  // Retour aux emojis : la recherche reprend le focus.
  await panel.getByRole('button', { name: 'Retour aux emojis' }).click();
  await expect(page.locator('.emoji-search')).toBeFocused();
});

test('l’icône image d’une page partagée par lien s’affiche sans compte', async ({ browser }) => {
  const admin = await adminContext(browser);
  expect((await api(admin.request, 'PUT', '/admin/sharing', { enabled: true })).ok()).toBeTruthy();
  try {
    const spaces = (await (await api(admin.request, 'GET', '/spaces')).json()) as { id: string; visibility: string }[];
    const created = await (await api(admin.request, 'POST', '/pages', { spaceId: spaces.find((s) => s.visibility === 'private')!.id, title: 'Icône partagée e2e' })).json();
    const up = await api(admin.request, 'PUT', `/pages/${created.id}/icon-image`, { image: png(16, [20, 160, 60]).toString('base64') });
    expect(up.ok()).toBeTruthy();
    const share = await (await api(admin.request, 'PUT', `/pages/${created.id}/share`, {})).json();

    const visitor = await browser.newContext({ baseURL: 'http://localhost:3100' });
    const tab = await visitor.newPage();
    await tab.goto(new URL(share.url).pathname);
    const img = tab.locator('.share-title img.icon-img');
    await expect(img).toBeVisible();
    await expect(img).toHaveAttribute('src', /^\/api\/v3\/public\/shares\/[A-Za-z0-9_-]+\/page-icons\/[A-Za-z0-9_-]{22}$/);
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(16);
    await visitor.close();
  } finally {
    await api(admin.request, 'PUT', '/admin/sharing', { enabled: false }).catch(() => undefined);
    await admin.close();
  }
});
