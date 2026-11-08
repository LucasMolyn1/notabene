// Journal d'audit (filtres, « Voir plus », export), envoi au SIEM (état et formulaire) et durées de conservation.
// Le serveur de test n'a pas de collecteur SIEM joignable : les tests d'envoi sont simulés avec page.route.
import { readFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { ADMIN } from './accounts';
import { adminContext } from './helpers';

const EVENTS = /\/api\/v3\/admin\/audit\/events\?/;
const EXPORT = /\/api\/v3\/admin\/audit\/export\?/;
const SIEM_STATE = /\/api\/v3\/admin\/audit\/siem$/;
const RETENTION = /\/api\/v3\/admin\/retention$/;
const SIEM_TEST = /\/api\/v3\/admin\/settings\/siem\/test$/;
const SIEM_SAVE = /\/api\/v3\/admin\/settings\/siem$/;

const fakeEvent = (n: number) => ({
  schema: 'notabene.audit/1', id: n, timestamp: new Date(Date.now() - n * 60_000).toISOString(), action: 'audit.export',
  outcome: 'success', actor: { id: 'u1', name: 'Admin' }, target: `simu-${n}`, ip: '127.0.0.1', meta: { format: 'csv' },
});

async function openAdmin(browser: Parameters<typeof adminContext>[0], path: string) {
  const ctx = await adminContext(browser);
  const page = await ctx.newPage();
  await page.goto(path);
  return { ctx, page };
}

const entries = (page: Page) => page.getByRole('list', { name: 'Entrées du journal' });

// Échec de connexion journalisé (compte inconnu), depuis un contexte sans session.
async function failedLogin(browser: Parameters<typeof adminContext>[0]) {
  const anon = await browser.newContext({ baseURL: 'http://localhost:3100' });
  await anon.request.post('/auth/local/login', { data: { email: 'inconnu-audit@e2e.test', password: 'mauvais-mot-de-passe' } });
  await anon.close();
}

test('journal : filtres, échecs, dates incohérentes, erreur et « Voir plus »', async ({ browser }) => {
  await failedLogin(browser);

  const { ctx, page } = await openAdmin(browser, '/settings/audit');
  await expect(page.locator('.audit-status')).toContainText('affichée');
  await expect(page.getByLabel('Personne').locator('option')).not.toHaveCount(1);

  // Échecs seulement.
  await page.getByLabel('Issue').selectOption('failure');
  let req = page.waitForRequest((r) => EVENTS.test(r.url()) && r.url().includes('outcome=failure'));
  await page.getByRole('button', { name: 'Filtrer' }).click();
  await req;
  await expect(entries(page).getByText('Échec de connexion').first()).toBeVisible();
  const rows = entries(page).getByRole('listitem');
  expect(await rows.count()).toBeGreaterThan(0);
  expect(await rows.filter({ hasNot: page.locator('.pill.warn') }).count()).toBe(0);

  // Famille d'actions (préfixe « auth. »), toutes issues.
  await page.getByLabel('Issue').selectOption('');
  await page.getByLabel('Action', { exact: true }).selectOption('auth.');
  req = page.waitForRequest((r) => EVENTS.test(r.url()) && r.url().includes('action=auth.') && !r.url().includes('outcome'));
  await page.getByRole('button', { name: 'Filtrer' }).click();
  await req;
  await expect(entries(page).getByText('Connexion', { exact: true }).first()).toBeVisible();

  // Dates incohérentes : message sous le champ, aucune requête.
  let sent = 0;
  page.on('request', (r) => { if (EVENTS.test(r.url())) sent++; });
  await page.getByLabel('Du', { exact: true }).fill('2026-12-31');
  await page.getByLabel('Au (inclus)').fill('2026-01-01');
  await page.getByRole('button', { name: 'Filtrer' }).click();
  await expect(page.getByText('La date de début doit précéder ou égaler la date de fin.')).toBeVisible();
  await expect(page.getByLabel('Du', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByLabel('Du', { exact: true })).toBeFocused();
  expect(sent).toBe(0);

  // Erreur du serveur : message et bouton « Réessayer ».
  await page.route(EVENTS, (route) => route.fulfill({ status: 500, json: { detail: 'panne simulée' } }));
  await page.getByRole('button', { name: 'Effacer les filtres' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Impossible de charger le journal : panne simulée' })).toBeVisible();
  await expect(page.getByLabel('Du', { exact: true })).toHaveValue('');

  // Pagination par curseur.
  await page.unroute(EVENTS);
  await page.route(EVENTS, (route) => {
    const second = new URL(route.request().url()).searchParams.get('cursor') === 'c1';
    return route.fulfill({ json: { items: [fakeEvent(second ? 2 : 1)], nextCursor: second ? null : 'c1' } });
  });
  await page.getByRole('button', { name: 'Réessayer' }).click();
  await expect(entries(page).getByText(/cible simu-1/)).toBeVisible();
  await expect(entries(page).getByText('Export du journal').first()).toBeVisible();
  await page.getByRole('button', { name: 'Voir plus' }).click();
  await expect(entries(page).getByText(/cible simu-2/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Voir plus' })).toBeHidden();
  await expect(entries(page).getByRole('listitem').nth(1)).toBeFocused();
  await expect(page.locator('.audit-status')).toHaveText('2 entrées affichées.');
  await ctx.close();
});

test('journal : export CSV réel, export tronqué et limite atteinte', async ({ browser }) => {
  const { ctx, page } = await openAdmin(browser, '/settings/audit');
  await expect(page.locator('.audit-status')).toContainText('affichée');

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Exporter en CSV' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^journal-audit-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = await readFile((await file.path())!, 'utf8');
  expect(csv.replace(/^\uFEFF/, '').split('\r\n')[0]).toBe('id,timestamp,action,outcome,actor_id,actor_name,target,ip,meta');
  await expect(page.getByText(/Export CSV prêt/)).toBeVisible();

  // Export tronqué (simulé) : les filtres saisis partent avec la demande et l'interface le signale.
  let exportUrl = '';
  await page.route(EXPORT, (route) => {
    exportUrl = route.request().url();
    return route.fulfill({
      status: 200, body: '[]',
      headers: { 'content-type': 'application/json', 'content-disposition': 'attachment; filename="journal-audit-2026-11-08.json"', 'x-export-rows': '100000', 'x-export-truncated': 'true' },
    });
  });
  await page.getByLabel('Issue').selectOption('failure');
  const json = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Exporter en JSON' }).click();
  expect((await json).suggestedFilename()).toBe('journal-audit-2026-11-08.json');
  expect(exportUrl).toContain('format=json');
  expect(exportUrl).toContain('outcome=failure');
  await expect(page.getByText(/Export tronqué : seules les 100\s000 entrées les plus récentes/)).toBeVisible();

  // Limite de 10 exports par tranche de 10 minutes.
  await page.unroute(EXPORT);
  await page.route(EXPORT, (route) => route.fulfill({ status: 429, json: { detail: 'Rate limit exceeded' } }));
  await page.getByRole('button', { name: 'Exporter en CSV' }).click();
  await expect(page.getByText(/Trop d’exports en peu de temps/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Exporter en CSV' })).toBeEnabled();
  await ctx.close();
});

test('conservation : durées réelles et absence de purge', async ({ browser }) => {
  const { ctx, page } = await openAdmin(browser, '/settings/retention');
  const list = page.locator('.set-card').first().locator('dl');
  await expect(list.getByRole('term').filter({ hasText: /^Journal d’audit$/ })).toBeVisible();
  await expect(list).toContainText('365 jours');
  await expect(list).toContainText('AUDIT_RETENTION_DAYS');
  await expect(page.getByText('Purge automatique toutes les 60 minutes', { exact: false })).toBeVisible();
  await expect(page.locator('.set-card').nth(1)).toContainText('Sessions');

  await page.route(RETENTION, (route) => route.fulfill({ json: {
    purgeIntervalMinutes: 60,
    items: [{ key: 'AUDIT_RETENTION_DAYS', label: 'Journal d’audit', description: 'Supprimé après ce délai.', days: 0, purged: false }],
    fixed: [],
  } }));
  await page.reload();
  await expect(page.getByText('Pas de purge', { exact: true })).toBeVisible();
  await expect(page.getByText('Conservé sans limite de durée (réglé à 0 jour).')).toBeVisible();
  await ctx.close();
});

test('SIEM : état, erreurs de saisie, test refusé puis accepté, enregistrement', async ({ browser }) => {
  const { ctx, page } = await openAdmin(browser, '/settings/siem');
  await expect(page.getByText('Non configuré')).toBeVisible();

  const url = page.getByLabel('Adresse du collecteur');
  const secret = page.getByLabel('Secret de signature');
  const actions = page.getByLabel('Familles d’actions à relayer');
  const testBtn = page.getByRole('button', { name: 'Tester l’envoi' });
  const save = page.getByRole('button', { name: 'Enregistrer' });
  await page.getByRole('checkbox', { name: 'Activé' }).check();

  // Saisie invalide : erreurs sous les champs, focus sur le premier, aucun appel ni ressaisie demandée.
  let tests = 0;
  let testResult: { ok: boolean; message: string; testId: string | null } = { ok: false, message: 'le collecteur répond 500', testId: null };
  await page.route(SIEM_TEST, (route) => { tests++; return route.fulfill({ json: testResult }); });
  await url.fill('ftp://siem.example.com');
  await secret.fill('court');
  await actions.fill('auth\nauth%');
  await testBtn.click();
  await expect(page.getByText('Adresse invalide : attendu https://hôte/chemin.')).toBeVisible();
  await expect(page.getByText('Le secret doit compter au moins 16 caractères.')).toBeVisible();
  await expect(page.getByText('Famille invalide : « auth% »', { exact: false })).toBeVisible();
  await expect(url).toHaveAttribute('aria-invalid', 'true');
  await expect(url).toBeFocused();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(tests).toBe(0);

  // Saisie corrigée : la ressaisie du mot de passe est demandée, le test échoue, l'enregistrement reste bloqué.
  await url.fill('https://siem.example.com/hook');
  await secret.fill('secret-de-test-0123456789');
  await actions.fill('auth\nsettings');
  await testBtn.click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Mot de passe', { exact: true }).fill(ADMIN.password);
  await dialog.getByRole('button', { name: 'Confirmer' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'le collecteur répond 500' })).toBeVisible();
  await expect(url).not.toHaveAttribute('aria-invalid', 'true');
  await expect(save).toBeDisabled();

  // Test accepté : l'enregistrement part avec le jeton du test, la configuration et le secret.
  testResult = { ok: true, message: 'Évènement de test accepté par le collecteur (statut 204).', testId: 't-1' };
  await testBtn.click();
  await expect(page.getByText('Évènement de test accepté par le collecteur (statut 204).')).toBeVisible();
  await expect(save).toBeEnabled();
  let body: { config?: unknown; secrets?: unknown; testId?: string; reauth?: unknown } = {};
  await page.route(SIEM_SAVE, (route) => {
    if (route.request().method() !== 'PUT') return route.fallback();
    body = route.request().postDataJSON();
    return route.fulfill({ json: { section: 'siem', source: 'db', locked: false, enabled: true, values: { url: 'https://siem.example.com/hook', actions: ['auth', 'settings'] }, secrets: { secret: { set: true, hint: '…6789' } } } });
  });
  await save.click();
  await expect(page.getByText('Configuration enregistrée')).toBeVisible();
  expect(body).toMatchObject({ config: { enabled: true, url: 'https://siem.example.com/hook', actions: ['auth', 'settings'] }, secrets: { secret: 'secret-de-test-0123456789' }, testId: 't-1' });
  expect(body.reauth).toBeDefined();

  // Envoi arrêté après trop d'échecs (état simulé).
  await page.route(SIEM_STATE, (route) => route.fulfill({ json: {
    configured: true, active: false, origin: 'https://siem.example.com', actions: ['auth'], disabled: true, failures: 10, maxFailures: 10,
    lastStatus: 0, lastAttemptAt: Date.now() - 60_000, lastSuccessAt: null, nextAttemptAt: null, pending: 42, stdout: false,
  } }));
  await page.getByRole('button', { name: 'Actualiser' }).click();
  await expect(page.getByText('Désactivé après trop d’échecs')).toBeVisible();
  await expect(page.getByText('L’envoi est arrêté après 10 échecs consécutifs', { exact: false })).toBeVisible();
  await expect(page.getByText(/collecteur injoignable/)).toBeVisible();
  await expect(page.getByText('42 évènements')).toBeVisible();
  await ctx.close();
});

// Débordement de la page ou de la zone qui défile (un bouton trop large y crée un défilement horizontal).
const overflow = (page: Page) => page.evaluate(() => {
  const scroller = document.querySelector('.scroller');
  return Math.max(document.documentElement.scrollWidth - window.innerWidth, scroller ? scroller.scrollWidth - scroller.clientWidth : 0);
});

test('journal, SIEM et conservation : rien ne déborde en largeur 375 px', async ({ browser }) => {
  const ctx = await adminContext(browser);
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 375, height: 812 });
  for (const path of ['/settings/audit', '/settings/siem', '/settings/retention']) {
    await page.goto(path);
    await page.locator('.set-card').first().waitFor();
    await page.waitForTimeout(300);
    expect(await overflow(page), path).toBeLessThanOrEqual(0);
  }
  // Erreurs de saisie affichées : toujours aucun débordement.
  await page.goto('/settings/siem');
  await page.getByRole('checkbox', { name: 'Activé' }).check();
  await page.getByLabel('Adresse du collecteur').fill('pas-une-adresse');
  await page.getByRole('button', { name: 'Tester l’envoi' }).click();
  await expect(page.getByText('Adresse invalide', { exact: false })).toBeVisible();
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  await ctx.close();
});

for (const colorScheme of ['light', 'dark'] as const) {
  test(`journal, SIEM et conservation : accessibilité, thème ${colorScheme}`, async ({ browser }) => {
    await failedLogin(browser);
    const ctx = await adminContext(browser);
    const page = await ctx.newPage();
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    const found: string[] = [];
    const check = async (label: string) => {
      const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      found.push(...r.violations.map((v) => `${label} | ${v.id} | ${v.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(' ; ')}`));
    };
    await page.goto('/settings/audit');
    await expect(page.locator('.audit-status')).toContainText('affichée');
    await page.getByLabel('Issue').selectOption('failure');
    await page.getByRole('button', { name: 'Filtrer' }).click();
    await expect(entries(page).locator('.pill.warn').first()).toBeVisible();
    await page.getByLabel('Du', { exact: true }).fill('2026-12-31');
    await page.getByLabel('Au (inclus)').fill('2026-01-01');
    await page.getByRole('button', { name: 'Filtrer' }).click();
    await expect(page.locator('#audit-f-dates-err')).toBeVisible();
    await check('journal');

    await page.goto('/settings/siem');
    await page.getByRole('checkbox', { name: 'Activé' }).check();
    await page.getByLabel('Adresse du collecteur').fill('ftp://x');
    await page.getByRole('button', { name: 'Tester l’envoi' }).click();
    await expect(page.locator('.field-error:visible')).toHaveCount(2);
    await check('siem (erreurs)');
    await page.route(SIEM_STATE, (route) => route.fulfill({ json: {
      configured: true, active: false, origin: 'https://siem.example.com', actions: [], disabled: true, failures: 10, maxFailures: 10,
      lastStatus: 503, lastAttemptAt: Date.now(), lastSuccessAt: Date.now() - 3_600_000, nextAttemptAt: null, pending: 3, stdout: true,
    } }));
    await page.reload();
    await expect(page.getByText('Désactivé après trop d’échecs')).toBeVisible();
    await check('siem (désactivé)');

    await page.goto('/settings/retention');
    await expect(page.getByText('AUDIT_RETENTION_DAYS')).toBeVisible();
    await check('conservation');
    expect(found).toEqual([]);
    await ctx.close();
  });
}
