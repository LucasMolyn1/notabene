import { expect, test, type Browser } from '@playwright/test';
import { ADMIN } from './accounts';
import { adminContext, api, createLocalUser, loginUi, PASSWORD, sessionContext } from './helpers';

const HOST = 'videos.example.test';

let changed = false;

// Administrateur dédié : la ressaisie du mot de passe (fenêtre de dix minutes) et la limite d'écritures sont propres à chaque session,
// donc ces tests ne retirent pas à la série la demande de mot de passe que d'autres tests vérifient.
export async function embedAdmin(browser: Browser) {
  const root = await adminContext(browser);
  await createLocalUser(root.request, 'embed.admin@e2e.test', 'Admin intégrations', 'admin');
  await root.close();
  return sessionContext(browser, 'embed.admin@e2e.test', PASSWORD);
}

// Les écritures de réglages sont limitées à 10 par minute : on attend si une autre série en a déjà consommé une partie.
async function setHosts(browser: Browser, hosts: string[]) {
  const admin = await embedAdmin(browser);
  let res = await api(admin.request, 'PUT', '/admin/settings/embeds', { config: { enabled: true, hosts }, reauth: { password: PASSWORD } });
  for (let i = 0; i < 4 && res.status() === 429; i++) {
    await new Promise((r) => setTimeout(r, 15_000));
    res = await api(admin.request, 'PUT', '/admin/settings/embeds', { config: { enabled: true, hosts }, reauth: { password: PASSWORD } });
  }
  expect(res.ok()).toBeTruthy();
  changed = hosts.length > 0;
  await admin.close();
}

async function newPage(browser: Browser, title: string, content?: object) {
  const admin = await adminContext(browser);
  const spaces = (await (await api(admin.request, 'GET', '/spaces')).json()) as { id: string; visibility: string }[];
  const created = await (await api(admin.request, 'POST', '/pages', { spaceId: spaces.find((s) => s.visibility === 'public')!.id, title, ...(content ? { content } : {}) })).json();
  await admin.close();
  return created.id as string;
}

// La ressaisie du mot de passe n'est demandée qu'une fois toutes les dix minutes : d'autres tests de la série l'ont peut-être déjà faite.
async function confirmIfAsked(page: import('@playwright/test').Page) {
  const password = page.getByLabel('Mot de passe', { exact: true });
  if (await password.isVisible({ timeout: 1500 }).catch(() => false)) {
    await password.fill(PASSWORD);
    await page.getByRole('button', { name: 'Confirmer' }).click();
  }
}

test.afterEach(async ({ browser }) => { if (changed) await setHosts(browser, []); });

test('par défaut aucun contenu externe : pas d’entrée dans le menu / et CSP frame-src à none', async ({ page, browser }) => {
  const admin = await adminContext(browser);
  const csp = (await admin.request.get('/healthz')).headers()['content-security-policy'];
  expect(csp).toContain("frame-src 'none'");
  await admin.close();
  const id = await newPage(browser, 'Sans intégration e2e');
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto(`/p/${id}`);
  await page.locator('.prose').click();
  await page.keyboard.type('/adresse');
  await expect(page.locator('.slash-menu')).toBeHidden();
});

