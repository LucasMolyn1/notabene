// Audit d'accessibilité automatisé (axe-core, WCAG 2.1 A et AA) sur les écrans principaux, en clair et en sombre.
// Il attrape les noms manquants, les rôles ARIA invalides, les contrastes et les libellés ; il ne remplace pas un test
// avec lecteur d'écran (voir docs/ACCESSIBILITE.md).
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { ADMIN } from './accounts';
import { adminContext, api, createLocalUser, loginUi, PASSWORD, sessionContext } from './helpers';

// Sans animation : axe mesure les contrastes d'un menu ou d'une palette en pleine transition, d'où de fausses alertes.
test.use({ reducedMotion: 'reduce' });

const SECTIONS = ['profile', 'appearance', 'tokens', 'about', 'ai', 'diagrams', 'tools', 'api', 'embed', 'shares', 'spaces', 'groups', 'auth', 'mail', 'embeds', 'webhooks', 'import', 'users', 'audit', 'instance'];

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

    test('libellés : pastille et champ d’ajout', async ({ page }) => {
      await loginUi(page, ADMIN.email, ADMIN.password);
      await page.getByText('Nouvelle page').first().click();
      await page.locator('.prose').first().waitFor();
      await page.locator('.label-add').click();
      await page.getByRole('combobox', { name: 'Nouveau libellé' }).fill(`a11y-${scheme}`);
      await page.keyboard.press('Enter');
      await page.getByRole('link', { name: `a11y-${scheme}` }).waitFor();
      const found = await violations(page, 'libellés (pastille)');
      await page.locator('.label-add').click();
      await page.getByRole('combobox', { name: 'Nouveau libellé' }).waitFor();
      found.push(...await violations(page, 'libellés (champ)'));
      expect(found).toEqual([]);
    });

    test('modèles : liste de choix', async ({ page }) => {
      await loginUi(page, ADMIN.email, ADMIN.password);
      await page.getByRole('complementary', { name: 'Navigation' }).getByRole('button', { name: 'Depuis un modèle' }).click();
      await page.getByRole('dialog', { name: 'Nouvelle page depuis un modèle' }).getByRole('button', { name: /Procédure/ }).waitFor();
      expect(await violations(page, 'modèles')).toEqual([]);
    });

    test('commentaires ancrés et mentions', async ({ page, browser }) => {
      const admin = await adminContext(browser);
      const spaces = (await (await api(admin.request, 'GET', '/spaces')).json()) as { id: string; visibility: string }[];
      const me = await (await api(admin.request, 'GET', '/me')).json();
      const created = await (await api(admin.request, 'POST', '/pages', { spaceId: spaces.find((s) => s.visibility === 'public')!.id, title: `A11y ancres ${scheme}` })).json();
      const comment = await (await api(admin.request, 'POST', `/pages/${created.id}/comments`, { body: 'Un commentaire', anchorText: 'texte ancré', mentions: [me.user.id] })).json();
      const patched = await admin.request.fetch(`/api/v3/pages/${created.id}`, { method: 'PATCH', headers: { 'x-csrf-token': me.csrf, 'if-match': `"${created.version}"` }, data: {
        content: { type: 'doc', content: [{ type: 'paragraph', content: [
          { type: 'text', text: 'texte ancré', marks: [{ type: 'commentAnchor', attrs: { id: comment.id } }] },
          { type: 'text', text: ' avec ' }, { type: 'mention', attrs: { id: me.user.id, label: 'Admin E2E' } },
        ] }] },
      } });
      expect(patched.ok()).toBeTruthy();
      await admin.close();
      await loginUi(page, ADMIN.email, ADMIN.password);
      await page.goto(`/p/${created.id}`);
      await page.locator('.comment-live').waitFor();
      const found = await violations(page, 'page avec ancre et mention');
      await page.getByRole('button', { name: 'Commentaires' }).click();
      await page.getByRole('textbox', { name: 'Nouveau commentaire' }).fill('Salut @Adm');
      await page.getByRole('option', { name: /Admin E2E/ }).waitFor();
      found.push(...await violations(page, 'commentaires et liste de mentions'));
      expect(found).toEqual([]);
    });

    test('contenus intégrés : carte avant affichage et hôte non autorisé', async ({ page, browser }) => {
      const root = await adminContext(browser);
      await createLocalUser(root.request, 'embed.admin@e2e.test', 'Admin intégrations', 'admin'); // session dédiée : ne consomme pas la ressaisie du mot de passe de l'administrateur commun
      const admin = await sessionContext(browser, 'embed.admin@e2e.test', PASSWORD);
      await api(admin.request, 'PUT', '/admin/settings/embeds', { config: { enabled: true, hosts: ['videos.example.test'] }, reauth: { password: PASSWORD } });
      const spaces = (await (await api(admin.request, 'GET', '/spaces')).json()) as { id: string; visibility: string }[];
      const created = await (await api(admin.request, 'POST', '/pages', {
        spaceId: spaces.find((s) => s.visibility === 'public')!.id, title: `A11y intégrations ${scheme}`,
        content: { type: 'doc', content: [{ type: 'embed', attrs: { url: 'https://videos.example.test/v/1' } }, { type: 'embed', attrs: { url: 'https://refuse.example.test/v/2' } }] },
      })).json();
      await loginUi(page, ADMIN.email, ADMIN.password);
      await page.goto(`/p/${created.id}`);
      await page.locator('.embed-card').first().waitFor();
      const found = await violations(page, 'contenus intégrés');
      await api(admin.request, 'POST', '/admin/settings/embeds/reset', { reauth: { password: PASSWORD } });
      await Promise.all([admin.close(), root.close()]);
      expect(found).toEqual([]);
    });

    test('historique : différences entre versions', async ({ page, browser }) => {
      const admin = await adminContext(browser);
      await createLocalUser(admin.request, 'a11y.auteur@e2e.test', 'Auteur a11y', 'editor');
      const spaces = (await (await api(admin.request, 'GET', '/spaces')).json()) as { id: string; visibility: string }[];
      const p = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
      const created = await (await api(admin.request, 'POST', '/pages', {
        spaceId: spaces.find((s) => s.visibility === 'public')!.id, title: `A11y historique ${scheme}`,
        content: { type: 'doc', content: [p('Un paragraphe stable'), p('Le chat dort'), p('Supprimé')] },
      })).json();
      const author = await sessionContext(browser, 'a11y.auteur@e2e.test', PASSWORD);
      const read = await api(author.request, 'GET', `/pages/${created.id}`);
      const me = await (await author.request.get('/api/v3/me')).json();
      await author.request.fetch(`/api/v3/pages/${created.id}`, { method: 'PATCH', headers: { 'x-csrf-token': me.csrf, 'if-match': read.headers().etag }, data: { content: { type: 'doc', content: [p('Un paragraphe stable'), p('Le chien dort'), p('Ajouté')] } } });
      await Promise.all([admin.close(), author.close()]);
      await loginUi(page, ADMIN.email, ADMIN.password);
      await page.goto(`/p/${created.id}`);
      await page.getByRole('button', { name: 'Historique des versions' }).click();
      const dialog = page.getByRole('dialog', { name: 'Historique de la page' });
      await dialog.locator('.hist-item').nth(1).click();
      await dialog.getByRole('button', { name: 'Différences avec la version actuelle' }).click();
      await dialog.locator('.diff').waitFor();
      expect(await violations(page, 'historique (différences)')).toEqual([]);
    });

    test('blocs : dépliable, colonnes, formule, couleurs et palette', async ({ page, browser }) => {
      const t = (text: string, marks?: object[]) => ({ type: 'text', text, ...(marks ? { marks } : {}) });
      const colored = ['gray', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink'].flatMap((c) => [
        t(`texte ${c} `, [{ type: 'textColor', attrs: { color: c } }]), t(`fond ${c} `, [{ type: 'highlight', attrs: { color: c } }]),
      ]);
      const admin = await adminContext(browser);
      const spaces = (await (await api(admin.request, 'GET', '/spaces')).json()) as { id: string; visibility: string }[];
      const created = await (await api(admin.request, 'POST', '/pages', {
        spaceId: spaces.find((s) => s.visibility === 'public')!.id, title: `A11y blocs ${scheme}`,
        content: { type: 'doc', content: [
          { type: 'paragraph', attrs: { align: 'center' }, content: colored },
          { type: 'details', content: [{ type: 'detailsSummary', content: [t('Un titre')] }, { type: 'detailsContent', content: [{ type: 'paragraph', content: [t('Un contenu')] }] }] },
          { type: 'columns', content: [[t('Colonne un')], [t('Colonne deux')]].map((c) => ({ type: 'column', content: [{ type: 'paragraph', content: c }] })) },
          { type: 'math', attrs: { code: 'E = mc^2' } },
        ] },
      })).json();
      await admin.close();
      await loginUi(page, ADMIN.email, ADMIN.password);
      await page.goto(`/p/${created.id}`);
      await page.locator('.katex').waitFor();
      await page.getByRole('button', { name: 'Déplier le bloc' }).click();
      const found = await violations(page, 'blocs');
      await page.locator('.prose p').first().selectText();
      await page.getByRole('button', { name: 'Couleurs et alignement' }).click();
      await page.getByRole('button', { name: 'Texte rouge' }).waitFor();
      found.push(...await violations(page, 'palette de couleurs'));
      expect(found).toEqual([]);
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
