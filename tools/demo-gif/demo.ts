// GIF de démonstration de Notabene : serveur local sur une base neuve, parcours Playwright filmé, conversion ffmpeg.
// Hors CI : ce dossier n'est pas dans le testDir des e2e. Lancement : npm run demo:gif (option : -- --avec-ia).
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Locator, type Page } from '@playwright/test';
import { api, createLocalUser, PASSWORD } from '../../e2e/helpers';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'tools', 'demo-gif', 'out');
const WORK = join(tmpdir(), 'notabene-demo-gif');
const PORT = 3200;
const BASE = `http://localhost:${PORT}`;
const AVEC_IA = process.argv.includes('--avec-ia');
// Fournisseur IA de démonstration (compatible OpenAI) : la clé vient de l'environnement du poste, jamais d'un fichier du dépôt.
const IA = { cle: process.env.DEMO_IA_CLE ?? '', url: process.env.DEMO_IA_URL ?? 'https://ollama.com/v1', modele: process.env.DEMO_IA_MODELE ?? 'beam' };
if (AVEC_IA && !IA.cle) throw new Error('--avec-ia demande la variable DEMO_IA_CLE (et au besoin DEMO_IA_URL, DEMO_IA_MODELE).');

// Comptes de démonstration : noms fictifs, domaine réservé aux tests, mot de passe administrateur tiré à chaque lancement.
const ADMIN = { email: 'camille@demo.test', name: 'Camille Durand', password: randomBytes(18).toString('base64url') };
const COLLEGUE = { email: 'lea@demo.test', name: 'Léa Bernard' };

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- Serveur ----------

function demarrerServeur(): ChildProcess {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(join(WORK, 'data'), { recursive: true });
  // Environnement minimal : aucune variable du poste (clés d'IA, adresses) ne passe au serveur.
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: WORK,
    NODE_ENV: 'production',
    ALLOW_INSECURE_HTTP: 'true',
    HOST: '127.0.0.1',
    PORT: String(PORT),
    PUBLIC_URL: BASE,
    DATA_DIR: join(WORK, 'data'),
    ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    AUTH_LOCAL: 'true',
    COLLAB_ENABLED: 'true',
    LOG_LEVEL: 'warn',
    // Contenu propre au script, pas celui de l'amorçage par défaut.
    SEED_DEMO: 'false',
  };
  const admin = spawnSync('node', ['dist/server/cli.js', 'create-admin', ADMIN.email, '--name', ADMIN.name], {
    cwd: ROOT, env: { ...env, NOTABENE_ADMIN_PASSWORD: ADMIN.password }, stdio: 'inherit',
  });
  if (admin.status !== 0) throw new Error('Création de l’administrateur impossible (le build est-il fait ?)');
  return spawn('node', ['dist/server/index.js'], { cwd: ROOT, env, stdio: 'inherit' });
}

async function attendreServeur() {
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) return; } catch { /* pas encore prêt */ }
    await pause(500);
  }
  throw new Error('Le serveur de démonstration ne répond pas.');
}

// ---------- Données de démonstration (par l'API, hors film) ----------

const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const doc = (...content: object[]) => ({ type: 'doc', content });

