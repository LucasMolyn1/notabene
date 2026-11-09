import { expect, test } from '@playwright/test';
import { ADMIN } from './accounts';
import { loginUi } from './helpers';

// Le sélecteur d'icône s'ouvre dans la boîte de dialogue (couche supérieure), pas derrière elle, et reste utilisable.
test('le choix de l’icône d’un espace s’affiche devant la boîte de dialogue et s’applique', async ({ page }) => {
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto('/settings/spaces');
  await page.getByRole('button', { name: 'Nouvel espace' }).click();
  const dialog = page.getByRole('dialog');
  const button = dialog.getByRole('button', { name: 'Choisir l’icône de l’espace' });
  const before = await button.innerHTML();
  await button.click();
  const picker = page.locator('.emoji-picker');
  await expect(picker).toBeVisible();
  expect(await picker.evaluate((el) => !!el.closest('dialog[open]'))).toBe(true);
  // Cliquable : un choix est pris en compte, le sélecteur se referme et le bouton change d'icône.
  await picker.locator('.emoji-btn').first().click();
  await expect(picker).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect.poll(() => button.innerHTML()).not.toBe(before);
});

test('la case du partage public et son explication ne se collent pas', async ({ page }) => {
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto('/settings/spaces');
  await page.getByRole('button', { name: 'Nouvel espace' }).click();
  const hint = page.getByRole('dialog').getByText('Décocher retire les liens publics existants de cet espace.');
  expect(await hint.evaluate((el) => getComputedStyle(el).display)).toBe('block');
});
