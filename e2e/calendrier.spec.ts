// Vue calendrier d'une base : grille mois et semaine, navigation au clavier, déplacement (clavier et souris), ajout d'une ligne
// sur un jour, « +N de plus », liste par date ; flux iCalendar (adresse montrée une fois, rotation, révocation).
import { expect, test, type Browser, type Page } from '@playwright/test';
import { ADMIN } from './accounts';
import { adminContext, api, loginUi } from './helpers';

type Row = { id: string; values: Record<string, unknown> };
type Base = { page: { id: string }; properties: { id: string }[] };

/** Date locale décalée de `days` jours, au format AAAA-MM-JJ (le navigateur de test est sur le même fuseau). */
function day(days: number) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
/** Numéro de jour (celui de l'attribut data-day des cases). */
const dayNum = (iso: string) => Math.round(Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 86_400_000);
const isoOf = (n: number) => new Date(n * 86_400_000).toISOString().slice(0, 10);

async function rowsOf(browser: Browser, baseId: string) {
  const admin = await adminContext(browser);
  const data = (await (await api(admin.request, 'GET', `/bases/${baseId}`)).json()) as { rows: Row[] };
  await admin.close();
  return data.rows;
}

/** Base : Début, Fin, Statut ; Conception (aujourd'hui à +2), Réunion (aujourd'hui, sans fin), Idée (sans date). */
async function calendarBase(browser: Browser, title: string) {
  const admin = await adminContext(browser);
  const spaces = (await (await api(admin.request, 'GET', '/spaces')).json()) as { id: string; visibility: string }[];
  const base = (await (await api(admin.request, 'POST', '/bases', { spaceId: spaces.find((s) => s.visibility === 'public')!.id, title })).json()) as Base;
  const id = base.page.id;
  const nom = base.properties[0]!.id;
  const prop = async (name: string, type: string) => (await (await api(admin.request, 'POST', `/bases/${id}/properties`, { name, type })).json()) as { id: string; options: { id: string }[] };
  const debut = await prop('Début', 'date');
  const fin = await prop('Fin', 'date');
  const statut = await prop('Statut', 'status');
  const row = async (values: Record<string, unknown>) => (await (await api(admin.request, 'POST', `/bases/${id}/rows`, { values })).json()) as Row;
  const a = await row({ [nom]: 'Conception', [debut.id]: day(0), [fin.id]: day(2), [statut.id]: statut.options[1]!.id });
  const b = await row({ [nom]: 'Réunion', [debut.id]: day(0) });
  await row({ [nom]: 'Idée' });
  expect((await api(admin.request, 'PATCH', `/bases/${id}/settings`, { startPropertyId: debut.id, endPropertyId: fin.id })).ok()).toBeTruthy();
  await admin.close();
  return { id, nom, debut, fin, statut, a, b };
}

async function openCalendar(page: Page, id: string) {
  await page.goto(`/p/${id}`);
  await page.getByRole('button', { name: 'Nouvelle vue' }).click();
  await page.getByRole('menuitem', { name: 'Nouveau calendrier' }).click();
  await expect(page.getByRole('grid')).toBeVisible();
}

const patched = (page: Page, rowId: string) => page.waitForResponse((r) => r.url().includes(`/rows/${rowId}`) && r.request().method() === 'PATCH');

