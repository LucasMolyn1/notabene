import { expect, test } from '@playwright/test';
import { adminContext, api, createLocalUser, PASSWORD, sessionContext } from './helpers';

test('une page restreinte est invisible pour un autre utilisateur', async ({ browser }) => {
  const admin = await adminContext(browser);
  await createLocalUser(admin.request, 'secret.keeper@e2e.test', 'Gardien', 'editor');
  await createLocalUser(admin.request, 'curious.person@e2e.test', 'Curieux', 'editor');
  const users = (await (await api(admin.request, 'GET', '/admin/users')).json()) as { id: string; email: string }[];
  const keeper = users.find((u) => u.email === 'secret.keeper@e2e.test')!;
  const pages = ((await (await api(admin.request, 'GET', '/pages?limit=200')).json()) as { items: { id: string; title: string }[] }).items;
  const target = pages.find((p) => p.title === 'Onboarding')!;
  const child = pages.find((p) => p.title === 'Process de déploiement')!;
  expect((await api(admin.request, 'PUT', `/pages/${target.id}/permissions`, { entries: [{ userId: keeper.id, level: 'write' }] })).ok()).toBeTruthy();

  // Le curieux ne voit ni la page, ni sa sous-page, ni dans la recherche.
  const curious = await sessionContext(browser, 'curious.person@e2e.test', PASSWORD);
  const page = await curious.newPage();
  await page.goto('/');
  await expect(page.getByText('Bienvenue sur Notabene').first()).toBeVisible();
  await page.goto(`/#/p/${target.id}`);
  await expect(page.getByText('Page introuvable')).toBeVisible();
  await page.goto(`/#/p/${child.id}`);
  await expect(page.getByText('Page introuvable')).toBeVisible();
  const list = JSON.stringify(await (await api(curious.request, 'GET', '/pages?limit=200')).json());
  expect(list).not.toContain('Onboarding');
  const search = JSON.stringify(await (await api(curious.request, 'GET', '/search?q=onboarding')).json());
  expect(search).not.toContain('Onboarding');

  // Le gardien et l'administrateur la voient.
  const keeperCtx = await sessionContext(browser, 'secret.keeper@e2e.test', PASSWORD);
  expect((await api(keeperCtx.request, 'GET', `/pages/${target.id}`)).status()).toBe(200);
  expect((await api(admin.request, 'GET', `/pages/${target.id}`)).status()).toBe(200);
  // Le curieux ne peut pas se l'attribuer.
  expect((await api(curious.request, 'PUT', `/pages/${target.id}/permissions`, { entries: [] })).status()).toBe(403);

  // On lève la restriction : le curieux revoit la page.
  await api(admin.request, 'PUT', `/pages/${target.id}/permissions`, { entries: [] });
  expect((await api(curious.request, 'GET', `/pages/${target.id}`)).status()).toBe(200);
  await Promise.all([admin.close(), curious.close(), keeperCtx.close()]);
});
