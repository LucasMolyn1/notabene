import { expect, test, type Browser, type Page } from '@playwright/test';
import { ADMIN } from './accounts';
import { adminContext, api, loginUi } from './helpers';

// L'infrastructure e2e n'a pas de SMTP : les cas qui en dépendent simulent les réponses du serveur (page.route),
// le reste passe par le vrai serveur.

test('préférences : les deux cases de tâches s’affichent, désactivées et expliquées sans SMTP', async ({ page }) => {
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto('/settings/account');
  await expect(page.getByText('L’envoi d’e-mails n’est pas configuré par votre administrateur', { exact: false })).toBeVisible();
  const tasks = page.getByLabel('Être prévenu par e-mail quand une tâche m’est attribuée ou passe en retard');
  const summary = page.getByLabel('Recevoir un résumé de mes tâches chaque lundi matin');
  await expect(tasks).toBeDisabled();
  await expect(summary).toBeDisabled();
  // Défauts du contrat : tâches activées, résumé désactivé.
  await expect(tasks).toBeChecked();
  await expect(summary).not.toBeChecked();
});

test('préférences : avec SMTP, cocher le résumé enregistre les quatre valeurs', async ({ page }) => {
  let prefs = { emailComments: true, emailChanges: false, emailTasks: true, emailSummary: false, emailAvailable: true };
  let sent: Record<string, unknown> | null = null;
  await page.route('**/api/v3/notifications/preferences', async (route) => {
    if (route.request().method() === 'PUT') {
      sent = route.request().postDataJSON();
      prefs = { ...prefs, ...(sent as object) };
    }
    await route.fulfill({ json: prefs });
  });
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto('/settings/account');
  const summary = page.getByLabel('Recevoir un résumé de mes tâches chaque lundi matin');
  await expect(summary).toBeEnabled();
  await summary.focus();
  await page.keyboard.press('Space');
  await expect(page.getByText('Préférences enregistrées')).toBeVisible();
  expect(sent).toEqual({ emailComments: true, emailChanges: false, emailTasks: true, emailSummary: true });
  await expect(summary).toBeChecked();
});

async function makeSpace(browser: Browser, name: string) {
  const admin = await adminContext(browser);
  expect((await api(admin.request, 'PUT', '/admin/sharing', { enabled: true })).ok()).toBeTruthy();
  expect((await api(admin.request, 'PUT', '/admin/sharing/spaces', { enabled: true })).ok()).toBeTruthy();
  const space = await (await api(admin.request, 'POST', '/spaces', { name, visibility: 'private' })).json();
  await admin.close();
  return space as { id: string };
}

async function openDialog(page: Page, spaceId: string) {
  await page.goto(`/s/${spaceId}`);
  await page.locator('.space-switch').click();
  await page.getByRole('menuitem', { name: 'Partager l’espace par lien' }).click();
  return page.getByRole('dialog', { name: 'Partager l’espace par lien' });
}

