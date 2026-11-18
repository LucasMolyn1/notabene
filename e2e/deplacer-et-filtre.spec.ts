// « Déplacer vers… » (menu de la page et de l'arbre, clavier, exclusion des descendantes) et filtre d'une longue liste
// de pages. Chaque test crée son propre espace : les autres tests ne voient pas ces pages.
import { expect, test, type APIRequestContext } from '@playwright/test';
import { adminContext, api } from './helpers';

const rand = () => Math.random().toString(36).slice(2, 7);

async function newSpace(request: APIRequestContext, name: string) {
  const res = await api(request, 'POST', '/spaces', { name, access: 'admins' });
  expect(res.ok(), 'création de l’espace').toBeTruthy();
  return (await res.json()) as { id: string };
}
async function newPage(request: APIRequestContext, spaceId: string, title: string, parentId: string | null = null) {
  const res = await api(request, 'POST', '/pages', { spaceId, title, parentId });
  expect(res.ok(), `création de ${title}`).toBeTruthy();
  return (await res.json()) as { id: string };
}
const parentOf = async (request: APIRequestContext, id: string) => ((await (await api(request, 'GET', `/pages/${id}`)).json()) as { parentId: string | null }).parentId ?? null;

test('déplacer une page depuis son menu, sans proposer ses sous-pages, et la garder ouverte', async ({ browser }) => {
  const ctx = await adminContext(browser);
  const space = await newSpace(ctx.request, `Rangement ${rand()}`);
  const a = await newPage(ctx.request, space.id, 'Classeur A');
  const b = await newPage(ctx.request, space.id, 'Classeur B');
  const a1 = await newPage(ctx.request, space.id, 'Sous-dossier A1', a.id);
  await newPage(ctx.request, space.id, 'Fiche A1a', a1.id);
  const page = await ctx.newPage();
  await page.goto(`/p/${a.id}`);
  await page.locator('.prose').first().waitFor();

  await page.getByRole('button', { name: 'Plus d’options' }).click();
  await page.getByRole('menuitem', { name: 'Déplacer vers…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Déplacer « Classeur A »' });
  const input = dialog.getByRole('combobox', { name: 'Rechercher une page ou un espace de destination' });
  await expect(input).toBeFocused();
  // La page elle-même et ses descendantes ne sont jamais proposées.
  const options = dialog.getByRole('option');
  await expect(options.filter({ hasText: 'Classeur B' })).toHaveCount(1);
  for (const t of ['Classeur A', 'Sous-dossier A1', 'Fiche A1a']) await expect(options.filter({ hasText: t })).toHaveCount(0);
  await input.fill('Sous-dossier A1');
  await expect(dialog.getByRole('status')).toHaveText('Aucune destination ne correspond.');
  // Recherche insensible aux accents et à la casse.
  await input.fill('classeur b');
  await expect(options).toHaveCount(1);
  await expect(input).toHaveAttribute('aria-activedescendant', /move-opt-/);
  await input.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(page.locator('.toast').filter({ hasText: 'Page déplacée sous « Classeur B »' })).toBeVisible();
  await expect.poll(() => parentOf(ctx.request, a.id)).toBe(b.id);
  // La page reste ouverte, et le fil d'Ariane suit.
  await expect(page.getByRole('textbox', { name: 'Titre de la page' })).toHaveValue('Classeur A');
  await expect(page.getByRole('navigation', { name: 'Fil d’Ariane' })).toContainText('Classeur B');
  await ctx.close();
});

