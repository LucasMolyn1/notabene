// Page ou espace partagé publiquement (/share/<jeton>), lisible sans compte. Le serveur ne renvoie que du contenu assaini : pas de nom de
// personne, pas de titre d'une page non partagée. Ici on ne fait que l'afficher en lecture seule.
import { h } from './util.js';
import { icon } from './icons.js';
import { api } from './api.js';
import { createEditor } from './editor.js';
import { pageIcon } from './ui.js';
import { beginView, setView } from './views.js';

// Un lien vers une autre page du partage devient un lien ordinaire vers cette page, dans la vue publique.
function withShareLinks(node, token, titles) {
  if (node.type === 'pageLink') {
    const id = String(node.attrs?.id ?? '');
    return { type: 'text', text: titles[id] || 'Page', marks: [{ type: 'link', attrs: { href: `/share/${token}/p/${id}` } }] };
  }
  return node.content ? { ...node, content: node.content.map((c) => withShareLinks(c, token, titles)) } : node;
}

export async function showShare(token, pageId) {
  beginView();
  document.body.classList.add('share');
  const main = document.getElementById('main');
  main.replaceChildren(h('p', { class: 'muted share-wait' }, 'Chargement…'));
  const metas = [h('meta', { name: 'referrer', content: 'no-referrer' })];
  let data;
  try {
    data = await api.get(`/public/shares/${token}${pageId ? `/pages/${pageId}` : ''}`);
  } catch {
    document.title = 'Lien introuvable · BeNote';
    main.replaceChildren(h('div', { class: 'empty big' },
      h('div', { class: 'empty-emoji' }, icon('ban', 32)),
      h('h2', null, 'Lien introuvable ou expiré'),
      h('p', { class: 'muted' }, 'Cette page n’est plus partagée, ou l’adresse est incorrecte.')));
    return;
  }
  if (!data.indexing) metas.push(h('meta', { name: 'robots', content: 'noindex, nofollow' }));
  document.head.append(...metas);
  const isSpace = data.kind === 'space';
  const page = data.page;
  const spaceName = isSpace ? (data.space?.name || 'Espace') : '';
  document.title = `${page ? `${page.title || 'Sans titre'} · ` : ''}${isSpace ? `${spaceName} · ` : ''}BeNote`;

  const host = h('div', { class: 'prose-host' });
  const editor = page ? createEditor({ element: host, content: withShareLinks(page.content, token, data.titles || {}), editable: false, context: { shareToken: token } }) : null;
  const tree = Array.isArray(data.tree) ? data.tree : [];
  const known = new Set(tree.map((t) => t.id));
  // Racines : pages sans parent, ou dont le parent n'est pas servi (partage d'espace, pages restreintes exclues).
  const children = (parent) => tree.filter((t) => (parent === null ? t.parentId === null || !known.has(t.parentId) : t.parentId === parent));
  const link = (id, ico, title, href) => {
    const active = !!page && id === page.id;
    return h('a', { class: `share-link${active ? ' active' : ''}`, href, 'aria-current': active ? 'page' : null }, pageIcon(ico, 14), ` ${title || 'Sans titre'}`);
  };
  const node = (t) => h('li', null,
    link(t.id, t.icon, t.title, `/share/${token}/p/${t.id}`),
    children(t.id).length ? h('ul', null, children(t.id).map(node)) : null);
  let nav = null;
  if (isSpace) {
    nav = tree.length ? h('nav', { class: 'share-tree', 'aria-label': `Pages de l’espace ${spaceName}` }, h('ul', null, children(null).map(node))) : null;
  } else if (tree.length) {
    nav = h('nav', { class: 'share-tree', 'aria-label': 'Pages du partage' },
      link(data.root.id, data.root.icon, data.root.title, `/share/${token}`),
      h('ul', null, children(null).map(node)));
  }

  const article = page
    ? h('article', { class: 'share-body' }, h('h1', { class: 'share-title' }, pageIcon(page.icon, 28), ` ${page.title || 'Sans titre'}`), host)
    : h('article', { class: 'share-body' }, h('div', { class: 'empty big' },
      h('h2', null, 'Aucune page à afficher'),
      h('p', { class: 'muted' }, 'Cet espace partagé ne contient pour l’instant aucune page lisible par ce lien.')));
  const head = isSpace
    ? h('header', { class: 'share-head' },
      h('span', { class: 'share-space' }, pageIcon(data.space?.icon || 'folder', 18), h('strong', null, spaceName), h('span', { class: 'muted' }, 'Espace partagé avec vous, en lecture seule')),
      h('span', { class: 'muted' }, 'BeNote'))
    : h('header', { class: 'share-head' }, h('span', { class: 'muted' }, 'Page partagée avec vous'), h('span', { class: 'muted' }, 'BeNote'));

  // Le corps de la page ne défile pas (overflow: hidden) : comme les autres vues, la page défile dans un conteneur dédié.
  main.replaceChildren(h('div', { class: 'scroller share-scroller' }, h('div', { class: 'share-page' }, head, h('div', { class: 'share-layout' }, nav, article))));
  setView({ kind: 'share', destroy: () => { editor?.destroy(); for (const m of metas) m.remove(); document.body.classList.remove('share'); } });
}