test.describe('envoi du lien d’espace par e-mail', () => {
  test.afterAll(async ({ browser }) => {
    const admin = await adminContext(browser);
    await api(admin.request, 'PUT', '/admin/sharing/spaces/mail', { enabled: false });
    await api(admin.request, 'PUT', '/admin/sharing/spaces', { enabled: false });
    await api(admin.request, 'PUT', '/admin/sharing', { enabled: false });
    await admin.close();
  });

  test('sans SMTP, le champ e-mail est absent et l’administration l’explique', async ({ page, browser }) => {
    const space = await makeSpace(browser, 'Espace mail absent e2e');
    await loginUi(page, ADMIN.email, ADMIN.password);
    await page.goto('/settings/shares');
    const toggle = page.getByLabel('Autoriser l’envoi du lien d’espace par e-mail');
    await expect(toggle).not.toBeChecked();
    await expect(page.getByText('l’activation reste sans effet', { exact: false })).toBeVisible();
    await toggle.check({ force: true });
    await expect(page.getByText('sans effet tant que le partage d’espaces et le SMTP ne sont pas actifs', { exact: false })).toBeVisible();
    await expect(page.getByLabel('Autoriser l’envoi du lien d’espace par e-mail')).toBeChecked();

    const dialog = await openDialog(page, space.id);
    await expect(dialog.getByLabel('Libellé (facultatif)')).toBeVisible();
    await expect(dialog.getByLabel('Envoyer le lien par e-mail à (facultatif)')).toHaveCount(0);
  });

  test('avec SMTP simulé : validation, envoi, échec d’envoi et refus', async ({ page, browser }) => {
    const space = await makeSpace(browser, 'Espace mail simulé e2e');
    const ADDRESS = 'client.e2e@exemple.test';
    // Liste réelle, augmentée de mailAvailable ; création simulée selon le scénario courant.
    let scenario: 'sent' | 'failed' | 429 | 403 = 'sent';
    let lastBody: Record<string, unknown> | null = null;
    await page.route(`**/api/v3/spaces/${space.id}/shares`, async (route) => {
      const req = route.request();
      if (req.method() === 'GET') {
        const res = await route.fetch();
        await route.fulfill({ response: res, json: { ...(await res.json()), mailAvailable: true } });
        return;
      }
      lastBody = req.postDataJSON();
      const base = { id: 'x'.repeat(21), label: '', url: `http://localhost:3100/share/${'a'.repeat(43)}`, createdAt: Date.now(), expiresAt: null };
      if (scenario === 'sent') await route.fulfill({ status: 201, json: { ...base, mailSent: true } });
      else if (scenario === 'failed') await route.fulfill({ status: 201, json: { ...base, mailSent: false, mailError: 'L’e-mail n’a pas pu être envoyé ; transmettez le lien vous-même.' } });
      else await route.fulfill({ status: scenario, contentType: 'application/problem+json', json: { status: scenario, detail: 'refus' } });
    });
    const logs: string[] = [];
    page.on('console', (m) => logs.push(m.text()));
    await loginUi(page, ADMIN.email, ADMIN.password);
    const dialog = await openDialog(page, space.id);
    const email = dialog.getByLabel('Envoyer le lien par e-mail à (facultatif)');
    await expect(email).toHaveAttribute('type', 'email');
    await expect(email).toHaveAttribute('autocomplete', 'off');
    await expect(dialog.getByText('Seul le lien est envoyé, jamais le contenu des pages.', { exact: false })).toBeVisible();

    // Validation côté client : deux adresses refusées, rien n'est envoyé.
    await email.fill('a@exemple.test, b@exemple.test');
    await email.press('Enter');
    await expect(dialog.getByText('Saisissez une seule adresse e-mail valide', { exact: false })).toBeVisible();
    await expect(email).toHaveAttribute('aria-invalid', 'true');
    await expect(email).toBeFocused();
    expect(lastBody).toBeNull();

    // Envoi réussi : le lien reste affiché et copiable, l'adresse n'est plus visible.
    await email.fill(ADDRESS);
    await email.press('Enter');
    await expect(dialog.getByText('E-mail envoyé.')).toBeVisible();
    expect(lastBody).toEqual({ notifyEmail: ADDRESS });
    await expect(dialog.getByLabel('Nouveau lien', { exact: true })).toBeFocused();
    await expect(dialog.getByRole('button', { name: 'Copier le lien' })).toBeVisible();
    await expect(dialog.getByLabel('Envoyer le lien par e-mail à (facultatif)')).toHaveValue('');
    await expect(dialog).not.toContainText(ADDRESS);

    // Échec SMTP : lien créé, message d'avertissement.
    scenario = 'failed';
    await dialog.getByLabel('Envoyer le lien par e-mail à (facultatif)').fill(ADDRESS);
    await dialog.getByRole('button', { name: 'Créer un lien' }).click();
    await expect(dialog.getByText('Le lien est créé mais l’e-mail n’a pas pu être envoyé', { exact: false })).toBeVisible();
    await expect(dialog.getByLabel('Nouveau lien', { exact: true })).toHaveValue(/\/share\//);

    // Limite atteinte : aucun lien créé, message en français.
    scenario = 429;
    await dialog.getByLabel('Envoyer le lien par e-mail à (facultatif)').fill(ADDRESS);
    await dialog.getByRole('button', { name: 'Créer un lien' }).click();
    await expect(dialog.getByRole('alert').filter({ hasText: 'Trop d’envois de liens par e-mail' })).toContainText('Aucun lien n’a été créé.');

    scenario = 403;
    await dialog.getByLabel('Envoyer le lien par e-mail à (facultatif)').fill(ADDRESS);
    await dialog.getByRole('button', { name: 'Créer un lien' }).click();
    await expect(dialog.getByRole('alert').filter({ hasText: 'n’est pas activé sur cette instance' })).toBeVisible();
    await expect(dialog).not.toContainText(ADDRESS);
    expect(logs.some((l) => l.includes(ADDRESS))).toBe(false);
  });
});