test('calendrier : grille, clavier, glisser, ajout sur un jour, liste par date et semaine', async ({ page, browser }) => {
  const p = await calendarBase(browser, 'Calendrier e2e');
  await page.setViewportSize({ width: 1400, height: 1000 });
  await loginUi(page, ADMIN.email, ADMIN.password);
  await openCalendar(page, p.id);

  // Grille : en-têtes de colonne du lundi au dimanche, aujourd'hui repéré, éléments avec leurs dates, ligne sans date à part.
  const grid = page.getByRole('grid');
  await expect(grid.getByRole('columnheader')).toHaveCount(7);
  await expect(grid.getByRole('columnheader').first()).toContainText('lundi');
  await expect(grid.locator('[aria-current="date"]')).toHaveCount(1);
  await expect(page.getByRole('button', { name: /^Conception, du / })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Réunion, le / })).toBeVisible();
  await expect(page.getByText('Sans date (1)')).toBeVisible();
  // Couleur selon le statut (option « En cours ») : pas la couleur par défaut.
  await expect(page.locator(`.cal-ev[data-row="${p.a.id}"]`).first()).not.toHaveClass(/c-default/);

  // Grille navigable aux flèches (une seule case dans l'ordre de tabulation).
  await expect(grid.locator('[role="gridcell"][tabindex="0"]')).toHaveCount(1);
  const todayCell = grid.locator(`[data-day="${dayNum(day(0))}"]`);
  await todayCell.focus();
  await page.keyboard.press('ArrowRight');
  await expect(grid.locator(`[data-day="${dayNum(day(1))}"]`)).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(todayCell).toBeFocused();

  // Alt + flèche droite : décaler d'un jour, la fin suit ; le focus reste sur l'élément.
  const evA = page.getByRole('button', { name: /^Conception, du / });
  await evA.focus();
  let done = patched(page, p.a.id);
  await page.keyboard.press('Alt+ArrowRight');
  await done;
  await expect(page.getByRole('button', { name: /^Conception, du / })).toBeFocused();
  let rows = await rowsOf(browser, p.id);
  const at = (rid: string) => rows.find((r) => r.id === rid)!.values;
  expect([at(p.a.id)[p.debut.id], at(p.a.id)[p.fin.id]]).toEqual([day(1), day(3)]);
  // Alt + flèche haut : une semaine plus tôt.
  done = patched(page, p.a.id);
  await page.keyboard.press('Alt+ArrowUp');
  await done;
  rows = await rowsOf(browser, p.id);
  expect([at(p.a.id)[p.debut.id], at(p.a.id)[p.fin.id]]).toEqual([day(-6), day(-4)]);
  await expect(page.getByRole('button', { name: /^Conception, du / })).toBeFocused();

  // Souris : glisser « Réunion » vers le jour voisin (le lendemain s'il est affiché, sinon la veille).
  await page.getByRole('button', { name: 'Aujourd’hui' }).click();
  const from = dayNum(day(0));
  const target = (await grid.locator(`[data-day="${from + 1}"]`).count()) ? from + 1 : from - 1;
  const evB = page.getByRole('button', { name: /^Réunion, le / });
  const src = (await evB.boundingBox())!;
  const dst = (await grid.locator(`[data-day="${target}"]`).boundingBox())!;
  done = patched(page, p.b.id);
  await page.mouse.move(src.x + 10, src.y + src.height / 2);
  await page.mouse.down();
  await page.mouse.move(src.x + 30, src.y + src.height / 2, { steps: 3 });
  await page.mouse.move(dst.x + dst.width / 2, dst.y + dst.height - 10, { steps: 6 });
  await page.mouse.up();
  await done;
  rows = await rowsOf(browser, p.id);
  expect(at(p.b.id)[p.debut.id]).toBe(isoOf(target));
  expect(at(p.b.id)[p.fin.id] ?? null).toBeNull();

  // Ouvrir un élément (Entrée) : fiche avec titre, dates et statut.
  await page.getByRole('button', { name: /^Réunion, le / }).focus();
  await page.keyboard.press('Enter');
  const fiche = page.getByRole('form', { name: /Ligne Réunion/ });
  await fiche.getByLabel('Fin').fill(isoOf(target + 1));
  done = patched(page, p.b.id);
  await fiche.getByRole('button', { name: 'Enregistrer' }).click();
  await done;
  await expect(page.getByRole('button', { name: /^Réunion, du / })).toBeVisible();

  // Entrée sur un jour : nouvelle ligne datée de ce jour, fiche ouverte pour saisir le titre.
  const addOn = target;
  await grid.locator(`[data-day="${addOn}"]`).focus();
  const created = page.waitForResponse((r) => r.url().endsWith(`/bases/${p.id}/rows`) && r.request().method() === 'POST');
  await page.keyboard.press('Enter');
  const newRow = (await (await created).json()) as Row;
  const fiche2 = page.getByRole('form', { name: /Ligne Sans titre/ });
  await fiche2.getByLabel('Nom').fill('Atelier');
  done = patched(page, newRow.id);
  await fiche2.getByRole('button', { name: 'Enregistrer' }).click();
  await done;
  rows = await rowsOf(browser, p.id);
  expect(at(newRow.id)[p.nom]).toBe('Atelier');
  expect(at(newRow.id)[p.debut.id]).toBe(isoOf(addOn));

  // Navigation entre mois : le titre change, Aujourd'hui revient.
  const title = page.locator('.cal-title');
  const month = await title.textContent();
  await page.getByRole('button', { name: 'Mois suivant' }).click();
  await expect(title).not.toHaveText(month!);
  await page.getByRole('button', { name: 'Aujourd’hui' }).click();
  await expect(title).toHaveText(month!);

  // Liste par date : mêmes éléments, dates modifiables.
  await page.getByRole('button', { name: 'Liste par date' }).click();
  const table = page.getByRole('table', { name: /Calendrier sous forme de liste/ });
  await expect(table.getByRole('rowheader', { name: 'Atelier' })).toBeVisible();
  await expect(table.getByLabel('Début de Réunion')).toHaveValue(isoOf(target));
  done = patched(page, p.b.id);
  await table.getByLabel('Début de Réunion').fill(day(-1));
  await table.getByLabel('Début de Réunion').press('Tab');
  await done;
  rows = await rowsOf(browser, p.id);
  expect(at(p.b.id)[p.debut.id]).toBe(day(-1));

  // Semaine : une seule rangée de jours ; le réglage de la vue est enregistré.
  await page.getByRole('button', { name: 'Grille' }).click();
  const saved = page.waitForResponse((r) => r.url().includes('/views/') && r.request().method() === 'PATCH');
  await page.getByLabel('Affichage').selectOption('week');
  await saved;
  await expect(page.getByRole('grid').getByRole('row')).toHaveCount(2);
  await page.reload();
  await page.getByRole('tab', { name: 'Calendrier' }).click();
  await expect(page.getByLabel('Affichage')).toHaveValue('week');
});

