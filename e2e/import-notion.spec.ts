import { crc32 } from 'node:zlib';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { ADMIN } from './accounts';
import { adminContext, api, loginUi } from './helpers';

// Archive ZIP minimale (méthode « stockée », noms en UTF-8), construite à la main : structure d'un export Notion « Markdown & CSV ».
function zip(files: Record<string, string>) {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const data = Buffer.from(text, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version requise
    local.writeUInt16LE(0x0800, 6); // noms en UTF-8
    local.writeUInt16LE(0, 8); // stocké, sans compression
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const dir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, end]);
}

const ROOT_ID = 'a'.repeat(32);
const CHILD_ID = 'b'.repeat(32);
const ROOT = 'Accueil Notion e2e';
const CHILD = 'Étape un';
const enc = (s: string) => encodeURIComponent(s);
const archive = () => zip({
  [`${ROOT} ${ROOT_ID}.md`]: `# ${ROOT}\n\nVoir [${CHILD}](${enc(ROOT)}/${enc(`${CHILD} ${CHILD_ID}`)}.md).\n`,
  [`${ROOT}/${CHILD} ${CHILD_ID}.md`]: `# ${CHILD}\n\nRetour à [l’accueil](../${enc(`${ROOT} ${ROOT_ID}`)}.md).\n`,
  [`ancienne ${'c'.repeat(32)}.html`]: '<html><body><script>alert(1)</script></body></html>',
});

async function publicSpace(browser: Browser) {
  const admin = await adminContext(browser);
  const spaces = (await (await api(admin.request, 'GET', '/spaces')).json()) as { id: string; visibility: string }[];
  await admin.close();
  return spaces.find((s) => s.visibility === 'public')!.id;
}

async function titlesIn(browser: Browser, spaceId: string) {
  const admin = await adminContext(browser);
  const res = await api(admin.request, 'GET', `/pages?spaceId=${spaceId}&limit=200`);
  const body = await res.json();
  await admin.close();
  return ((body.items ?? body) as { title: string; spaceId: string }[]).filter((p) => p.spaceId === spaceId).map((p) => p.title);
}

async function a11y(page: Page, label: string) {
  const found: string[] = [];
  await page.emulateMedia({ reducedMotion: 'reduce' });
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    found.push(...result.violations.map((v) => `${label} (${theme}) | ${v.id} | ${v.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(' ; ')}`));
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  expect(found).toEqual([]);
}

async function openImport(page: Page, spaceId: string) {
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto(`/s/${spaceId}`);
  await page.locator('.space-switch').click();
  await page.getByRole('menuitem', { name: 'Importer depuis Notion' }).click();
  return page.getByRole('dialog', { name: /Importer depuis Notion/ });
}

test('import Notion : simulation sans écriture, puis import et lien vers les pages créées', async ({ page, browser }) => {
  const spaceId = await publicSpace(browser);
  const dialog = await openImport(page, spaceId);
  await expect(dialog.getByRole('button', { name: 'Importer' })).toBeDisabled();
  await dialog.getByLabel('Archive ZIP Notion').setInputFiles({ name: 'Export-notion.zip', mimeType: 'application/zip', buffer: archive() });

  await dialog.getByRole('button', { name: 'Simuler' }).click();
  await expect(dialog.getByText('Simulation terminée : rien n’a été créé.')).toBeVisible();
  const table = dialog.getByRole('table', { name: 'Fichiers de l’archive' });
  await expect(table.getByRole('row')).toHaveCount(4); // en-tête + deux pages + un fichier HTML écarté
  await expect(table.getByRole('row', { name: /ancienne .*\.html/ })).toContainText('Ignoré');
  await dialog.getByText(/^Ignorés \(1\)$/).click();
  await expect(table.getByRole('row')).toHaveCount(2);
  await expect(dialog.getByText('1 fichier affiché.')).toBeVisible();
  expect(await titlesIn(browser, spaceId)).not.toContain(ROOT);
  await a11y(page, 'rapport de simulation Notion');

  await dialog.getByRole('button', { name: 'Importer' }).click();
  await expect(dialog.getByText('Import terminé.', { exact: true }).first()).toBeVisible();
  await expect(dialog.getByRole('heading', { name: '2 pages créées' })).toBeVisible();
  const history = dialog.getByRole('region', { name: 'Imports récents' });
  await expect(history.getByRole('listitem')).toHaveCount(2);
  await expect(history.getByRole('listitem').first()).toContainText('Import');
  expect(await titlesIn(browser, spaceId)).toEqual(expect.arrayContaining([ROOT, CHILD]));

  // Rapport d'une simulation précédente, relu depuis l'historique.
  await history.getByRole('button', { name: /Voir le rapport/ }).nth(1).click();
  await expect(dialog.getByText('Simulation terminée : rien n’a été créé.')).toBeVisible();

  // Retour au rapport d'import, puis lien vers la page créée.
  await history.getByRole('button', { name: /Voir le rapport/ }).first().click();
  await dialog.locator('.ni-created').getByRole('link', { name: ROOT }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/p\//);
  await expect(page.getByText(CHILD).first()).toBeVisible();
});

test('import Notion : refus du serveur annoncés (import en cours, archive trop grosse)', async ({ page, browser }) => {
  const spaceId = await publicSpace(browser);
  await page.route('**/api/v3/spaces/*/import/notion*', (route) => route.fulfill({
    status: 503, contentType: 'application/problem+json', json: { status: 503, title: 'Service Unavailable', detail: 'Un import est déjà en cours sur cette instance : réessayez dans quelques minutes' },
  }));
  const dialog = await openImport(page, spaceId);
  await dialog.getByLabel('Archive ZIP Notion').setInputFiles({ name: 'Export-notion.zip', mimeType: 'application/zip', buffer: archive() });
  await dialog.getByRole('button', { name: 'Simuler' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Un import est déjà en cours sur cette instance : réessayez dans quelques minutes');
  await expect(dialog.getByRole('button', { name: 'Importer' })).toBeDisabled();

  await page.unroute('**/api/v3/spaces/*/import/notion*');
  await page.route('**/api/v3/spaces/*/import/notion*', (route) => route.fulfill({
    status: 413, contentType: 'application/json', json: { statusCode: 413, error: 'Payload Too Large', message: 'Request body is too large' },
  }));
  await dialog.getByRole('button', { name: 'Simuler' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('Archive trop volumineuse pour cette instance (réglage IMPORT_ZIP_MAX_MB).');
  await a11y(page, 'import Notion refusé');
});
