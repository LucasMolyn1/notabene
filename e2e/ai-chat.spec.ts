// Panneau de l'assistant (chat IA avec historique). Les routes /ai/* sont simulées par interception :
// le serveur de test n'a pas de fournisseur d'IA, et l'interface ne doit dépendre que du contrat d'API.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';
import { ADMIN } from './accounts';
import { loginUi } from './helpers';

test.use({ reducedMotion: 'reduce' });

type Msg = { id: string; role: 'user' | 'assistant'; content: string; sources: { id: string; title: string }[]; createdAt: number };
type Conv = { id: string; title: string; pageId: string | null; createdAt: number; updatedAt: number; messages: Msg[] };

const SOURCE = { id: 'srcpage00001', title: 'Guide de connexion', spaceId: 'space0000001' };

const sse = (events: [string, unknown][]) => events.map(([e, d]) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`).join('');

// La personne a le droit d'utiliser l'IA (ou non) : seule la réponse de /me change.
async function allowAi(page: Page, ai = true) {
  await page.route('**/api/v3/me', async (route) => {
    const res = await route.fetch();
    const json = await res.json();
    json.permissions = { ...json.permissions, ai };
    await route.fulfill({ response: res, json });
  });
}

// Faux serveur de conversations : garde l'état en mémoire pour le test.
function fakeConversations(page: Page, initial: Conv[] = []) {
  const convs = [...initial];
  const chatBodies: Record<string, unknown>[] = [];
  let chatReply: (route: Route, body: Record<string, unknown>) => Promise<void> = async (route, body) => {
    let conv = convs.find((c) => c.id === body.conversationId);
    if (!conv) {
      conv = { id: `conv${String(convs.length + 1).padStart(8, '0')}`, title: String(body.message).slice(0, 40), pageId: (body.pageId as string) ?? null, createdAt: Date.now(), updatedAt: Date.now(), messages: [] };
      convs.unshift(conv);
    }
    const answer = 'Voici **la** réponse [1].\n- premier point\n- second point <img src=x onerror="window.__xss=1">';
    conv.messages.push({ id: `m${conv.messages.length}`, role: 'user', content: String(body.message), sources: [], createdAt: Date.now() });
    conv.messages.push({ id: `m${conv.messages.length}`, role: 'assistant', content: answer, sources: [SOURCE], createdAt: Date.now() });
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: sse([['conversation', { id: conv.id, title: conv.title }], ['sources', [SOURCE]], ['delta', { text: 'Voici **la** ' }], ['delta', { text: 'réponse [1].\n- premier point\n' }], ['delta', { text: '- second point <img src=x onerror="window.__xss=1">' }], ['done', {}]]),
    });
  };
  page.route('**/api/v3/ai/chat', async (route) => {
    const body = route.request().postDataJSON();
    chatBodies.push(body);
    await chatReply(route, body);
  });
  page.route((url) => url.pathname === '/api/v3/ai/conversations' || url.pathname.startsWith('/api/v3/ai/conversations/'), async (route) => {
    const req = route.request();
    const id = /\/conversations\/([^/?]+)/.exec(req.url())?.[1];
    if (req.method() === 'GET' && !id) {
      await route.fulfill({ json: { items: convs.map(({ messages, ...c }) => ({ ...c, messageCount: messages.length })), nextCursor: null } });
    } else if (req.method() === 'GET') {
      const c = convs.find((x) => x.id === id);
      await route.fulfill(c ? { json: c } : { status: 404, json: { detail: 'Conversation introuvable' } });
    } else if (req.method() === 'DELETE' && id) {
      convs.splice(convs.findIndex((x) => x.id === id), 1);
      await route.fulfill({ status: 204, body: '' });
    } else if (req.method() === 'DELETE') {
      const deleted = convs.length;
      convs.length = 0;
      await route.fulfill({ json: { deleted } });
    } else await route.fallback();
  });
  return { convs, chatBodies, onChat: (fn: typeof chatReply) => { chatReply = fn; } };
}

async function openWelcome(page: Page) {
  await loginUi(page, ADMIN.email, ADMIN.password);
  const id = await page.getByRole('treeitem', { name: 'Bienvenue sur BeNote' }).getAttribute('data-id');
  await page.goto(`/p/${id}`); // sur téléphone, la barre latérale est repliée
  await page.locator('.prose').first().waitFor();
  return id!;
}

const panel = (page: Page) => page.getByRole('dialog', { name: /Assistant|Comment/ });

test('sans droit IA, pas de bouton Assistant ni de raccourci', async ({ page }) => {
  await allowAi(page, false);
  await openWelcome(page);
  await expect(page.getByRole('button', { name: 'Assistant', exact: true })).toHaveCount(0);
  await page.keyboard.press('Alt+i');
  await expect(page.locator('#ai-chat')).toHaveCount(0);
});

test('ouverture, focus, Échap, raccourci Alt+I', async ({ page }) => {
  await allowAi(page);
  fakeConversations(page);
  await openWelcome(page);
  const launcher = page.getByRole('button', { name: 'Assistant', exact: true });
  await launcher.click();
  await expect(panel(page)).toBeVisible();
  await expect(launcher).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByLabel('Votre message')).toBeFocused();
  await expect(panel(page)).toContainText('peuvent être inexactes');
  await expect(panel(page)).toContainText('gardé 90 jours');
  await page.keyboard.press('Escape');
  await expect(page.locator('#ai-chat')).toBeHidden();
  await expect(launcher).toBeFocused();
  await expect(launcher).toHaveAttribute('aria-expanded', 'false');
  await page.locator('.prose').first().click();
  await page.keyboard.press('Alt+i');
  await expect(page.getByLabel('Votre message')).toBeFocused();
  await page.getByRole('button', { name: 'Fermer l’assistant' }).click();
  await expect(page.locator('#ai-chat')).toBeHidden();
});

test('envoi, diffusion, rendu sûr, sources, contexte de page, suite de conversation', async ({ page }) => {
  await allowAi(page);
  const fake = fakeConversations(page);
  const pageId = await openWelcome(page);
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  const input = page.getByLabel('Votre message');
  const ctx = page.getByLabel(/Utiliser la page ouverte comme contexte/);
  await expect(ctx).toBeChecked();
  await expect(page.locator('.ai-chat-count')).toHaveText('0 / 4000');

  // Maj+Entrée : nouvelle ligne ; Entrée : envoi.
  await input.fill('Comment se connecter');
  await input.press('Shift+Enter');
  await input.pressSequentially('avec Authentik ?');
  await expect(input).toHaveValue('Comment se connecter\navec Authentik ?');
  await expect(page.locator('.ai-chat-count')).toHaveText('37 / 4000');
  await input.press('Enter');

  const log = page.getByRole('group', { name: 'Conversation' });
  await expect(log.locator('.ai-msg-user')).toHaveText(/Comment se connecter\s+avec Authentik/);
  const answer = log.locator('.ai-msg-assistant').last();
  await expect(answer).toContainText('Voici la réponse');
  await expect(answer.locator('strong')).toHaveText('la');
  await expect(answer.locator('.ai-msg-body li')).toHaveCount(2);
  // Le HTML du modèle reste du texte.
  await expect(answer).toContainText('<img src=x');
  expect(await answer.locator('img').count()).toBe(0);
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  // Citation et liste des sources : liens vers la page.
  await expect(answer.locator('a.cite')).toHaveAttribute('href', /\/p\/guide-de-connexion-srcpage00001$/);
  await expect(answer.getByRole('navigation', { name: 'Sources' }).getByRole('link', { name: /Guide de connexion/ })).toHaveAttribute('href', /srcpage00001$/);
  await expect(page.locator('#ai-chat-title')).toHaveText('Comment se connecter\navec Authentik ?'.slice(0, 40));
  await expect(input).toHaveValue('');

  expect(fake.chatBodies[0]).toEqual({ message: 'Comment se connecter\navec Authentik ?', pageId });

  // Deuxième message, case décochée : même conversation, sans page.
  await ctx.uncheck();
  await input.fill('Et avec LDAP ?');
  await page.getByRole('button', { name: 'Envoyer' }).click();
  await expect(log.locator('.ai-msg-user')).toHaveCount(2);
  await expect(log.locator('.ai-msg-assistant')).toHaveCount(2);
  expect(fake.chatBodies[1]).toEqual({ message: 'Et avec LDAP ?', conversationId: fake.convs[0]!.id });

  // Clic sur une source : navigation vers la page (panneau resté ouvert sur grand écran).
  await answer.getByRole('navigation', { name: 'Sources' }).getByRole('link').click();
  await expect(page).toHaveURL(/\/p\/(guide-de-connexion-)?srcpage00001$/);
});

test('historique : rouvrir, supprimer avec confirmation, tout supprimer', async ({ page }) => {
  await allowAi(page);
  const now = Date.now();
  const conv = (id: string, title: string, minutes: number): Conv => ({
    id, title, pageId: null, createdAt: now - minutes * 60_000, updatedAt: now - minutes * 60_000,
    messages: [
      { id: `${id}-1`, role: 'user', content: `Question ${title}`, sources: [], createdAt: now },
      { id: `${id}-2`, role: 'assistant', content: `Réponse **${title}** [1]`, sources: [SOURCE], createdAt: now },
    ],
  });
  const fake = fakeConversations(page, [conv('conv00000001', 'Sauvegardes', 5), conv('conv00000002', 'Jetons d’API', 120)]);
  await openWelcome(page);
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  await page.getByRole('button', { name: 'Conversations récentes' }).click();
  const list = page.getByRole('list', { name: 'Conversations récentes' });
  await expect(list.getByRole('listitem')).toHaveCount(2);
  await expect(list.getByRole('listitem').first()).toContainText('Sauvegardes');
  await expect(list.getByRole('listitem').first()).toContainText('2 messages');

  // Rouvrir.
  await list.getByRole('button', { name: /^Jetons d’API/ }).click();
  await expect(page.locator('#ai-chat-title')).toHaveText('Jetons d’API');
  const log = page.getByRole('group', { name: 'Conversation' });
  await expect(log.locator('.ai-msg-user .ai-msg-text')).toHaveText('Question Jetons d’API');
  await expect(log.locator('.ai-msg-assistant strong')).toHaveText('Jetons d’API');
  await expect(log.getByRole('link', { name: /Guide de connexion/ })).toBeVisible();

  // Supprimer : annuler puis confirmer.
  await page.getByRole('button', { name: 'Conversations récentes' }).click();
  await list.getByRole('button', { name: 'Supprimer la conversation « Sauvegardes »' }).click();
  await page.getByRole('dialog', { name: 'Supprimer la conversation' }).getByRole('button', { name: 'Annuler' }).click();
  await expect(list.getByRole('listitem')).toHaveCount(2);
  await list.getByRole('button', { name: 'Supprimer la conversation « Sauvegardes »' }).click();
  await page.getByRole('dialog', { name: 'Supprimer la conversation' }).getByRole('button', { name: 'Supprimer' }).click();
  await expect(list.getByRole('listitem')).toHaveCount(1);
  expect(fake.convs.map((c) => c.id)).toEqual(['conv00000002']);

  // Tout supprimer : la conversation affichée disparaît aussi.
  await page.getByRole('button', { name: 'Tout supprimer' }).click();
  await page.getByRole('dialog', { name: 'Supprimer tout l’historique' }).getByRole('button', { name: 'Tout supprimer' }).click();
  await expect(list).toContainText('Aucune conversation');
  await expect(page.locator('.toast').filter({ hasText: '1 conversation supprimée.' })).toBeVisible();
  await expect(page.locator('#ai-chat-title')).toHaveText('Assistant');
  expect(fake.convs).toHaveLength(0);
});

test('erreurs 503, 429, 409 : messages lisibles, message remis dans la zone de saisie', async ({ page }) => {
  await allowAi(page);
  const fake = fakeConversations(page);
  let status = 503;
  fake.onChat(async (route) => { await route.fulfill({ status, json: { detail: `Erreur ${status}` } }); });
  await openWelcome(page);
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  const input = page.getByLabel('Votre message');
  const alerts = page.locator('#ai-chat [role="alert"]');

  await input.fill('Question 1');
  await input.press('Enter');
  await expect(alerts.last()).toContainText('l’IA n’est pas configurée');
  await expect(input).toHaveValue('Question 1');

  status = 429;
  await input.press('Enter');
  await expect(alerts.last()).toContainText('Trop de demandes');

  status = 409;
  await input.press('Enter');
  await expect(alerts.last()).toContainText('limite de messages');
  await alerts.last().getByRole('button', { name: 'Nouvelle conversation' }).click();
  await expect(page.getByRole('group', { name: 'Conversation' }).locator('.ai-msg')).toHaveCount(0);
  await expect(input).toBeFocused();
});

test('bouton Arrêter : interrompt le flux', async ({ page }) => {
  await allowAi(page);
  const fake = fakeConversations(page);
  let pending: Route | null = null;
  fake.onChat(async (route) => { pending = route; }); // la réponse ne vient jamais
  await openWelcome(page);
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  await page.getByLabel('Votre message').fill('Longue question');
  await page.getByLabel('Votre message').press('Enter');
  const stop = page.getByRole('button', { name: 'Arrêter' });
  await expect(stop).toBeVisible();
  await expect(page.getByRole('button', { name: 'Envoyer' })).toBeDisabled();
  await stop.click();
  await expect(page.locator('#ai-chat .ai-msg-assistant')).toContainText('Réponse interrompue.');
  await expect(stop).toBeHidden();
  await expect(page.getByRole('button', { name: 'Envoyer' })).toBeEnabled();
  await expect(page.getByLabel('Votre message')).toBeFocused();
  await (pending as Route | null)?.abort().catch(() => undefined);
});

test.describe('sur téléphone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('panneau plein écran, reste de l’application inerte', async ({ page }) => {
    await allowAi(page);
    fakeConversations(page);
    await openWelcome(page);
    await page.getByRole('button', { name: 'Assistant', exact: true }).click();
    const box = await page.locator('#ai-chat').boundingBox();
    expect(box?.width).toBe(390);
    await expect(page.locator('#app')).toHaveAttribute('inert', '');
    await page.getByRole('button', { name: 'Fermer l’assistant' }).click();
    await expect(page.locator('#app')).not.toHaveAttribute('inert', '');
  });
});

for (const scheme of ['light', 'dark'] as const) {
  test(`accessibilité du panneau, thème ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await allowAi(page);
    fakeConversations(page);
    await openWelcome(page);
    await page.getByRole('button', { name: 'Assistant', exact: true }).click();
    await page.getByLabel('Votre message').fill('Comment se connecter ?');
    await page.getByLabel('Votre message').press('Enter');
    await expect(page.locator('#ai-chat .ai-chat-sources')).toBeVisible();
    const found: string[] = [];
    const run = async (label: string) => {
      const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      found.push(...r.violations.map((v) => `${label} | ${v.id} | ${v.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(' ; ')}`));
    };
    await run('conversation');
    await page.getByRole('button', { name: 'Conversations récentes' }).click();
    await expect(page.getByRole('list', { name: 'Conversations récentes' }).getByRole('listitem')).toHaveCount(1);
    await run('historique');
    expect(found).toEqual([]);
  });
}