test('déplacer au clavier depuis l’arbre, vers la racine de l’espace ; Échap ferme la fenêtre', async ({ browser }) => {
  const ctx = await adminContext(browser);
  const space = await newSpace(ctx.request, `Rangement clavier ${rand()}`);
  const parent = await newPage(ctx.request, space.id, 'Dossier parent');
  const child = await newPage(ctx.request, space.id, 'Page à remonter', parent.id);
  await newPage(ctx.request, space.id, 'Autre page');
  const page = await ctx.newPage();
  await page.goto(`/p/${child.id}`);
  await page.locator('.prose').first().waitFor();
  // Moins de 30 pages : pas de filtre.
  await expect(page.getByRole('searchbox', { name: 'Filtrer les pages' })).toHaveCount(0);

  const row = page.getByRole('treeitem', { name: 'Page à remonter' });
  await row.focus();
  await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('menuitem').first()).toBeFocused();
  // Menu de l'arbre : « Déplacer vers… » est la cinquième entrée.
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Déplacer vers…' })).toBeFocused();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Déplacer « Page à remonter »' });
  const input = dialog.getByRole('combobox');
  await expect(input).toBeFocused();
  // L'emplacement actuel est signalé et n'est pas choisissable.
  await expect(dialog.getByRole('option', { name: /Dossier parent.*emplacement actuel/ })).toHaveAttribute('aria-disabled', 'true');
  // Flèches : l'option active change (aria-activedescendant).
  const first = await input.getAttribute('aria-activedescendant');
  await page.keyboard.press('ArrowDown');
  await expect(input).not.toHaveAttribute('aria-activedescendant', first!);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect(await parentOf(ctx.request, child.id)).toBe(parent.id);

  await page.getByRole('button', { name: 'Plus d’options' }).click();
  await page.getByRole('menuitem', { name: 'Déplacer vers…' }).click();
  await page.keyboard.type('racine');
  await expect(dialog.getByRole('option', { name: /À la racine de l’espace/ })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(page.locator('.toast').filter({ hasText: 'Page déplacée à la racine de l’espace' })).toBeVisible();
  await expect.poll(() => parentOf(ctx.request, child.id)).toBeNull();
  await expect(page.getByRole('tree', { name: 'Pages' }).getByRole('treeitem', { name: 'Page à remonter', exact: true })).toHaveAttribute('aria-level', '1');
  await ctx.close();
});

test('longue liste de pages : filtre par titre, sans accents, parents gardés, Échap vide le filtre', async ({ browser }) => {
  test.setTimeout(90_000);
  const ctx = await adminContext(browser);
  const space = await newSpace(ctx.request, `Archives ${rand()}`);
  const first = await newPage(ctx.request, space.id, 'Fiche 001');
  for (let i = 2; i <= 32; i++) await newPage(ctx.request, space.id, `Fiche ${String(i).padStart(3, '0')}`);
  const lock = await newPage(ctx.request, space.id, 'Écluse');
  await newPage(ctx.request, space.id, 'Équipe spéciale', lock.id);
  const page = await ctx.newPage();
  await page.goto(`/p/${first.id}`);
  await page.locator('.prose').first().waitFor();

  const filter = page.getByRole('searchbox', { name: 'Filtrer les pages' });
  await expect(filter).toBeVisible();
  const sidebar = page.getByRole('complementary', { name: 'Navigation' });
  await expect(sidebar.getByRole('treeitem', { name: 'Fiche 032' })).toBeVisible();
  await expect(sidebar.getByRole('treeitem', { name: 'Équipe spéciale' })).toHaveCount(0); // replié

  await filter.fill('equipe');
  const filtered = sidebar.getByRole('tree', { name: 'Pages filtrées' });
  await expect(filtered.getByRole('treeitem')).toHaveCount(2);
  await expect(filtered.getByRole('treeitem', { name: 'Écluse' })).toBeVisible();
  await expect(filtered.getByRole('treeitem', { name: 'Équipe spéciale' })).toBeVisible();
  await expect(sidebar.locator('#tree-filter-status')).toHaveText('1 page trouvée.');
  await filter.fill('FICHE 01');
  await expect(filtered.getByRole('treeitem')).toHaveCount(10);
  await filter.fill('aucune correspondance');
  await expect(sidebar.getByText('Aucune page ne correspond.').first()).toBeVisible();
  await filter.fill('fiche 03');
  await expect(filtered.getByRole('treeitem')).toHaveCount(3);
  // Flèche bas : le focus passe dans l'arbre filtré.
  await filter.press('ArrowDown');
  await expect(filtered.getByRole('treeitem', { name: 'Fiche 030' })).toBeFocused();
  await filter.focus();
  await filter.press('Escape');
  await expect(filter).toHaveValue('');
  await expect(sidebar.getByRole('tree', { name: 'Pages', exact: true }).getByRole('treeitem', { name: 'Fiche 001' })).toBeVisible();
  await expect(sidebar.getByRole('tree', { name: 'Pages filtrées' })).toHaveCount(0);
  await ctx.close();
});