test('l’administrateur autorise un hôte, un éditeur l’intègre, le lecteur choisit de l’afficher', async ({ page, browser }) => {
  // Réglage depuis l'écran d'administration (ressaisie du mot de passe).
  const admin = await embedAdmin(browser);
  const adminPage = await admin.newPage();
  await adminPage.goto('/settings/embeds');
  await adminPage.getByRole('textbox', { name: 'Hôtes autorisés' }).fill(`${HOST}\nHTTPS://mauvais.example.test`);
  await adminPage.getByRole('button', { name: 'Enregistrer' }).click();
  await confirmIfAsked(adminPage);
  await expect(adminPage.getByText(/hôte invalide/i)).toBeVisible();
  await adminPage.getByRole('textbox', { name: 'Hôtes autorisés' }).fill(HOST);
  await adminPage.getByRole('button', { name: 'Enregistrer' }).click();
  await confirmIfAsked(adminPage);
  await expect(adminPage.getByText('Hôtes intégrables mis à jour')).toBeVisible();
  changed = true; // à remettre à zéro après le test
  expect((await admin.request.get('/healthz')).headers()['content-security-policy']).toContain(`frame-src https://${HOST}`);
  await admin.close();

  const id = await newPage(browser, 'Intégration e2e');
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto(`/p/${id}`);
  await page.locator('.prose').click();
  await page.keyboard.type('/adresse');
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Intégrer une adresse' });
  // Hôte non autorisé, http et javascript : refusés.
  for (const bad of ['https://autre.example.test/x', `http://${HOST}/x`, 'javascript:alert(1)']) {
    await dialog.getByRole('textbox', { name: 'Adresse à intégrer' }).fill(bad);
    await dialog.getByRole('button', { name: 'Intégrer', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('Adresse refusée');
  }
  await dialog.getByRole('textbox', { name: 'Adresse à intégrer' }).fill(`https://${HOST}/video/42`);
  await dialog.getByRole('button', { name: 'Intégrer', exact: true }).click();

  // Rien n'est contacté tant qu'on n'a pas cliqué.
  await expect(page.locator('.embed-card')).toContainText(`Contenu intégré de ${HOST}`);
  await expect(page.locator('iframe.embed-frame')).toHaveCount(0);
  await page.getByRole('button', { name: 'Afficher le contenu' }).click();
  const frame = page.locator('iframe.embed-frame');
  await expect(frame).toHaveAttribute('src', `https://${HOST}/video/42`);
  await expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
  const sandbox = (await frame.getAttribute('sandbox')) ?? '';
  expect(sandbox.split(' ')).toEqual(expect.arrayContaining(['allow-scripts', 'allow-same-origin']));
  expect(sandbox).not.toContain('allow-top-navigation');
  expect(sandbox).not.toContain('allow-forms');
  expect(sandbox).not.toContain('allow-modals');
});

test('une adresse dont l’hôte n’est (plus) pas autorisé est affichée comme un lien, jamais comme une iframe', async ({ page, browser }) => {
  const id = await newPage(browser, 'Hôte retiré e2e', { type: 'doc', content: [{ type: 'embed', attrs: { url: `https://${HOST}/video/1` } }, { type: 'paragraph', content: [{ type: 'text', text: 'après' }] }] });
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto(`/p/${id}`);
  await expect(page.locator('.embed-card')).toContainText('n’est pas affiché');
  await expect(page.locator('iframe')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Ouvrir ↗' })).toHaveAttribute('rel', /noopener/);
  await expect(page.locator('.prose').getByText('après')).toBeVisible();
});

test('le serveur retire une adresse dangereuse envoyée par l’API', async ({ browser }) => {
  await setHosts(browser, [HOST]);
  const admin = await adminContext(browser);
  const spaces = (await (await api(admin.request, 'GET', '/spaces')).json()) as { id: string; visibility: string }[];
  const content = { type: 'doc', content: ['javascript:alert(1)', 'http://videos.example.test/x', 'https://user:pw@videos.example.test/x', 'https://127.0.0.1/x', `https://${HOST}/ok`].map((url) => ({ type: 'embed', attrs: { url } })) };
  const created = await (await api(admin.request, 'POST', '/pages', { spaceId: spaces[0]!.id, title: 'Dangereux e2e', content })).json();
  expect(JSON.stringify(created.content)).toBe(JSON.stringify({ type: 'doc', content: [{ type: 'embed', attrs: { url: `https://${HOST}/ok` } }] }));
  await admin.close();
});

test('la politique de sécurité bloque une iframe vers un hôte non autorisé, même si une page la contenait', async ({ page, browser }) => {
  await setHosts(browser, [HOST]);
  const id = await newPage(browser, 'CSP e2e');
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto(`/p/${id}`);
  const violation = await page.evaluate(() => new Promise<string>((resolve) => {
    document.addEventListener('securitypolicyviolation', (e) => resolve(`${e.violatedDirective} ${e.blockedURI}`), { once: true });
    const frame = document.createElement('iframe');
    frame.src = 'https://autre.example.test/pirate';
    document.body.append(frame);
    setTimeout(() => resolve('aucune violation'), 5000);
  }));
  expect(violation).toContain('frame-src');
  expect(violation).toContain('autre.example.test');
});
