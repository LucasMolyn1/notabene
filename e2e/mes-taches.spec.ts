// « Mes tâches » : entrée de la barre latérale (pastille des retards), page /tasks groupée par base, filtre « À faire / Toutes »,
// état vide ; barre de progression d'une base (dernière option du statut = terminée).
import { expect, test, type Browser } from '@playwright/test';
import { ADMIN } from './accounts';
import { adminContext, api, createLocalUser, loginUi, PASSWORD, sessionContext } from './helpers';

type Base = { page: { id: string }; properties: { id: string }[] };

function day(days: number) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Base « Suivi » : Responsable, Échéance, Statut ; T1 en retard, T2 à venir, T3 terminée (à l'administrateur), T4 à personne. */
async function tasksBase(browser: Browser, title: string) {
  const admin = await adminContext(browser);
  const me = (await (await admin.request.get('/api/v3/me')).json()) as { user: { id: string } };
  const spaces = (await (await api(admin.request, 'GET', '/spaces')).json()) as { id: string; visibility: string }[];
  const base = (await (await api(admin.request, 'POST', '/bases', { spaceId: spaces.find((s) => s.visibility === 'public')!.id, title })).json()) as Base;
  const id = base.page.id;
  const nom = base.properties[0]!.id;
  const prop = async (name: string, type: string) => (await (await api(admin.request, 'POST', `/bases/${id}/properties`, { name, type })).json()) as { id: string; options: { id: string; name: string }[] };
  const qui = await prop('Responsable', 'person');
  const due = await prop('Échéance', 'date');
  const statut = await prop('Statut', 'status');
  const row = async (values: Record<string, unknown>) => (await (await api(admin.request, 'POST', `/bases/${id}/rows`, { values })).json()) as { id: string };
  await row({ [nom]: `${title} T2`, [qui.id]: me.user.id, [due.id]: day(3), [statut.id]: statut.options[1]!.id });
  await row({ [nom]: `${title} T1`, [qui.id]: me.user.id, [due.id]: day(-2), [statut.id]: statut.options[0]!.id });
  await row({ [nom]: `${title} T3`, [qui.id]: me.user.id, [due.id]: day(-5), [statut.id]: statut.options.at(-1)!.id });
  await row({ [nom]: `${title} T4`, [due.id]: day(-1) });
  await admin.close();
  return { id, statut };
}

test('mes tâches : pastille des retards, regroupement par base, filtre et lien vers la base', async ({ page, browser }) => {
  const b = await tasksBase(browser, 'Suivi e2e');
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto('/');
  const entry = page.getByRole('button', { name: /^Mes tâches/ });
  await expect(entry).toHaveAccessibleName(/en retard/);
  await entry.click();
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Mes tâches' })).toBeVisible();
  await expect(entry).toHaveAttribute('aria-current', 'page');

  const group = page.locator('.tasks-group', { has: page.getByRole('link', { name: 'Suivi e2e' }) });
  const items = group.locator('.task');
  // À faire (par défaut) : la tâche terminée et celle d'autrui sont absentes ; le retard vient en tête, signalé en texte.
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText('Suivi e2e T1');
  await expect(items.nth(0)).toContainText('En retard');
  await expect(items.nth(1)).toContainText('Suivi e2e T2');
  await expect(items.nth(1)).not.toContainText('En retard');
  await expect(group).not.toContainText('Suivi e2e T4');

  await page.getByRole('button', { name: 'Toutes' }).click();
  await expect(page.getByRole('button', { name: 'Toutes' })).toHaveAttribute('aria-pressed', 'true');
  await expect(items).toHaveCount(3);
  await expect(group.locator('.task', { hasText: 'Suivi e2e T3' })).toContainText('Terminé');
  await expect(group.locator('.task', { hasText: 'Suivi e2e T3' })).not.toContainText('En retard');

  await group.getByRole('link', { name: 'Suivi e2e' }).click();
  await expect(page).toHaveURL(new RegExp(`${b.id}$`));
  await expect(page.getByRole('textbox', { name: 'Titre de la base' })).toHaveValue('Suivi e2e');
});

test('progression d’une base : dernière option du statut, mise à jour après modification', async ({ page, browser }) => {
  const b = await tasksBase(browser, 'Progression e2e');
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto(`/p/${b.id}`);
  const bar = page.getByRole('progressbar', { name: '1 sur 4 terminées' });
  await expect(bar).toBeVisible();
  await expect(bar).toHaveAttribute('aria-valuenow', '1');
  await expect(bar).toHaveAttribute('aria-valuemax', '4');

  const row = page.locator('tbody tr', { hasText: 'Progression e2e T2' });
  await row.getByRole('button', { name: /modifier Statut/ }).click();
  await page.getByRole('combobox', { name: 'Statut' }).selectOption({ label: b.statut.options.at(-1)!.name });
  await expect(page.getByRole('progressbar', { name: '2 sur 4 terminées' })).toBeVisible();
  // Relu du serveur : même valeur.
  await page.reload();
  await expect(page.getByRole('progressbar', { name: '2 sur 4 terminées' })).toBeVisible();
});

test('mes tâches : état vide pour une personne sans tâche', async ({ browser }) => {
  const admin = await adminContext(browser);
  await createLocalUser(admin.request, 'taches.vide@e2e.test', 'Sans Tâche', 'reader');
  await admin.close();
  const ctx = await sessionContext(browser, 'taches.vide@e2e.test', PASSWORD);
  const page = await ctx.newPage();
  await page.goto('/tasks');
  await expect(page.getByText('Aucune tâche à faire')).toBeVisible();
  await expect(page.getByRole('button', { name: /^Mes tâches$/ })).toBeVisible();
  await page.getByRole('button', { name: 'Toutes' }).click();
  await expect(page.getByText('Aucune tâche ne vous est attribuée.')).toBeVisible();
  await ctx.close();
});
