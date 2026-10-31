// Contenu de démonstration créé au premier démarrage (SEED_DEMO=true) sur une base vide.
import type { DB } from './db.js';
import type { DocNode } from './lib/content.js';
import { newId } from './lib/http.js';
import { createPage } from './lib/pages.js';

// Texte enrichi minimal : **gras**, `code`, _italique_.
function rich(s: string): DocNode[] {
  const out: DocNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|_[^_]+_)/g;
  let last = 0;
  for (const m of s.matchAll(re)) {
    if (m.index! > last) out.push({ type: 'text', text: s.slice(last, m.index) });
    const tok = m[0];
    const mark = tok.startsWith('**') ? 'bold' : tok.startsWith('`') ? 'code' : 'italic';
    const inner = mark === 'bold' ? tok.slice(2, -2) : tok.slice(1, -1);
    out.push({ type: 'text', text: inner, marks: [{ type: mark }] });
    last = m.index! + tok.length;
  }
  if (last < s.length) out.push({ type: 'text', text: s.slice(last) });
  return out;
}

const doc = (...content: DocNode[]): DocNode => ({ type: 'doc', content });
const p = (s: string): DocNode => ({ type: 'paragraph', content: rich(s) });
const h = (level: number, s: string): DocNode => ({ type: 'heading', attrs: { level }, content: rich(s) });
const ul = (...items: string[]): DocNode => ({ type: 'bulletList', content: items.map((i) => ({ type: 'listItem', content: [p(i)] })) });
const ol = (...items: string[]): DocNode => ({ type: 'orderedList', attrs: { start: 1 }, content: items.map((i) => ({ type: 'listItem', content: [p(i)] })) });
const tasks = (...items: [boolean, string][]): DocNode => ({
  type: 'taskList',
  content: items.map(([checked, s]) => ({ type: 'taskItem', attrs: { checked }, content: [p(s)] })),
});
const callout = (type: string, ...blocks: DocNode[]): DocNode => ({ type: 'callout', attrs: { type }, content: blocks });
const code = (language: string, text: string): DocNode => ({ type: 'codeBlock', attrs: { language }, content: [{ type: 'text', text }] });
const mermaid = (src: string): DocNode => ({ type: 'mermaid', attrs: { code: src } });
const link = (id: string): DocNode => ({ type: 'pageLink', attrs: { id } });
const table = (...rows: string[][]): DocNode => ({
  type: 'table',
  content: rows.map((cells, r) => ({
    type: 'tableRow',
    content: cells.map((c) => ({ type: r === 0 ? 'tableHeader' : 'tableCell', content: [p(c)] })),
  })),
});