async function preparerDonnees(browser: Browser) {
  const ctx = await browser.newContext({ baseURL: BASE });
  const login = await ctx.request.post('/auth/local/login', { data: { email: ADMIN.email, password: ADMIN.password } });
  if (!login.ok()) throw new Error('Connexion administrateur refusée');
  const r = ctx.request;
  await createLocalUser(r, COLLEGUE.email, COLLEGUE.name, 'editor');
  await api(r, 'PUT', '/admin/sharing', { enabled: true });
  if (AVEC_IA) {
    const res = await api(r, 'PUT', '/admin/ai', { enabled: true, provider: 'openai', baseUrl: IA.url, model: IA.modele, apiKey: IA.cle, reauth: { password: ADMIN.password } });
    if (!res.ok()) throw new Error(`Réglage du fournisseur IA refusé (${res.status()})`);
  }

  const space = await (await api(r, 'POST', '/spaces', { name: 'Équipe Produit', icon: 'folder', description: 'Espace de travail de l’équipe produit.', visibility: 'private', access: 'everyone' })).json();
  const page = async (title: string, icon: string, parentId: string | null, content?: object) =>
    (await (await api(r, 'POST', '/pages', { spaceId: space.id, parentId, title, icon, ...(content ? { content } : {}) })).json()).id as string;

  const accueil = await page('Accueil de l’équipe', 'star', null, doc(para('Bienvenue dans l’espace de l’équipe produit : guides, notes de réunion et feuille de route.'), para('')));
  const guides = await page('Guides', 'compass', null, doc(para('Les procédures de l’équipe.')));
  const cible = await page('Mise en production', 'upload', guides, doc(
    para('Dans cette page y a la description de comment on fait pour mettre en production une nouvelle version.'),
    para('Préparer la version, vérifier la CI, puis déployer en recette.'),
    para(''),
  ));
  await page('Sauvegardes et restauration', 'file', guides);
  await page('Conventions de code', 'code', guides);
  const notes = await page('Notes de réunion', 'file', null);
  await page('Rétrospective du sprint 42', 'file', notes);
  await page('Point hebdomadaire', 'file', notes);
  await page('Recrutement', 'file', null);

  // Base « Feuille de route » avec une colonne Statut et sa vue Kanban.
  const base = await (await api(r, 'POST', '/bases', { spaceId: space.id, parentId: accueil, title: 'Feuille de route' })).json() as { page: { id: string }; properties: { id: string }[] };
  const statut = await (await api(r, 'POST', `/bases/${base.page.id}/properties`, { name: 'Statut', type: 'status' })).json() as { id: string; options: { id: string }[] };
  for (const [nom, o] of [['Export PDF', 0], ['Mode hors ligne', 0], ['Recherche plein texte', 1], ['Thème sombre', 2]] as const) {
    await api(r, 'POST', `/bases/${base.page.id}/rows`, { values: { [base.properties[0]!.id]: nom, [statut.id]: statut.options[o]!.id } });
  }
  const detail = (await (await api(r, 'GET', `/bases/${base.page.id}`)).json()) as { views: { id: string }[] };
  await api(r, 'PATCH', `/bases/${base.page.id}/views/${detail.views[0]!.id}`, { config: { type: 'kanban', groupBy: statut.id, sort: [], filters: [], hidden: [] } });

  await ctx.close();
  return { accueil, cible };
}

async function contexteConnecte(browser: Browser, email: string, password: string) {
  const ctx = await browser.newContext({ baseURL: BASE });
  const res = await ctx.request.post('/auth/local/login', { data: { email, password } });
  if (!res.ok()) throw new Error(`Connexion refusée pour ${email}`);
  const etat = await ctx.storageState();
  await ctx.close();
  return etat;
}

// ---------- Mise en scène : pointeur visible et légende ----------

