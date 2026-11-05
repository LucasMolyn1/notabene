import { expect, test, type Browser, type Page } from '@playwright/test';
import { ADMIN } from './accounts';
import { adminContext, api, loginUi } from './helpers';

// Image PNG de 1 × 1 pixel.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
// Nom piégé : il doit s'afficher tel quel, en texte, sans jamais devenir du HTML.
const TRAP_NAME = 'rapport <img src=x onerror=alert(1)>.pdf';

async function newPage(browser: Browser, title: string) {
  const admin = await adminContext(browser);
  const spaces = (await (await api(admin.request, 'GET', '/spaces')).json()) as { id: string; visibility: string }[];
  const created = await (await api(admin.request, 'POST', '/pages', { spaceId: spaces.find((s) => s.visibility === 'public')!.id, title })).json();
  await admin.close();
  return created.id as string;
}

async function storedContent(browser: Browser, id: string) {
  const admin = await adminContext(browser);
  const page = await (await api(admin.request, 'GET', `/pages/${id}`)).json();
  await admin.close();
  return JSON.stringify(page.content);
}

// Commande « / » qui ouvre le sélecteur de fichier, puis choix du fichier.
async function slashUpload(page: Page, command: string, file: { name: string; mimeType: string; buffer: Buffer }) {
  await page.locator('.prose > p').last().click();
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
  await (await chooser).setFiles(file);
}

const idOf = (href: string | null) => /\/api\/v3\/attachments\/([A-Za-z0-9_-]{22})$/.exec(href ?? '')?.[1] ?? '';

test('joindre un fichier et une image : affichage, téléchargement, suppression', async ({ page, browser }) => {
  const id = await newPage(browser, 'Pièces jointes e2e');
  await loginUi(page, ADMIN.email, ADMIN.password);
  const dialogs: string[] = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); void d.dismiss(); });
  await page.goto(`/p/${id}`);
  await page.locator('.prose').click();

  // Fichier : carte « nom, taille, télécharger », le nom en texte seulement.
  await slashUpload(page, '/fichier', { name: TRAP_NAME, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n% e2e\n') });
  const card = page.locator('.file-card');
  await expect(card).toHaveCount(1);
  await expect(card.locator('.file-card-name')).toHaveText(TRAP_NAME);
  await expect(card.locator('.file-card-meta')).toContainText('PDF');
  await expect(card.locator('img')).toHaveCount(0);
  await expect(page.locator('.upload-tray [role="status"]')).toContainText('envoyé');
  const link = card.getByRole('link', { name: /Télécharger/ });
  const fileId = idOf(await link.getAttribute('href'));
  expect(fileId).toHaveLength(22);

  // Téléchargement : le fichier reçu est bien celui envoyé.
  const download = page.waitForEvent('download');
  await link.click();
  const got = await download;
  expect(got.suggestedFilename()).toMatch(/\.pdf$/);
  const res = await page.request.get(`/api/v3/attachments/${fileId}`);
  expect(res.status()).toBe(200);
  expect((await res.body()).toString()).toContain('%PDF-1.4');

  // Image collée : envoyée en pièce jointe (plus de base64), affichée.
  await page.locator('.prose > p').last().click();
  await page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'point-rouge.png', { type: 'image/png' }));
    document.querySelector('.ProseMirror')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, PNG.toString('base64'));
  const img = page.locator('.img-block img');
  await expect(img).toHaveAttribute('src', /^\/api\/v3\/attachments\/[A-Za-z0-9_-]{22}$/);
  await expect(img).toHaveAttribute('alt', 'point rouge');
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth)).toBe(1);
  await expect.poll(() => storedContent(browser, id), { timeout: 15_000 }).toContain('/api/v3/attachments/');
  const stored = await storedContent(browser, id);
  expect(stored).not.toContain('data:image');
  expect(stored).toContain('"type":"attachment"');

  // Suppression : après confirmation, le bloc disparaît et le fichier n'est plus servi.
  await card.getByRole('button', { name: /Supprimer/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Supprimer' }).click();
  await expect(card).toHaveCount(0);
  await expect.poll(async () => (await page.request.get(`/api/v3/attachments/${fileId}`)).status()).toBe(404);
  expect(dialogs).toEqual([]);
});

test('vidéo : lecteur sans lecture automatique ; fichier trop lourd refusé avec un message clair', async ({ page, browser }) => {
  const id = await newPage(browser, 'Vidéo et refus e2e');
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto(`/p/${id}`);
  await page.locator('.prose').click();

  // En-tête MP4 minimal : reconnu comme vidéo par le serveur.
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(32)]);
  await slashUpload(page, '/video', { name: 'demo.mp4', mimeType: 'video/mp4', buffer: mp4 });
  const video = page.locator('.media-video video');
  await expect(video).toHaveCount(1);
  await expect(video).toHaveAttribute('controls', '');
  await expect(video).toHaveAttribute('preload', 'metadata');
  expect(await video.getAttribute('autoplay')).toBeNull();
  await expect(page.locator('.media-video .media-name')).toHaveText('Vidéo : demo.mp4');

  // Plafond de 1 Mo en e2e (playwright.config.ts) : refus annoncé, rien n'est inséré.
  await slashUpload(page, '/fichier', { name: 'gros.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(1536 * 1024, 7) });
  await expect(page.locator('.toast.error')).toContainText('trop lourd');
  await expect(page.locator('.file-card')).toHaveCount(0);
});