test('calendrier : « +N de plus » liste tous les éléments du jour', async ({ page, browser }) => {
  const admin = await adminContext(browser);
  const spaces = (await (await api(admin.request, 'GET', '/spaces')).json()) as { id: string; visibility: string }[];
  const base = (await (await api(admin.request, 'POST', '/bases', { spaceId: spaces.find((s) => s.visibility === 'public')!.id, title: 'Calendrier chargé e2e' })).json()) as Base;
  const id = base.page.id;
  const debut = (await (await api(admin.request, 'POST', `/bases/${id}/properties`, { name: 'Quand', type: 'date' })).json()) as { id: string };
  for (let i = 1; i <= 5; i++) await api(admin.request, 'POST', `/bases/${id}/rows`, { values: { [base.properties[0]!.id]: `Tâche ${i}`, [debut.id]: day(0) } });
  const detail = (await (await api(admin.request, 'GET', `/bases/${id}`)).json()) as { views: { id: string }[] };
  // Sans colonne choisie ni réglages : la première colonne Date sert.
  expect((await api(admin.request, 'PATCH', `/bases/${id}/views/${detail.views[0]!.id}`, { config: { type: 'calendar', mode: 'month', sort: [], filters: [], hidden: [] } })).ok()).toBeTruthy();
  await admin.close();

  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto(`/p/${id}`);
  await expect(page.locator('.cal-grid .cal-ev')).toHaveCount(3);
  await page.getByRole('button', { name: /^\+2 de plus : 2 autres éléments le / }).click();
  const list = page.getByRole('group', { name: /^Éléments du / });
  await expect(list.getByRole('button')).toHaveCount(5);
  await list.getByRole('button', { name: /^Tâche 5, le / }).click();
  await expect(page.getByRole('form', { name: /Ligne Tâche 5/ })).toBeVisible();
});

