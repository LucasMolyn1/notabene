// « Mes tâches » : entrée de la barre latérale (pastille des retards), page /tasks groupée par échéance (en retard, aujourd'hui,
// cette semaine, plus tard, sans échéance, terminées), filtre « À faire / Toutes », état vide expliqué ; barre de progression
// d'une base (dernière option du statut = terminée).
import { expect, test, type Browser } from '@playwright/test';
import { ADMIN } from './accounts';
import { adminContext, api, createLocalUser, loginUi, PASSWORD, sessionContext } from './helpers';

type Base = { page: { id: string }; properties: { id: string }[] };

function day(days: number) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Base « Suivi » : Responsable, Échéance, Statut ; T1 en retard, T2 à venir, T3 terminée (à l'administrateur), T4 à personne.
 * `extra` : en plus, T0 pour aujourd'hui et T5 sans échéance (à l'administrateur).
 */
async function tasksBase(browser: Browser, title: string, extra = false) {
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
  if (extra) {
    await row({ [nom]: `${title} T0`, [qui.id]: me.user.id, [due.id]: day(0), [statut.id]: statut.options[0]!.id });
    await row({ [nom]: `${title} T5`, [qui.id]: me.user.id, [statut.id]: statut.options[0]!.id });
  }
  await admin.close();
  return { id, statut };
}

test('mes tâches : pastille des retards, groupes d’échéance, filtre et lien vers la base', async ({ page, browser }) => {
  const b = await tasksBase(browser, 'Suivi e2e', true);
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto('/');
  const entry = page.getByRole('button', { name: /^Mes tâches/ });
  await expect(entry).toHaveAccessibleName(/en retard/);
  await entry.click();
  await expect(page).toHaveURL(/\/tasks$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Mes tâches' })).toBeVisible();
  await expect(entry).toHaveAttribute('aria-current', 'page');

  const section = (name: RegExp) => page.locator('section.tasks-group', { has: page.getByRole('heading', { level: 2, name }) });
  const late = section(/^En retard/);
  const today = section(/^Aujourd’hui/);
  const none = section(/^Sans échéance/);
  // À faire (par défaut) : le retard est mis en évidence par un mot (pas seulement une couleur), avec un compteur.
  await expect(late.getByRole('heading', { level: 2 })).toHaveAccessibleName(/^En retard : \d+ tâches?$/);
  await expect(late.locator('.task', { hasText: 'Suivi e2e T1' })).toContainText('En retard');
  await expect(today.locator('.task', { hasText: 'Suivi e2e T0' })).toBeVisible();
  await expect(today.locator('.task', { hasText: 'Suivi e2e T0' })).not.toContainText('En retard');
  await expect(none.locator('.task', { hasText: 'Suivi e2e T5' })).toContainText('Sans échéance');
  // T2 (dans trois jours) : cette semaine ou plus tard selon le jour, jamais en retard ni aujourd'hui.
  await expect(page.locator('section.tasks-week, section.tasks-later').locator('.task', { hasText: 'Suivi e2e T2' })).toBeVisible();
  await expect(late).not.toContainText('Suivi e2e T2');
  // La tâche terminée et celle d'autrui sont absentes.
  await expect(page.locator('.task', { hasText: 'Suivi e2e T3' })).toHaveCount(0);
  await expect(page.locator('.task', { hasText: 'Suivi e2e T4' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Toutes' }).click();
  await expect(page.getByRole('button', { name: 'Toutes' })).toHaveAttribute('aria-pressed', 'true');
  const done = section(/^Terminées/).locator('.task', { hasText: 'Suivi e2e T3' });
  await expect(done).toContainText('Terminé');
  await expect(done).not.toContainText('En retard');

  await late.locator('.task', { hasText: 'Suivi e2e T1' }).getByRole('link', { name: 'Suivi e2e' }).click();
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

test('mes tâches : liste vide expliquée, sans jargon, avec un lien vers les espaces', async ({ browser }) => {
  const admin = await adminContext(browser);
  await createLocalUser(admin.request, 'taches.vide@e2e.test', 'Sans Tâche', 'reader');
  await admin.close();
  const ctx = await sessionContext(browser, 'taches.vide@e2e.test', PASSWORD);
  const page = await ctx.newPage();
  await page.goto('/tasks');
  await expect(page.getByText('Aucune tâche à faire pour le moment.')).toBeVisible();
  await expect(page.locator('.tasks-empty')).toContainText('colonne « Responsable » d’un tableau');
  await expect(page.locator('.tasks-empty')).not.toContainText('ligne de base');
  await expect(page.getByRole('button', { name: /^Mes tâches$/ })).toBeVisible();
  await page.getByRole('button', { name: 'Toutes' }).click();
  await expect(page.getByText('Aucune tâche ne vous est attribuée.')).toBeVisible();
  const spaceLink = page.getByRole('navigation', { name: 'Espaces' }).getByRole('link').first();
  await expect(spaceLink).toBeVisible();
  await spaceLink.click();
  await expect(page).toHaveURL(/\/s\//);
  await ctx.close();
});
