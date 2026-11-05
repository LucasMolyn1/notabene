import { expect, test } from '@playwright/test';
import { ADMIN } from './accounts';
import { loginUi } from './helpers';

// Écran bas : le menu des paramètres défile seul (il reste en place pendant que la page défile), jusqu'à sa dernière entrée.
test('paramètres : le menu défile indépendamment de la page', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 520 });
  await loginUi(page, ADMIN.email, ADMIN.password);
  await page.goto('/settings');
  const nav = page.locator('.set-nav');
  await expect(nav).toBeVisible();
  const m = await nav.evaluate((el) => ({ scrollable: el.scrollHeight > el.clientHeight, overflowY: getComputedStyle(el).overflowY, h: el.clientHeight }));
  expect(m.overflowY).toBe('auto');
  expect(m.scrollable).toBe(true);
  expect(m.h).toBeLessThan(520);
  await nav.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(nav.locator('.set-nav-item').last()).toBeInViewport();
});