test.describe('flux iCalendar', () => {
  const setSharing = async (browser: Browser, enabled: boolean) => {
    const admin = await adminContext(browser);
    expect((await api(admin.request, 'PUT', '/admin/sharing', { enabled })).ok()).toBeTruthy();
    await admin.close();
  };
  test.afterAll(async ({ browser }) => { await setSharing(browser, false).catch(() => undefined); });

  test('adresse montrée une fois, copiée, changée puis révoquée', async ({ page, browser, playwright }) => {
    await setSharing(browser, true);
    const p = await calendarBase(browser, 'Agenda e2e');
    await loginUi(page, ADMIN.email, ADMIN.password);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await openCalendar(page, p.id);
    const visitor = await playwright.request.newContext({ baseURL: 'http://localhost:3100' });
    const feed = (url: string) => visitor.get(new URL(url).pathname);

    await page.getByRole('button', { name: 'S’abonner (iCalendar)' }).click();
    let dialog = page.getByRole('dialog', { name: 'S’abonner depuis un agenda' });
    await dialog.getByRole('button', { name: 'Créer une adresse d’abonnement' }).click();
    const first = await dialog.getByLabel('Adresse d’abonnement').inputValue();
    expect(first).toMatch(/\/ical\/[A-Za-z0-9_-]{32}\.ics$/);
    await expect(dialog.getByText('elle ne sera plus affichée')).toBeVisible();
    await dialog.getByRole('button', { name: 'Copier' }).click();
    await expect(dialog.getByRole('status')).toHaveText('Adresse copiée');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(first);

    // Lecture sans compte : texte iCalendar minimal.
    const res = await feed(first);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/calendar');
    const ics = await res.text();
    expect(ics).toContain('SUMMARY:Conception');
    expect(ics).not.toContain('Idée');

    // Rouvert : l'adresse n'est plus affichée.
    await dialog.getByRole('button', { name: 'Fermer' }).first().click();
    await page.getByRole('button', { name: 'S’abonner (iCalendar)' }).click();
    dialog = page.getByRole('dialog', { name: 'S’abonner depuis un agenda' });
    await expect(dialog.getByText(/Adresse active depuis le/)).toBeVisible();
    await expect(dialog.getByLabel('Adresse d’abonnement')).toHaveCount(0);

    // Changer l'adresse : l'ancienne ne répond plus.
    await dialog.getByRole('button', { name: 'Changer l’adresse' }).click();
    await page.getByRole('dialog', { name: 'Changer l’adresse ?' }).getByRole('button', { name: 'Changer l’adresse' }).click();
    const second = await dialog.getByLabel('Adresse d’abonnement').inputValue();
    expect(second).not.toBe(first);
    expect((await feed(first)).status()).toBe(404);
    expect((await feed(second)).status()).toBe(200);

    // Révoquer : plus rien ne répond, la création redevient possible.
    await dialog.getByRole('button', { name: 'Révoquer l’adresse' }).click();
    await page.getByRole('dialog', { name: 'Révoquer l’adresse ?' }).getByRole('button', { name: 'Révoquer' }).click();
    await expect(dialog.getByRole('button', { name: 'Créer une adresse d’abonnement' })).toBeVisible();
    expect((await feed(second)).status()).toBe(404);
    await visitor.dispose();
  });

  test('base aux permissions restreintes : accord explicite avant de créer l’adresse', async ({ page, browser }) => {
    await setSharing(browser, true);
    const p = await calendarBase(browser, 'Agenda restreint e2e');
    const admin = await adminContext(browser);
    const me = (await (await admin.request.get('/api/v3/me')).json()) as { user: { id: string } };
    expect((await api(admin.request, 'PUT', `/pages/${p.id}/permissions`, { entries: [{ userId: me.user.id, level: 'write' }] })).ok()).toBeTruthy();
    await admin.close();
    await loginUi(page, ADMIN.email, ADMIN.password);
    await openCalendar(page, p.id);
    await page.getByRole('button', { name: 'S’abonner (iCalendar)' }).click();
    const dialog = page.getByRole('dialog', { name: 'S’abonner depuis un agenda' });
    await dialog.getByRole('button', { name: 'Créer une adresse d’abonnement' }).click();
    await expect(dialog.getByText('Cette base a des permissions restreintes.')).toBeVisible();
    await expect(dialog.getByLabel('Adresse d’abonnement')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Créer l’adresse' }).click();
    await expect(dialog.getByRole('alert')).toHaveText('Cochez la confirmation pour continuer.');
    const sent = page.waitForRequest((r) => r.url().endsWith(`/bases/${p.id}/ical`) && r.method() === 'POST');
    await dialog.getByLabel(/Je confirme publier les titres et les dates/).check();
    await dialog.getByRole('button', { name: 'Créer l’adresse' }).click();
    expect((await sent).postDataJSON()).toEqual({ confirmRestricted: true });
    await expect(dialog.getByLabel('Adresse d’abonnement')).toHaveValue(/\/ical\/[A-Za-z0-9_-]{32}\.ics$/);
  });
});
