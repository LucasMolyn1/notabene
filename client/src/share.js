// Page partagée publiquement (/share/<jeton>), lisible sans compte. Le serveur ne renvoie que du contenu assaini : pas de nom de
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
    document.title = 'Lien introuvable · Notabene';
    main.replaceChildren(h('div', { class: 'empty big' },
      h('div', { class: 'empty-emoji' }, icon('ban', 32)),
      h('h2', null, 'Lien introuvable ou expiré'),
      h('p', { class: 'muted' }, 'Cette page n’est plus partagée, ou l’adresse est incorrecte.')));
    return;
  }
  if (!data.indexing) metas.push(h('meta', { name: 'robots', content: 'noindex, nofollow' }));
  document.head.append(...metas);
  document.title = `${data.page.title || 'Sans titre'} · Notabene`;

  const host = h('div', { class: 'prose-host' });
  const editor = createEditor({ element: host, content: withShareLinks(data.page.content, token, data.titles), editable: false });
  const children = (parent) => data.tree.filter((t) => t.parentId === parent);
  const node = (t) => h('li', null,
    h('a', { class: `share-link${t.id === data.page.id ? ' active' : ''}`, href: `/share/${token}/p/${t.id}` }, pageIcon(t.icon, 14), ` ${t.title || 'Sans titre'}`),
    children(t.id).length ? h('ul', null, children(t.id).map(node)) : null);
  const nav = data.tree.length
    ? h('nav', { class: 'share-tree', 'aria-label': 'Pages du partage' },
      h('a', { class: `share-link${data.page.id === data.root.id ? ' active' : ''}`, href: `/share/${token}` }, pageIcon(data.root.icon, 14), ` ${data.root.title || 'Sans titre'}`),
      h('ul', null, children(null).map(node)))
    : null;

  main.replaceChildren(h('div', { class: 'share-page' },
    h('header', { class: 'share-head' }, h('span', { class: 'muted' }, 'Page partagée avec vous'), h('span', { class: 'muted' }, 'Notabene')),
    h('div', { class: 'share-layout' }, nav, h('article', { class: 'share-body' },
      h('h1', { class: 'share-title' }, pageIcon(data.page.icon, 28), ` ${data.page.title || 'Sans titre'}`), host))));
  setView({ kind: 'share', destroy: () => { editor.destroy(); for (const m of metas) m.remove(); document.body.classList.remove('share'); } });
}
