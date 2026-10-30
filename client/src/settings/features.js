// Fonctionnalités : diagrammes, intégration portfolio, outils et webhooks.
import { h, download } from '../util.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { store } from '../store.js';
import { session } from '../session.js';
import { toast, confirmModal } from '../ui.js';
import { qrSvg } from '../qr.js';
import { embedOriginsCard } from '../provider-settings.js';
import { openDrawio, openExcalidraw } from '../diagrams.js';
import * as A from '../actions.js';
import { card, pill, status } from './ui.js';

export function renderDiagrams(el) {
  const drawio = session.config.drawioUrl;
  const tool = (ico, name, desc, state, cmd, tryIt) => h('div', { class: 'tool-card' },
    h('div', { class: 'tool-emoji' }, icon(ico, 20)),
    h('div', { class: 'grow' }, h('strong', null, name), h('p', { class: 'muted' }, desc),
      h('div', { class: 'row' }, state, h('code', null, cmd))),
    tryIt && h('button', { class: 'btn btn-ghost btn-sm', onClick: tryIt }, 'Essayer'));
  const scratch = (label) => () => toast(`${label} : brouillon non enregistré (insérez-le dans une page avec le menu /).`);
  el.replaceChildren(
    card('Outils disponibles', 'Insérez un diagramme dans n’importe quelle page avec le menu « / ».', h('div', { class: 'stack' },
      tool('diamond', 'Mermaid', 'Schémas décrits en texte : organigrammes, séquences, Gantt, classes… Rendu sécurisé (mode strict).', status(true, 'Intégré'), '/mermaid'),
      tool('code', 'PlantUML', 'Diagrammes UML (séquence, classes, composants…) décrits en texte. Moteur servi par votre serveur, rendu dans le navigateur ; les directives !include sont refusées.', status(true, 'Intégré'), '/plantuml'),
      tool('pencil', 'Excalidraw', 'Dessin à main levée, chargé à la demande. Polices servies par votre serveur.', status(true, 'Intégré'), '/excalidraw',
        () => openExcalidraw({ scene: '', svg: '' }, scratch('Excalidraw'))),
      tool('hexagon', 'Draw.io', drawio ? `Instance auto-hébergée : ${drawio}` : 'Nécessite le conteneur Draw.io et la variable DRAWIO_URL.',
        status(!!drawio, 'Configuré', 'Non configuré'), '/drawio', drawio && (() => openDrawio({ xml: '', svg: '' }, scratch('Draw.io')))))),
    card('Sécurité', null, h('p', { class: 'muted' }, 'Les dessins Excalidraw et Draw.io sont enregistrés en SVG et affichés comme images : aucun script ne peut s’exécuter dans la page. Les messages de Draw.io ne sont acceptés que depuis l’origine configurée.')));
}

export async function renderEmbed(el) {
  const publicSpaces = store.spaces.filter((s) => s.visibility === 'public');
  const pages = store.recent(null, 500).filter((p) => publicSpaces.some((s) => s.id === p.spaceId));
  const select = h('select', { class: 'input' }, pages.map((p) => h('option', { value: p.id }, `${p.title || 'Sans titre'}`)));
  const height = h('input', { class: 'input', type: 'number', min: '200', max: '2000', value: '640' });
  const code = h('textarea', { class: 'code-area', readonly: true, rows: 4, 'aria-label': 'Code d’intégration à copier' });
  const open = h('a', { class: 'btn btn-ghost btn-sm', target: '_blank', rel: 'noopener' }, 'Aperçu ↗');
  const paint = () => {
    const id = select.value;
    if (!/^[A-Za-z0-9_-]+$/.test(id)) return;
    const url = A.pageUrl(id, { embed: true });
    const h$ = Number(height.value) || 640;
    code.value = `<iframe src="${url}" width="100%" height="${h$}" style="border:0;border-radius:12px" loading="lazy" title="Notabene"></iframe>`;
    open.href = url;
  };
  select.addEventListener('change', paint);
  height.addEventListener('input', paint);

  const cfgData = session.can('admin') ? await A.attempt(() => api.get('/admin/settings')) : null;

  el.replaceChildren(
    card('1. Espaces publics', 'Seuls les espaces publics sont visibles sans connexion, donc intégrables.', h('div', { class: 'table' },
      store.spaces.map((s) => h('div', { class: 'table-row' },
        h('span', { class: 'grow' }, icon(s.icon || 'folder', 16), ` ${s.name}`),
        s.visibility === 'public' ? pill('Public', 'ok') : pill('Privé', 'off'),
        session.can('admin') && h('button', {
          class: 'btn btn-ghost btn-sm',
          onClick: async () => {
            await A.attempt(() => store.updateSpace(s.id, { visibility: s.visibility === 'public' ? 'private' : 'public' }));
            renderEmbed(el);
          },
        }, s.visibility === 'public' ? 'Rendre privé' : 'Rendre public'))))),
    cfgData
      ? embedOriginsCard(cfgData, { card, refresh: () => renderEmbed(el) })
      : card('2. Sites autorisés', 'Origines autorisées à afficher Notabene en iframe.', h('p', { class: 'hint' }, 'Visible et modifiable par les administrateurs.')),
    card('3. Code d’intégration', 'Affiche la page en lecture seule, sans barre latérale.',
      pages.length
        ? h('div', { class: 'stack' },
          h('div', { class: 'row' }, h('label', { class: 'field grow' }, h('span', null, 'Page'), select), h('label', { class: 'field' }, h('span', null, 'Hauteur (px)'), height)),
          code,
          h('div', { class: 'row' },
            h('button', { class: 'btn btn-primary btn-sm', onClick: () => navigator.clipboard.writeText(code.value).then(() => toast('Code copié')) }, icon('copy', 14), 'Copier le code'),
            open))
        : h('p', { class: 'muted' }, 'Aucune page publique pour le moment.')));
  if (pages.length) paint();
}

