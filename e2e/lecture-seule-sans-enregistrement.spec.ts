// Un lecteur qui ouvre une page ne déclenche aucun enregistrement : pas de requête PATCH, pas de « Échec de l'enregistrement ».
// Le contenu est posé par l'API (liste de tâches, bloc de code, tableau) : l'éditeur peut le remettre en forme à l'ouverture,
// et cette remise en forme ne doit jamais partir vers le serveur (refusée en 403 pour un lecteur).
import { expect, test } from '@playwright/test';
import { adminContext, api, createLocalUser, PASSWORD, sessionContext } from './helpers';

const READER = { email: 'lecteur.sans.sauvegarde@e2e.test', name: 'Lecteur Sans Sauvegarde' };
const text = (t: string) => ({ type: 'text', text: t });
const para = (t: string) => ({ type: 'paragraph', content: [text(t)] });

test('lecteur : ouvrir une page ne tente aucun enregistrement', async ({ browser }) => {
  const admin = await adminContext(browser);
  await createLocalUser(admin.request, READER.email, READER.name, 'reader');
  const spaces = (await (await api(admin.request, 'GET', '/spaces')).json()) as { id: string; visibility: string }[];
  const spaceId = spaces.find((s) => s.visibility === 'public')!.id;
  const content = {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 1 }, content: [text('Page posée par l’API')] },
      para('Un paragraphe.'),
      { type: 'bulletList', content: [{ type: 'listItem', content: [para('Un point')] }] },
      { type: 'codeBlock', attrs: { language: 'bash' }, content: [text('systemctl status service')] },
      { type: 'taskList', content: [{ type: 'taskItem', attrs: { checked: false }, content: [para('Une tâche')] }] },
    ],
  };
  const created = await api(admin.request, 'POST', '/pages', { spaceId, title: 'Lecture seule sans sauvegarde', content });
  expect(created.ok()).toBeTruthy();
  const { id } = await created.json();

  const reader = await sessionContext(browser, READER.email, PASSWORD);
  const page = await reader.newPage();
  const writes: string[] = [];
  page.on('request', (r) => { if (r.method() !== 'GET' && /\/api\/v3\/pages\//.test(r.url())) writes.push(`${r.method()} ${new URL(r.url()).pathname}`); });
  await page.goto(`/p/${id}`);
  await expect(page.locator('.ProseMirror')).toContainText('Un paragraphe.');
  await page.waitForTimeout(2500); // l'enregistrement différé part après 600 ms : on laisse largement le temps
  expect(writes).toEqual([]);
  await expect(page.locator('[data-state="error"]')).toHaveCount(0);
  await reader.close();
});