// Injecté dans chaque page filmée : une flèche suit la souris et un cercle marque chaque clic (aucun HTML injecté).
function installerPointeur() {
  const pose = () => {
    if (document.getElementById('demo-pointeur')) return;
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.id = 'demo-pointeur';
    svg.setAttribute('width', '22'); svg.setAttribute('height', '26'); svg.setAttribute('viewBox', '0 0 22 26');
    svg.style.cssText = 'position:fixed;left:-40px;top:-40px;pointer-events:none;z-index:2147483647;';
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', 'M2 2 L2 20 L7 15.5 L10.5 23 L13.5 21.7 L10 14.3 L16.5 14.3 Z');
    path.setAttribute('fill', '#111827'); path.setAttribute('stroke', '#ffffff'); path.setAttribute('stroke-width', '1.6');
    svg.appendChild(path);
    document.documentElement.appendChild(svg);
    const placer = (x: number, y: number) => { svg.style.left = `${x - 2}px`; svg.style.top = `${y - 2}px`; };
    addEventListener('mousemove', (e) => placer(e.clientX, e.clientY), true);
    // Pendant un glisser-déposer, le navigateur n'émet plus de mousemove : dragover prend le relais.
    addEventListener('dragover', (e) => placer(e.clientX, e.clientY), true);
    addEventListener('mousedown', (e) => {
      const rond = document.createElement('div');
      rond.style.cssText = `position:fixed;left:${e.clientX - 16}px;top:${e.clientY - 16}px;width:32px;height:32px;border-radius:50%;`
        + 'border:3px solid rgba(37,99,235,.85);background:rgba(37,99,235,.18);pointer-events:none;z-index:2147483646;transition:transform .35s ease-out,opacity .35s ease-out;';
      document.documentElement.appendChild(rond);
      requestAnimationFrame(() => { rond.style.transform = 'scale(1.6)'; rond.style.opacity = '0'; });
      setTimeout(() => rond.remove(), 450);
    }, true);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', pose); else pose();
}

async function legende(page: Page, texte: string) {
  await page.evaluate((t) => {
    let el = document.getElementById('demo-legende');
    if (!el) {
      el = document.createElement('div');
      el.id = 'demo-legende';
      el.style.cssText = 'position:fixed;left:50%;bottom:22px;transform:translateX(-50%);padding:9px 20px;border-radius:999px;'
        + 'background:rgba(17,24,39,.88);color:#fff;font:600 20px/1.3 Inter,system-ui,sans-serif;pointer-events:none;z-index:2147483645;white-space:nowrap;';
      document.documentElement.appendChild(el);
    }
    el.textContent = t;
  }, texte);
}

// Page filmée en cours : capture d'écran dans le dossier temporaire si le parcours échoue.
let pageEnCours: Page | undefined;
let souris = { x: 720, y: 405 };
async function viser(page: Page, cible: Locator) {
  await cible.waitFor({ state: 'visible' });
  await cible.scrollIntoViewIfNeeded();
  const b = await cible.boundingBox();
  if (!b) throw new Error('Élément sans position à l’écran');
  souris = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  await page.mouse.move(souris.x, souris.y, { steps: 14 });
}
async function cliquer(page: Page, cible: Locator) {
  await viser(page, cible);
  await pause(180);
  await cible.click();
}
// Clic à droite du texte d'un paragraphe d'une ligne : le curseur se place en fin de ligne (la touche Fin ne le fait pas sur macOS).
async function cliquerEnFin(page: Page, cible: Locator) {
  const b = await cible.boundingBox();
  if (!b) throw new Error('Paragraphe sans position à l’écran');
  souris = { x: b.x + b.width - 4, y: b.y + b.height / 2 };
  await page.mouse.move(souris.x, souris.y, { steps: 10 });
  await page.mouse.click(souris.x, souris.y);
}
// Après une navigation : la flèche réapparaît là où était la souris.
const reposerSouris = (page: Page) => page.mouse.move(souris.x + 1, souris.y + 1);
const taper = (page: Page, texte: string, delay = 45) => page.keyboard.type(texte, { delay });

// ---------- Étapes IA (avec --avec-ia) ----------
// Les attentes de réponse du modèle sont notées : la conversion les accélère pour garder un film vif.
const attentes: [number, number][] = [];
async function attendreReponse(t0: number, attente: () => Promise<unknown>) {
  const debut = (Date.now() - t0) / 1000;
  await attente();
  const fin = (Date.now() - t0) / 1000;
  attentes.push([debut, fin]);
  console.log(`Attente du modèle : ${(fin - debut).toFixed(1)} s (accélérée dans le film)`);
}

// Étape 4 : sélectionner un paragraphe, assistant de rédaction « Améliorer », puis « Remplacer ».
async function etapeIaAssistant(page: Page, t0: number) {
  await legende(page, 'Assistant de rédaction (IA)');
  await cliquer(page, page.locator('.prose p').first());
  await page.locator('.prose p').first().selectText();
  await pause(400);
  await cliquer(page, page.getByRole('button', { name: 'Assistant de rédaction' }));
  const dialogue = page.getByRole('dialog', { name: 'Assistant de rédaction' });
  await dialogue.waitFor();
  await pause(700);
  await cliquer(page, dialogue.getByRole('button', { name: 'Améliorer' }));
  const propose = dialogue.getByLabel('Texte proposé');
  // Le modèle de démonstration laisse parfois un résidu de son format (« assistantfinal ») : on relance jusqu'à une proposition propre.
  for (let essai = 0; essai < 4; essai++) {
    await attendreReponse(t0, () => page.getByRole('button', { name: 'Remplacer' }).and(page.locator(':enabled')).waitFor({ timeout: 120_000 }));
    const texte = (await propose.innerText()).trim();
    if (texte && !/assistantfinal|<\||\|>|^analysis/i.test(texte)) break;
    console.warn(`Proposition avec résidu de format, nouvel essai : ${texte.slice(0, 60)}`);
    if (essai === 3) throw new Error('Proposition IA inexploitable après 4 essais');
    await cliquer(page, dialogue.getByRole('button', { name: 'Améliorer' }));
  }
  await pause(1500);
  await cliquer(page, dialogue.getByRole('button', { name: 'Remplacer' }));
  await propose.waitFor({ state: 'hidden' }).catch(() => undefined);
  await pause(1200);
}

// Étape 6 : question à l'assistant, réponse avec ses sources.
async function etapeIaQuestion(page: Page, t0: number) {
  await legende(page, 'Question à la documentation, avec sources');
  await cliquer(page, page.getByRole('button', { name: 'Assistant', exact: true }));
  // Le nom accessible du panneau devient le titre de la conversation : on le désigne par son identifiant.
  const boite = page.locator('#ai-chat');
  await boite.waitFor();
  await pause(600);
  await cliquer(page, boite.getByRole('textbox', { name: 'Votre message' }));
  await taper(page, 'Que faut-il faire avant une mise en production ?', 40);
  await pause(500);
  await page.keyboard.press('Enter');
  await attendreReponse(t0, async () => {
    await boite.getByRole('button', { name: 'Arrêter' }).waitFor({ state: 'visible', timeout: 30_000 }).catch(() => undefined);
    await boite.getByRole('button', { name: 'Arrêter' }).waitFor({ state: 'hidden', timeout: 180_000 });
  });
  console.log(`Réponse du chat (extrait) : ${(await boite.locator('.ai-chat-log').innerText()).slice(0, 300).replace(/\n/g, ' | ')}`);
  await pause(3500);
  await page.keyboard.press('Escape');
  await pause(600);
}

// ---------- Parcours filmé ----------

async function parcours(browser: Browser, ids: { accueil: string; cible: string }, etatA: object, etatB: object) {
  const videoA = join(WORK, 'video-a');
  const t0 = Date.now();
  const a = await browser.newContext({
    baseURL: BASE, storageState: etatA as never, viewport: { width: 1440, height: 810 }, locale: 'fr-FR', colorScheme: 'light',
    recordVideo: { dir: videoA, size: { width: 1440, height: 810 } },
  });
  // tsx (esbuild) enveloppe les fonctions nommées dans __name : on le définit dans la page avant le script.
  await a.addInitScript({ content: `var __name = (f) => f;(${installerPointeur.toString()})();` });
  const pa = await a.newPage();
  pageEnCours = pa;
  const erreurs: string[] = [];
  pa.on('pageerror', (e) => erreurs.push(e.message));

  // (1) Espace d'équipe, arborescence, palette de recherche, ouverture d'une page.
  await pa.goto(`/p/${ids.accueil}`);
  await pa.locator('.prose').first().waitFor();
  await pa.getByRole('treeitem', { name: 'Guides' }).waitFor();
  await pause(400);
  const debutA = (Date.now() - t0) / 1000;
  const marque = () => (Date.now() - t0) / 1000;
  const marques: Record<string, number> = {};
  await legende(pa, 'Espace d’équipe et arborescence');
  await reposerSouris(pa);
  const guides = pa.getByRole('treeitem', { name: 'Guides' });
  await viser(pa, guides);
  await pause(300);
  const deplier = guides.getByRole('button', { name: 'Déplier', exact: true }).first();
  if (await deplier.count()) await cliquer(pa, deplier); else await cliquer(pa, guides);
  await pa.getByRole('treeitem', { name: 'Mise en production' }).waitFor();
  await pause(700);
  const notes = pa.getByRole('treeitem', { name: 'Notes de réunion' });
  const deplierNotes = notes.getByRole('button', { name: 'Déplier', exact: true }).first();
  if (await deplierNotes.count()) { await cliquer(pa, deplierNotes); await pause(600); }

  await legende(pa, 'Recherche instantanée : Ctrl+K');
  await pa.keyboard.press('Control+K');
  const champ = pa.getByRole('combobox', { name: 'Rechercher' });
  await champ.waitFor();
  await pause(300);
  await taper(pa, 'mise en prod', 70);
  const resultat = pa.getByRole('listbox', { name: 'Résultats' }).getByRole('option', { name: /Mise en production/ }).first();
  await resultat.waitFor();
  await pause(800);
  await pa.keyboard.press('Enter');
  await pa.waitForURL(new RegExp(ids.cible));
  const editeur = pa.locator('.ProseMirror[contenteditable="true"]').first();
  await editeur.waitFor();
  await pause(600);

  // La collègue ouvre la même page en coulisses (contexte non filmé).
  const b = await browser.newContext({ baseURL: BASE, storageState: etatB as never, viewport: { width: 1440, height: 810 }, locale: 'fr-FR', colorScheme: 'light' });
  const pb = await b.newPage();
  const ouvertureB = pb.goto(`/p/${ids.cible}`).then(() => pb.locator('.ProseMirror[contenteditable="true"]').first().waitFor());

  // (2) Menu « / » : callout, diagramme Mermaid, bloc de code coloré.
  marques.slash = marque();
  await legende(pa, 'Menu / : callout, diagramme Mermaid, code coloré');
  await cliquer(pa, pa.locator('.prose > p').last());
  await taper(pa, '/callout');
  await pa.locator('.slash-menu').waitFor();
  await pause(500);
  await pa.keyboard.press('Enter');
  await taper(pa, 'Pas de mise en production le vendredi.');
  await pause(500);
  await cliquer(pa, pa.locator('.prose > p').last());
  await taper(pa, '/mermaid');
  await pause(400);
  await pa.keyboard.press('Enter');
  await pa.locator('.prose svg').first().waitFor({ timeout: 15_000 });
  await pause(1100);
  marques.finSlash = marque();
  await cliquer(pa, pa.locator('.prose > p').last());
  await taper(pa, '/code');
  await pause(400);
  await pa.keyboard.press('Enter');
  const langue = pa.getByRole('combobox', { name: 'Langage du bloc de code' }).last();
  await langue.waitFor();
  await langue.selectOption('javascript');
  await pa.locator('.code-block .cm-content').last().click();
  await taper(pa, 'await deployer({ cible: "recette" });', 30);
  await pause(900);
  await pa.keyboard.press('Escape');

  // (3) Co-édition : la collègue écrit pendant que l'on écrit, deux curseurs à l'écran.
  await ouvertureB;
  marques.coedition = marque();
  await legende(pa, 'Co-édition en temps réel');
  // Haut de page visible : l'étiquette du curseur de la collègue s'affiche au-dessus de la première ligne.
  await pa.locator('.prose p').first().evaluate((e) => e.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  await pause(500);
  await cliquerEnFin(pb, pb.locator('.prose p').first());
  await viser(pa, pa.locator('.prose p').nth(1));
  await cliquerEnFin(pa, pa.locator('.prose p').nth(1));
  await Promise.all([
    taper(pb, ' Relu par Léa.', 110),
    (async () => { await pause(300); await taper(pa, ' Prévenir le support.', 90); })(),
  ]);
  await pa.locator('.collaboration-carets__caret, .collaboration-caret__caret').first().waitFor({ timeout: 10_000 }).catch(() => undefined);
  await pause(1200);
  marques.finCoedition = marque();

  // Commentaire ancré sur un texte, avec mention.
  await legende(pa, 'Commentaire ancré et mention');
  await pa.locator('.prose p').nth(1).selectText();
  await pause(300);
  await cliquer(pa, pa.getByRole('button', { name: 'Commenter la sélection' }));
  const dialogue = pa.getByRole('dialog', { name: 'Commentaires' });
  const zone = dialogue.getByRole('textbox', { name: 'Nouveau commentaire' });
  await zone.waitFor();
  await zone.click();
  await taper(pa, '@Léa', 90);
  await pa.getByRole('listbox', { name: 'Personnes à mentionner' }).getByRole('option', { name: COLLEGUE.name }).waitFor();
  await pause(500);
  await pa.keyboard.press('Enter');
  await taper(pa, 'peux-tu valider ?');
  await cliquer(pa, dialogue.getByRole('button', { name: 'Commenter', exact: true }));
  await dialogue.locator('.comment-body .mention').first().waitFor();
  await pause(1300);
  await cliquer(pa, dialogue.getByText('Fermer', { exact: true }));
  await pause(500);
  await b.close();

  marques.ia1 = marque();
  if (AVEC_IA) await etapeIaAssistant(pa, t0);
  marques.finIa1 = marque();

  // (5) /kanban : insérer la feuille de route en colonnes et déplacer une carte.
  await legende(pa, 'Kanban : déplacer une carte');
  // Le Kanban va dans la page d'accueil de l'équipe : la page partagée ensuite reste sans base.
  await cliquer(pa, pa.getByRole('treeitem', { name: 'Accueil de l’équipe' }));
  await pa.waitForURL(new RegExp(ids.accueil));
  await pa.locator('.ProseMirror[contenteditable="true"]').first().waitFor();
  await pause(400);
  await cliquer(pa, pa.locator('.prose > p').last());
  await taper(pa, '/kanban');
  await pause(400);
  await pa.keyboard.press('Enter');
  const choix = pa.getByRole('dialog', { name: 'Insérer un Kanban' }).getByRole('option', { name: 'Feuille de route' });
  await cliquer(pa, choix);
  // Le bloc montre la base dans la page ; les cartes se déplacent dans la base elle-même.
  const ouvrir = pa.getByRole('link', { name: 'Ouvrir la base' }).last();
  await ouvrir.waitFor();
  await pause(1200);
  await cliquer(pa, ouvrir);
  const couloir = (nom: string) => pa.locator('section.bt-lane').filter({ has: pa.getByText(nom, { exact: true }) });
  const carte = couloir('À faire').locator('li.bt-card', { hasText: 'Export PDF' });
  await carte.waitFor();
  await pause(700);
  await viser(pa, carte);
  await pause(300);
  const arrivee = await couloir('En cours').boundingBox();
  if (!arrivee) throw new Error('Colonne « En cours » introuvable');
  await pa.mouse.down();
  await pa.mouse.move(souris.x + 12, souris.y + 6, { steps: 4 });
  souris = { x: arrivee.x + arrivee.width / 2, y: arrivee.y + Math.min(arrivee.height - 20, 120) };
  await pa.mouse.move(souris.x, souris.y, { steps: 22 });
  await pause(200);
  await pa.mouse.up();
  await couloir('En cours').getByText('Export PDF').waitFor({ timeout: 5_000 }).catch(async () => {
    // Repli : déplacement par le menu de la carte (même résultat à l'écran).
    console.warn('Glisser-déposer sans effet : déplacement par le menu de la carte.');
    await cliquer(pa, couloir('À faire').getByRole('button', { name: /Actions de la carte Export PDF/ }));
    await cliquer(pa, pa.getByRole('menuitem', { name: 'En cours' }));
  });
  await couloir('En cours').getByText('Export PDF').waitFor();
  await pause(1300);

  marques.ia2 = marque();
  if (AVEC_IA) await etapeIaQuestion(pa, t0);
  marques.finIa2 = marque();

  // (7) Lien public de la page, puis lecture sans compte.
  marques.partage = marque();
  await legende(pa, 'Partage par lien public');
  await cliquer(pa, pa.getByRole('treeitem', { name: 'Mise en production' }));
  await pa.waitForURL(new RegExp(ids.cible));
  await pause(500);
  await cliquer(pa, pa.getByRole('button', { name: 'Partager par un lien public' }).first());
  const partage = pa.getByRole('dialog', { name: 'Partager cette page' });
  await cliquer(pa, partage.getByRole('button', { name: 'Créer un lien public' }));
  const lien = await partage.getByLabel('Lien public').inputValue();
  await pause(1300);
  const chemin = new URL(lien).pathname;
  await pa.goto(chemin);
  await pa.getByRole('heading', { name: 'Mise en production' }).waitFor();
  await legende(pa, 'Lecture publique, sans compte');
  await reposerSouris(pa);
  await pause(1600);
  const finA = (Date.now() - t0) / 1000;
  const fichierA = await pa.video()!.path();
  await a.close();
  if (erreurs.length) throw new Error(`Erreurs dans la page : ${erreurs.join(' | ')}`);

  // Vue téléphone (375 px) de la même page publique, filmée à part puis centrée dans l'image.
  const videoT = join(WORK, 'video-t');
  const t1 = Date.now();
  const t = await browser.newContext({
    baseURL: BASE, viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, locale: 'fr-FR', colorScheme: 'light',
    recordVideo: { dir: videoT, size: { width: 375, height: 667 } },
  });
  const pt = await t.newPage();
  await pt.goto(chemin);
  await pt.getByRole('heading', { name: 'Mise en production' }).waitFor();
  await pt.locator('.prose svg').first().waitFor({ timeout: 15_000 }).catch(() => undefined);
  await pause(300);
  const debutT = (Date.now() - t1) / 1000;
  await legende(pt, 'Sur téléphone');
  await pause(1200);
  // Défilement doux de l'élément qui porte la barre de défilement (la molette n'agit pas en mode tactile).
  for (let i = 0; i < 5; i++) {
    await pt.evaluate(() => {
      const zones = [...document.querySelectorAll<HTMLElement>('*')].filter((e) => e.scrollHeight > e.clientHeight + 10 && /auto|scroll/.test(getComputedStyle(e).overflowY));
      (zones[0] ?? document.scrollingElement)?.scrollBy({ top: 150, behavior: 'smooth' });
    });
    await pause(380);
  }
  await pause(900);
  const finT = (Date.now() - t1) / 1000;
  const fichierT = await pt.video()!.path();
  await t.close();

  return { marques, a: { fichier: fichierA, debut: debutA, fin: finA }, t: { fichier: fichierT, debut: debutT, fin: finT } };
}

// ---------- Conversion ----------

function ffmpeg(args: string[]) {
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('Conversion ffmpeg en échec');
}

// Découpe [a, b] en morceaux dont les attentes du modèle sont accélérées (x8) ; chaque morceau : [début, fin, vitesse].
function morceaux(a: number, b: number): [number, number, number][] {
  const sortie: [number, number, number][] = [];
  let x = a;
  for (const [d, f] of [...attentes].sort((p, q) => p[0] - q[0])) {
    const d2 = Math.max(d, a), f2 = Math.min(f, b);
    if (f2 <= d2 || d2 < x) continue;
    if (d2 > x) sortie.push([x, d2, 1]);
    sortie.push([d2, f2, 8]);
    x = f2;
  }
  if (b > x) sortie.push([x, b, 1]);
  return sortie;
}
const coupe = (a: number, b: number, v: number) => `trim=start=${a.toFixed(2)}:end=${b.toFixed(2)},setpts=(PTS-STARTPTS)/${v}`;
const dureeMorceaux = (l: [number, number, number][]) => l.reduce((t, [a, b, v]) => t + (b - a) / v, 0);

// Deux sorties : un MP4 net et complet (1440 px, avec la vue téléphone) et un GIF court (scènes clés, 960 px) pour le README.
function convertir(seg: Awaited<ReturnType<typeof parcours>>) {
  mkdirSync(OUT, { recursive: true });
  const m = seg.marques;

  // MP4 complet : bureau 1440x810 puis téléphone (2x) centré dans un cadre sombre sur fond clair.
  const mp4 = join(OUT, 'notabene-demo.mp4');
  const bureau = morceaux(seg.a.debut, seg.a.fin);
  ffmpeg(['-i', seg.a.fichier, '-i', seg.t.fichier, '-filter_complex', [
    ...bureau.map(([a, b, v], i) => `[0:v]${coupe(a, b, v)},fps=30,scale=1440:810:flags=lanczos,setsar=1[b${i}]`),
    `[1:v]${coupe(seg.t.debut, seg.t.fin, 1)},fps=30,scale=-2:760:flags=lanczos,pad=iw+16:ih+16:8:8:color=0x1f2937,`
      + 'pad=1440:810:(ow-iw)/2:(oh-ih)/2:color=0xeef0f3,setsar=1[t]',
    `${bureau.map((_, i) => `[b${i}]`).join('')}[t]concat=n=${bureau.length + 1}:v=1:a=0[v]`,
  ].join(';'), '-map', '[v]', '-c:v', 'libx264', '-crf', '17', '-preset', 'slow', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', mp4]);

  // GIF court : menu « / », co-édition, assistant IA (si activé), partage (du clic sur « Partager » à la lecture publique).
  const gif = join(OUT, 'notabene-demo.gif');
  const scenes: [number, number][] = [[m.slash!, m.finSlash!], [m.coedition!, m.finCoedition!]];
  if (AVEC_IA) scenes.push([m.ia1!, m.finIa1!]);
  scenes.push([m.partage!, seg.a.fin]);
  const parts = scenes.flatMap(([a, b]) => morceaux(a, b));
  ffmpeg(['-i', seg.a.fichier, '-filter_complex', [
    ...parts.map(([a, b, v], i) => `[0:v]${coupe(a, b, v)},fps=15,scale=960:-2:flags=lanczos,setsar=1[s${i}]`),
    `${parts.map((_, i) => `[s${i}]`).join('')}concat=n=${parts.length}:v=1:a=0,split[x][y]`,
    '[x]palettegen=max_colors=256:stats_mode=diff[p]',
    '[y][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle',
  ].join(';'), '-loop', '0', gif]);

  copyFileSync(seg.a.fichier, join(OUT, 'parcours-bureau.webm'));
  copyFileSync(seg.t.fichier, join(OUT, 'parcours-telephone.webm'));
  return { gif, mp4, dureeGif: dureeMorceaux(parts), dureeMp4: dureeMorceaux(bureau) + seg.t.fin - seg.t.debut };
}

// ---------- Programme ----------

let serveur: ChildProcess | undefined;
let browser: Browser | undefined;
try {
  serveur = demarrerServeur();
  await attendreServeur();
  browser = await chromium.launch();
  const { accueil, cible } = await preparerDonnees(browser);
  const etatA = await contexteConnecte(browser, ADMIN.email, ADMIN.password);
  const etatB = await contexteConnecte(browser, COLLEGUE.email, PASSWORD);
  const segments = await parcours(browser, { accueil, cible }, etatA, etatB);
  const sortie = convertir(segments);
  const mo = (f: string) => (statSync(f).size / 1024 / 1024).toFixed(2);
  console.log(`GIF : ${sortie.gif} (${sortie.dureeGif.toFixed(1)} s, ${mo(sortie.gif)} Mo)`);
  console.log(`MP4 : ${sortie.mp4} (${sortie.dureeMp4.toFixed(1)} s, ${mo(sortie.mp4)} Mo)`);
} catch (err) {
  console.error(err);
  await pageEnCours?.screenshot({ path: join(WORK, 'echec.png') }).catch(() => undefined);
  process.exitCode = 1;
} finally {
  await browser?.close();
  serveur?.kill('SIGTERM');
}