const CHARSETS = { lower: 'abcdefghijklmnopqrstuvwxyz', upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', digits: '0123456789', symbols: '!@#$%^&*()-_=+[]{};:,.?' };

// Tirage uniforme sans biais de modulo.
function randomInt(max) {
  const limit = Math.floor(0x100000000 / max) * max;
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf); while (buf[0] >= limit);
  return buf[0] % max;
}

function generatePassword(length, sets) {
  const pools = sets.map((k) => CHARSETS[k]);
  const all = pools.join('');
  const chars = pools.map((p) => p[randomInt(p.length)]);
  while (chars.length < length) chars.push(all[randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i--) { const j = randomInt(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  return chars.join('');
}

export function renderTools(el) {
  const len = h('input', { class: 'input', type: 'number', min: '8', max: '128', value: '20' });
  const checks = Object.keys(CHARSETS).map((k) => {
    const box = h('input', { type: 'checkbox', checked: true, onChange: gen });
    return { k, box, node: h('label', { class: 'row' }, box, { lower: 'minuscules', upper: 'majuscules', digits: 'chiffres', symbols: 'symboles' }[k]) };
  });
  const out = h('code', { class: 'pw-out' });
  const entropy = h('small', { class: 'hint' });
  function gen() {
    const sets = checks.filter((c) => c.box.checked).map((c) => c.k);
    const n = Math.min(128, Math.max(8, Number(len.value) || 20));
    if (!sets.length) { out.textContent = ''; entropy.textContent = 'Sélectionnez au moins un jeu de caractères.'; return; }
    out.textContent = generatePassword(n, sets);
    entropy.textContent = `Entropie estimée : ${Math.round(n * Math.log2(sets.reduce((a, k) => a + CHARSETS[k].length, 0)))} bits`;
  }
  len.addEventListener('input', gen);

  const text = h('input', { class: 'input', placeholder: 'https://… ou texte', maxlength: '1000' });
  const qr = h('div', { class: 'qr-out' });
  const paintQr = () => {
    qr.replaceChildren();
    if (!text.value.trim()) return;
    try {
      const svg = qrSvg(text.value);
      qr.append(svg, h('button', { class: 'btn btn-ghost btn-sm', onClick: () => download('qrcode.svg', new XMLSerializer().serializeToString(svg), 'image/svg+xml') }, icon('download', 14), 'Télécharger (SVG)'));
    } catch {
      qr.append(h('p', { class: 'hint' }, 'Texte trop long pour un QR code.'));
    }
  }
  text.addEventListener('input', paintQr);

  el.replaceChildren(
    card('Générateur de mots de passe', 'Généré localement avec le générateur aléatoire sécurisé du navigateur ; rien n’est envoyé au serveur.', h('div', { class: 'stack' },
      h('div', { class: 'row' }, h('label', { class: 'field' }, h('span', null, 'Longueur'), len), ...checks.map((c) => c.node)),
      h('div', { class: 'row' }, out),
      entropy,
      h('div', { class: 'row' },
        h('button', { class: 'btn btn-primary btn-sm', onClick: gen }, icon('wand', 14), 'Générer'),
        h('button', { class: 'btn btn-ghost btn-sm', onClick: () => out.textContent && navigator.clipboard.writeText(out.textContent).then(() => toast('Copié')) }, icon('copy', 14), 'Copier')))),
    card('Générateur de QR code', 'Le QR code est calculé dans votre navigateur.', h('div', { class: 'stack' }, text, qr)));
  gen();
}

export async function renderWebhooks(el, created = null) {
  const data = await A.attempt(() => api.get('/admin/webhooks'));
  if (!data) return;
  const name = h('input', { class: 'input', placeholder: 'Nom (ex. Notification Discord)', maxlength: '80' });
  const url = h('input', { class: 'input', placeholder: 'https://…', maxlength: '500' });
  const boxes = data.events.map((ev) => ({ ev, box: h('input', { type: 'checkbox', checked: ev === 'page.created' || ev === 'page.updated' }) }));
  const refresh = (secret) => renderWebhooks(el, secret);

  const create = async () => {
    const events = boxes.filter((b) => b.box.checked).map((b) => b.ev);
    const made = await A.attempt(() => api.post('/admin/webhooks', { name: name.value.trim(), url: url.value.trim(), events }));
    if (made) refresh(made);
  };

  el.replaceChildren(...[
    created && h('div', { class: 'notice success stack' },
      h('strong', null, 'Webhook créé. Copiez le secret de signature maintenant : il ne sera plus affiché.'),
      h('div', { class: 'row' }, h('code', { class: 'token-value' }, created.secret),
        h('button', { class: 'btn btn-ghost btn-sm', onClick: () => navigator.clipboard.writeText(created.secret).then(() => toast('Secret copié')) }, icon('copy', 14), 'Copier'))),
    card('Webhooks', 'Notifiez un service externe (Discord, n8n, CI…) quand une page change. Chaque envoi est signé (en-tête X-Notabene-Signature, HMAC-SHA256) et ne contient que des identifiants, jamais le contenu des pages.',
      data.items.length
        ? h('div', { class: 'table' }, data.items.map((w) => h('div', { class: 'table-row' },
          h('span', { class: 'grow' }, h('strong', null, w.name), h('small', null, `${w.url} · ${w.events.join(', ')}`)),
          w.enabled ? pill(w.lastStatus ? `HTTP ${w.lastStatus}` : 'Actif', w.failures ? 'warn' : 'ok') : pill('Désactivé', 'off'),
          h('button', {
            class: 'btn btn-ghost btn-sm',
            onClick: async () => {
              const r = await A.attempt(() => api.post(`/admin/webhooks/${w.id}/test`));
              if (r) toast(r.ok ? `Test réussi (HTTP ${r.status})` : `Échec du test (${r.status || 'injoignable'})`, { kind: r.ok ? undefined : 'error' });
              refresh();
            },
          }, 'Tester'),
          !w.enabled && h('button', { class: 'btn btn-ghost btn-sm', onClick: async () => { await A.attempt(() => api.patch(`/admin/webhooks/${w.id}`, { enabled: true })); refresh(); } }, 'Réactiver'),
          h('button', {
            class: 'icon-btn danger', title: 'Supprimer',
            onClick: async () => {
              if (await confirmModal({ title: 'Supprimer ce webhook ?', message: w.name, confirm: 'Supprimer', danger: true })) { await A.attempt(() => api.del(`/admin/webhooks/${w.id}`)); refresh(); }
            },
          }, icon('trash')))))
        : h('p', { class: 'muted' }, 'Aucun webhook configuré.')),
    card('Nouveau webhook', 'HTTPS obligatoire ; les adresses internes sont refusées (WEBHOOK_ALLOW_PRIVATE=true pour les autoriser en réseau local). Un webhook est désactivé après 10 échecs consécutifs.', h('div', { class: 'stack' },
      name, url,
      h('div', { class: 'row wrap' }, boxes.map((b) => h('label', { class: 'row' }, b.box, b.ev))),
      h('div', null, h('button', { class: 'btn btn-primary btn-sm', onClick: create }, icon('plus', 15), 'Créer le webhook'))))].filter(Boolean));
}
