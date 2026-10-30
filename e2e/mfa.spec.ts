import { expect, test } from '@playwright/test';
import { adminContext, createLocalUser, loginUi, PASSWORD, totp } from './helpers';

test('active la double authentification puis se reconnecte avec le code', async ({ browser, page }) => {
  const admin = await adminContext(browser);
  await createLocalUser(admin.request, 'mfa.user@e2e.test', 'Utilisateur MFA', 'editor');

  await loginUi(page, 'mfa.user@e2e.test', PASSWORD);
  await page.goto('/#/settings/profile');
  await page.getByRole('button', { name: 'Activer' }).click();
  // Le secret est affiché pour la saisie manuelle.
  const secret = (await page.locator('p.hint code').first().innerText()).trim();
  expect(secret).toMatch(/^[A-Z2-7]{16,}$/);
  await page.getByLabel('Code de vérification').fill(totp(secret));
  await page.getByRole('button', { name: 'Activer', exact: true }).click();
  await expect(page.getByText('Double authentification activée')).toBeVisible();
  await expect(page.locator('pre.code-sample')).toContainText('-'); // codes de secours
  await page.getByRole('button', { name: 'J’ai enregistré ces codes' }).click();

  // Nouvelle connexion : le mot de passe seul ne suffit plus.
  const second = await browser.newContext();
  const p2 = await second.newPage();
  await p2.goto('http://localhost:3100/?login');
  await p2.getByLabel('Adresse e-mail').fill('mfa.user@e2e.test');
  await p2.getByLabel('Mot de passe', { exact: true }).fill(PASSWORD);
  await p2.getByRole('button', { name: 'Se connecter' }).click();
  await expect(p2.getByLabel('Code de vérification')).toBeVisible();
  // Un mauvais code est refusé.
  await p2.getByLabel('Code de vérification').fill('000000');
  await p2.getByRole('button', { name: 'Se connecter' }).click();
  await expect(p2.getByText('Identifiants invalides')).toBeVisible();
  // Le bon code (pas de suivant : le pas courant a servi à l'activation, le rejeu est refusé).
  await p2.getByLabel('Code de vérification').fill(totp(secret, 1));
  await p2.getByRole('button', { name: 'Se connecter' }).click();
  await expect(p2.getByText('Bienvenue sur Notabene').first()).toBeVisible();
  await second.close();
  await admin.close();
});
