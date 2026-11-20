// Animations de l'interface (GSAP, client/src/motion.js) : la série tourne en « réduire les animations » (playwright.config.ts).
// Ici, elles sont réactivées pour vérifier que l'interface reste utilisable pendant l'animation et que tout finit dans un état
// correct (visible, sans style en ligne résiduel, éléments fermés retirés du DOM).
import { expect, test, type Page } from '@playwright/test';
import { ADMIN } from './accounts';
import { loginUi } from './helpers';

// Styles en ligne laissés par une animation sur les éléments visés (doit être vide une fois l'animation finie).
const leftovers = (page: Page, selector: string) => page.locator(selector).evaluateAll((els) =>
  els.filter((el) => (el as HTMLElement).style.opacity || (el as HTMLElement).style.transform).length);

test.describe('avec animations', () => {
  test.use({ reducedMotion: 'no-preference' });

  test('arbre, palette, menu et modale : utilisables tout de suite, état final propre', async ({ page }) => {
    await loginUi(page, ADMIN.email, ADMIN.password);
    const root = page.getByRole('treeitem', { name: 'Bienvenue sur BeNote' });
    await root.waitFor();
    await expect.poll(() => leftovers(page, '.tree-row')).toBe(0);

    // Palette : le champ a le focus dès l'ouverture, les résultats sont choisissables, la fermeture rend la main.
    await page.keyboard.press('Control+k');
    const input = page.getByRole('combobox', { name: 'Rechercher' });
    await expect(input).toBeFocused();
    await input.fill('bienvenue');
    await expect(page.getByRole('option').first()).toBeVisible();
    await expect.poll(() => leftovers(page, '.pal-item, .palette, .overlay')).toBe(0);
    await page.keyboard.press('Escape');
    await expect(input).toBeHidden();
    await expect(page.locator('.overlay')).toHaveCount(0);

    // Menu du compte : focus sur le premier élément, Échap ferme et rend le focus au déclencheur.
    const account = page.locator('.sidebar .account');
    await account.click();
    await expect(page.getByRole('menuitem').first()).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(account).toBeFocused();
    await expect(page.locator('.popover')).toHaveCount(0);

    // Modale : visible et opaque une fois ouverte, retirée du DOM après fermeture (bouton puis Échap).
    for (const how of ['bouton', 'Échap']) {
      await page.locator('.sidebar').getByRole('button', { name: 'Corbeille' }).click();
      const dialog = page.getByRole('dialog', { name: 'Corbeille' });
      await expect(dialog).toBeVisible();
      await expect.poll(() => leftovers(page, 'dialog.modal')).toBe(0);
      if (how === 'bouton') await dialog.getByRole('button', { name: 'Fermer' }).click();
      else await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(page.locator('dialog.modal')).toHaveCount(0);
    }
  });
});

test('mouvement réduit : aucun style d’animation, fermeture immédiate', async ({ page }) => {
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.getByRole('treeitem', { name: 'Bienvenue sur BeNote' }).waitFor();
  expect(await leftovers(page, '.tree-row')).toBe(0);
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('combobox', { name: 'Rechercher' })).toBeFocused();
  expect(await leftovers(page, '.palette, .overlay')).toBe(0);
  await page.keyboard.press('Escape');
  expect(await page.locator('.overlay').count()).toBe(0);
});
