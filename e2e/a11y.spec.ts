// Audit d'accessibilité automatisé (axe-core, WCAG 2.1 A et AA) sur les écrans principaux, en clair et en sombre.
// Il attrape les noms manquants, les rôles ARIA invalides, les contrastes et les libellés ; il ne remplace pas un test
// avec lecteur d'écran (voir docs/ACCESSIBILITE.md).
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { ADMIN } from './accounts';
import { loginUi } from './helpers';

// Sans animation : axe mesure les contrastes d'un menu ou d'une palette en pleine transition, d'où de fausses alertes.
test.use({ reducedMotion: 'reduce' });

const SECTIONS = ['profile', 'appearance', 'tokens', 'about', 'ai', 'diagrams', 'tools', 'api', 'embed', 'spaces', 'auth', 'mail', 'webhooks', 'import', 'users', 'audit', 'instance'];

async function violations(page: Page, label: string) {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  return result.violations.map((v) => `${label} | ${v.id} (${v.impact}) | ${v.nodes.length} élément(s) | ${v.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(' ; ')}`);
}

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`accessibilité, thème ${scheme}`, () => {
    test.use({ colorScheme: scheme });

    test('connexion', async ({ page }) => {
      await page.goto('/?login');
      await page.getByLabel('Adresse e-mail').waitFor();
      expect(await violations(page, 'connexion')).toEqual([]);
    });

    test('wiki : page, palette, menu de page', async ({ page }) => {
      await loginUi(page, ADMIN.email, ADMIN.password);
      const found: string[] = [];
      await page.getByRole('treeitem', { name: 'Bienvenue sur Notabene' }).click();
      await page.locator('.prose').first().waitFor();
      found.push(...await violations(page, 'page'));
      await page.keyboard.press('Control+k');
      await page.getByRole('combobox', { name: 'Rechercher' }).waitFor();
      found.push(...await violations(page, 'palette'));
      await page.keyboard.press('Escape');
      await page.getByRole('treeitem', { name: 'Bienvenue sur Notabene' }).focus();
      await page.keyboard.press('Shift+F10');
      await page.getByRole('menuitem').first().waitFor();
      found.push(...await violations(page, 'menu de page'));
      expect(found).toEqual([]);
    });

    test('sélecteur d’emojis', async ({ page }) => {
      await loginUi(page, ADMIN.email, ADMIN.password);
      await page.getByText('Nouvelle page').first().click();
      await page.getByRole('button', { name: /Ajouter une icône/i }).click();
      await page.locator('.emoji-section[data-group="0"]').waitFor();
      expect(await violations(page, 'sélecteur d’emojis')).toEqual([]);
    });

    test('bloc de code coloré', async ({ page }) => {
      await loginUi(page, ADMIN.email, ADMIN.password);
      await page.getByText('Nouvelle page').first().click();
      await page.locator('.tiptap').click();
      await page.keyboard.type('```js ');
      // Mots-clés, chaîne, commentaire, nombre : chaque couleur de coloration est mesurée par axe.
      await page.keyboard.type('// note\nconst nom = "texte" + 42;\nfunction f(a) { return a; }');
      await page.locator('.code-block .tok-keyword').first().waitFor();
      expect(await violations(page, 'bloc de code')).toEqual([]);
    });

    test('paramètres : toutes les sections', async ({ page }) => {
      await loginUi(page, ADMIN.email, ADMIN.password);
      const found: string[] = [];
      // Filet de sécurité : une section qui plante (import manquant, erreur au rendu) est signalée même sans violation d'accessibilité.
      const crashes: string[] = [];
      page.on('pageerror', (err) => crashes.push(err.message));
      for (const id of SECTIONS) {
        await page.goto(`/#/settings/${id}`);
        await page.locator('.set-card, .set-card-head, h1').first().waitFor();
        await page.waitForTimeout(250);
        found.push(...await violations(page, `paramètres/${id}`));
      }
      expect(crashes).toEqual([]);
      expect(found).toEqual([]);
    });
  });
}
