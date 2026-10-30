// Contenu intégré (iframe) : seuls les hôtes que l'administrateur a autorisés s'affichent, et seulement après un clic.
// Quatre garde-fous : l'adresse enregistrée est vérifiée par le serveur (https, nom de domaine) ; la CSP `frame-src` du serveur
// interdit tout autre hôte ; l'iframe est en bac à sable ; le contenu d'un tiers ne se charge qu'à la demande de la personne
// (le tiers voit alors son adresse IP).
import { Node, mergeAttributes } from '@tiptap/core';
import { h } from '../util.js';
import { icon } from '../icons.js';
import { session } from '../session.js';

const CONSENT_KEY = 'notabene.embeds.loaded';

// Nom de domaine ASCII d'au moins deux étiquettes, dernière étiquette alphabétique (donc jamais une adresse IP).
function isDomain(host) {
  const labels = host.split('.');
  return host.length >= 4 && host.length <= 253 && labels.length >= 2 && /^[a-z]{2,63}$/.test(labels.at(-1))
    && labels.every((l) => /^[a-z0-9-]{1,63}$/.test(l) && !l.startsWith('-') && !l.endsWith('-'));
}

/** Adresse https sur un nom de domaine, sans identifiants ni port (même règle que server/src/lib/embed.ts) ; renvoie l'adresse normalisée ou null. */
export function embedUrl(raw) {
  try {
    const url = new URL(String(raw));
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !isDomain(url.hostname)) return null;
    return url.href.length <= 2048 ? url.href : null;
  } catch { return null; }
}

export const allowedHosts = () => session.config.embedHosts || [];
export const isAllowed = (url) => { const u = embedUrl(url); return !!u && allowedHosts().includes(new URL(u).hostname); };

const loaded = () => { try { return new Set(JSON.parse(sessionStorage.getItem(CONSENT_KEY) || '[]')); } catch { return new Set(); } };
const remember = (host) => { try { sessionStorage.setItem(CONSENT_KEY, JSON.stringify([...loaded(), host])); } catch { /* facultatif */ } };

export const Embed = Node.create({
  name: 'embed',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return { url: { default: null, parseHTML: (el) => embedUrl(el.getAttribute('data-url')) } };
  },
  parseHTML() { return [{ tag: 'div[data-embed]', getAttrs: (el) => (embedUrl(el.getAttribute('data-url')) ? null : false) }]; },
  renderHTML({ node, HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-embed': '', 'data-url': node.attrs.url, class: 'embed' }), ['a', { href: node.attrs.url, rel: 'noopener noreferrer' }, node.attrs.url]];
  },
  renderText({ node }) { return node.attrs.url || ''; },

  addNodeView() {
    return ({ node }) => {
      const url = embedUrl(node.attrs.url);
      const host = url ? new URL(url).hostname : '';
      const dom = h('div', { class: 'embed', contenteditable: 'false', 'data-embed': '' });
      const link = url && h('a', { class: 'embed-open', href: url, target: '_blank', rel: 'noopener noreferrer' }, 'Ouvrir ↗');

      const show = () => {
        dom.replaceChildren(
          h('div', { class: 'embed-bar' }, h('span', { class: 'embed-host' }, icon('globe', 14), ` ${host}`), link),
          h('iframe', {
            class: 'embed-frame', src: url, title: `Contenu intégré : ${host}`, loading: 'lazy',
            sandbox: 'allow-scripts allow-same-origin allow-popups allow-presentation', referrerpolicy: 'no-referrer', allow: 'fullscreen', allowfullscreen: '',
          }));
      };
      const paint = () => {
        if (!url) { dom.replaceChildren(h('p', { class: 'muted' }, 'Adresse de contenu intégré invalide.')); return; }
        if (!allowedHosts().includes(host)) {
          dom.replaceChildren(h('div', { class: 'embed-card' },
            h('p', null, `Le contenu de ${host} n’est pas affiché : cet hôte n’est pas autorisé sur cette instance.`),
            h('p', { class: 'muted' }, session.can('admin') ? 'Autorisez-le dans Paramètres, Contenus intégrés.' : 'Un administrateur peut l’autoriser.'), link));
          return;
        }
        if (loaded().has(host)) { show(); return; }
        dom.replaceChildren(h('div', { class: 'embed-card' },
          h('p', null, `Contenu intégré de ${host}`),
          h('p', { class: 'muted' }, 'En l’affichant, ce site verra votre adresse IP et pourra déposer ses propres cookies.'),
          h('div', { class: 'row' },
            h('button', { class: 'btn btn-primary btn-sm', type: 'button', onClick: () => { remember(host); show(); } }, 'Afficher le contenu'), link)));
      };
      paint();
      return {
        dom,
        stopEvent: (e) => !!/** @type {Element} */ (e.target).closest?.('iframe, button, a'),
        ignoreMutation: () => true,
        selectNode: () => dom.classList.add('selected'),
        deselectNode: () => dom.classList.remove('selected'),
      };
    };
  },
});