export function seedDemo(db: DB) {
  const hasSpaces = (db.prepare('SELECT COUNT(*) AS n FROM spaces').get() as { n: number }).n > 0;
  if (hasSpaces) return false;

  db.transaction(() => {
    const now = Date.now();
    const space = (name: string, icon: string, description: string, visibility: 'public' | 'private', position: number) => {
      const id = newId();
      db.prepare('INSERT INTO spaces (id, name, icon, description, visibility, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(id, name, icon, description, visibility, position, now, now);
      // Comme les espaces d'une instance mise à jour (migration v14) : tout le monde en édition, le rôle global plafonne.
      db.prepare("INSERT INTO space_members (space_id, group_id, role) VALUES (?, 'everyone', 'edit')").run(id);
      return id;
    };
    const page = (spaceId: string, parentId: string | null, icon: string, title: string, content: DocNode) =>
      createPage(db, { spaceId, parentId, icon, title, content }, null).id;

    const pub = space('Documentation', 'globe', 'Espace public : présentation du projet, guide de l’éditeur et API. Visible sans connexion.', 'public', 0);
    const team = space('Équipe', 'lock', 'Espace privé : réservé aux utilisateurs authentifiés.', 'private', 1);

    const welcome = page(pub, null, 'star', 'Bienvenue sur Notabene', doc(
      p('Notabene est un **wiki collaboratif auto-hébergé** inspiré de Docmost : des espaces, des pages imbriquées, un éditeur riche, des diagrammes et une recherche par IA.'),
      callout('info', p('Cet espace est **public** : il est lisible sans connexion, idéal pour l’intégrer à un portfolio. L’espace « Équipe » est réservé aux personnes connectées via votre fournisseur d’identité.')),
      h(2, 'Ce que vous pouvez faire'),
      ul(
        'Tapez `/` sur une ligne vide pour insérer titres, listes, tableaux, callouts, images ou diagrammes.',
        'Dessinez avec **Excalidraw** ou **Draw.io**, ou décrivez un schéma en texte avec **Mermaid**.',
        'Cherchez avec `⌘K`, puis basculez sur l’onglet **IA** pour poser une question en langage naturel.',
        'Automatisez avec l’**API REST** et des jetons personnels à portées limitées.',
      ),
      h(2, 'Comment ça marche'),
      mermaid('flowchart LR\n  U[Navigateur] -->|cookie HttpOnly| S[Serveur Notabene]\n  S -->|OIDC + PKCE| A[Authentik]\n  S --> D[(SQLite)]\n  S -->|clé chiffrée| L[LLM]\n  C[Script / CI] -->|Bearer nb_…| S'),
      h(2, 'Premiers pas'),
      tasks([true, 'Se connecter avec Authentik'], [false, 'Créer une page avec le bouton **+**'], [false, 'Insérer un diagramme Mermaid avec `/mermaid`'], [false, 'Créer un jeton d’API depuis le menu utilisateur']),
    ));

    const guide = page(pub, welcome, 'pencil', 'Guide de l’éditeur', doc(
      p('L’éditeur reconnaît les raccourcis Markdown : tapez-les en début de ligne.'),
      table(
        ['Vous tapez', 'Vous obtenez'],
        ['`#`, `##`, `###` + espace', 'Titres'],
        ['`-` + espace', 'Liste à puces'],
        ['`1.` + espace', 'Liste numérotée'],
        ['`[ ]` + espace', 'Liste de tâches'],
        ['`>` + espace', 'Citation'],
        ['` ``` `', 'Bloc de code'],
      ),
      h(2, 'Diagrammes'),
      ul(
        '**Mermaid** : schéma décrit en texte, idéal pour les flux et séquences.',
        '**Excalidraw** : croquis à main levée, intégré à la page.',
        '**Draw.io** : diagrammes d’architecture complets, servi par votre propre instance.',
      ),
      mermaid('sequenceDiagram\n  participant N as Navigateur\n  participant S as Notabene\n  participant A as Authentik\n  N->>S: GET /auth/login\n  S-->>N: Redirection (PKCE, state, nonce)\n  N->>A: Authentification\n  A-->>N: Code d’autorisation\n  N->>S: GET /auth/callback?code=…\n  S->>A: Échange du code\n  S-->>N: Cookie de session HttpOnly'),
      h(2, 'Callouts'),
      callout('success', p('**Astuce** : cliquez sur l’icône d’un callout pour changer son type.')),
      callout('warning', p('**Attention** : les images sont compressées avant envoi.')),
    ));

    page(pub, welcome, 'code', 'Utiliser l’API REST', doc(
      p('Créez un jeton depuis **menu utilisateur → Jetons d’API**, en choisissant ses portées (`read`, `write`, `ai`, `admin`) et sa durée de validité. Le jeton n’est affiché qu’une seule fois.'),
      code('bash', 'export NOTABENE_TOKEN="nb_…"\n\n# Lister les espaces\ncurl -H "Authorization: Bearer $NOTABENE_TOKEN" https://wiki.example.com/api/v3/spaces\n\n# Rechercher\ncurl -H "Authorization: Bearer $NOTABENE_TOKEN" "https://wiki.example.com/api/v3/search?q=deploiement"\n\n# Exporter une page en Markdown\ncurl -H "Authorization: Bearer $NOTABENE_TOKEN" https://wiki.example.com/api/v3/pages/<id>/export'),
      p('La documentation interactive OpenAPI est disponible sur `/api/docs`.'),
      callout('danger', p('Ne stockez jamais un jeton dans un dépôt Git : utilisez les secrets de votre CI.')),
    ));

    const onboarding = page(team, null, 'compass', 'Onboarding', doc(
      p('Tout ce qu’il faut pour être opérationnel en une semaine.'),
      tasks([false, 'Obtenir ses accès (Git, CI, messagerie)'], [false, 'Lancer le projet en local'], [false, 'Lire le process de déploiement']),
      p('Voir aussi : '),
    ));
    const deploy = page(team, onboarding, 'upload', 'Process de déploiement', doc(
      ol('Ouvrir une PR et attendre la CI verte.', 'Obtenir une relecture.', 'Fusionner : la préproduction se met à jour.', 'Valider puis promouvoir en production.'),
      callout('danger', p('Pas de mise en production le vendredi après 16 h.')),
    ));
    const onboardingRow = db.prepare('SELECT content FROM pages WHERE id = ?').get(onboarding) as { content: string };
    const onboardingDoc = JSON.parse(onboardingRow.content) as DocNode;
    onboardingDoc.content![2].content!.push(link(deploy));
    db.prepare('UPDATE pages SET content = ? WHERE id = ?').run(JSON.stringify(onboardingDoc), onboarding);
    void guide;
  })();
  return true;
}
