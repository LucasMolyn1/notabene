// Administration de l'instance : informations, sauvegarde et import.
import { h } from '../util.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { store } from '../store.js';
import { session } from '../session.js';
import { toast } from '../ui.js';
import * as A from '../actions.js';
import { REPO_URL } from './account.js';
import { card, copyable, kv, loadingEl, pill, status } from './ui.js';

// TRUST_PROXY : false, true (tous les sauts), un nombre de sauts ou une liste de proxys.
const proxyLabel = (v) => (v === false ? 'Non' : v === true ? 'Oui, tous les sauts (déconseillé : adresse falsifiable)' : typeof v === 'number' ? `Oui, ${v} saut${v > 1 ? 's' : ''} de confiance` : `Oui, proxys : ${v}`);

async function downloadBackup() {
  try {
    const res = await fetch('/api/v3/admin/backup', { credentials: 'same-origin' });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || `Erreur ${res.status}`);
    const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || 'notabene.db';
    const url = URL.createObjectURL(await res.blob());
    const a = h('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  } catch (err) {
    toast(err.message, { kind: 'error' });
  }
}

export async function renderInstance(el) {
  el.replaceChildren(loadingEl());
  const info = await A.attempt(() => api.get('/admin/instance'));
  if (!info) return;
  const s = info.stats;
  const stat = (n, label) => h('div', { class: 'stat' }, h('strong', null, String(n)), h('span', null, label));
  el.replaceChildren(
    card(null, null, h('div', { class: 'stats' },
      stat(s.spaces, 'espaces'), stat(s.publicSpaces, 'publics'), stat(s.pages, 'pages'), stat(s.versions, 'versions'),
      stat(s.users, 'utilisateurs'), stat(s.activeSessions, 'sessions'), stat(s.activeTokens, 'jetons actifs'), stat(s.trashed, 'à la corbeille'))),
    card('Instance', null, kv([
      ['Version', h('code', null, info.commit ? `${info.version} (${info.commit})` : info.version)],
      ['URL publique', copyable(info.publicUrl)],
      ['Environnement', info.environment === 'production' ? pill('production', 'ok') : pill(info.environment, 'warn')],
      ['Reverse proxy', proxyLabel(info.integrations.trustProxy)],
      ['Recherche IA', status(session.config.ai, 'Configurée', 'Non configurée')],
      ['Draw.io', status(!!info.integrations.drawioUrl, 'Configuré', 'Non configuré')],
    ])),
    card('Sauvegarde', 'Télécharge une copie cohérente de la base (pages, comptes, réglages). Elle contient des secrets chiffrés : conservez-la comme un secret. Pour une sauvegarde automatique, voir docs/BACKUP.md.',
      h('button', { class: 'btn btn-primary btn-sm', onClick: downloadBackup }, icon('download', 14), 'Télécharger une sauvegarde')),
    card('Ressources', null, h('div', { class: 'row wrap' },
      h('a', { class: 'btn btn-ghost btn-sm', href: REPO_URL, target: '_blank', rel: 'noopener' }, 'Dépôt GitHub ↗'),
      h('a', { class: 'btn btn-ghost btn-sm', href: `${REPO_URL}/blob/main/SECURITY.md`, target: '_blank', rel: 'noopener' }, 'Sécurité ↗'),
      h('a', { class: 'btn btn-ghost btn-sm', href: '/api/docs', target: '_blank', rel: 'noopener' }, 'API ↗'))));
}

export function renderImport(el) {
  const NEW = '__new__';
  const spaceSel = h('select', { class: 'input' },
    store.spaces.map((s) => h('option', { value: s.id }, s.name)),
    h('option', { value: NEW }, 'Créer un nouvel espace…'));
  const newName = h('input', { class: 'input', placeholder: 'Nom du nouvel espace', maxlength: '80', hidden: true });
  spaceSel.addEventListener('change', () => { newName.hidden = spaceSel.value !== NEW; });
  const folder = h('input', { type: 'file', webkitdirectory: '', multiple: true, class: 'input' });
  const files = h('input', { type: 'file', multiple: true, accept: '.md,.markdown,text/markdown', class: 'input' });
  const summary = h('div', { class: 'stack' });
  const go = h('button', { class: 'btn btn-primary', type: 'button' }, icon('upload', 15), 'Importer');

  go.addEventListener('click', async () => {
    const picked = [...folder.files, ...files.files].filter((f) => /\.(md|markdown)$/i.test(f.name));
    if (!picked.length) { toast('Sélectionnez un dossier ou des fichiers Markdown (.md).', { kind: 'error' }); return; }
    go.disabled = true;
    summary.replaceChildren(h('p', { class: 'muted' }, `Lecture de ${picked.length} fichier(s)…`));
    try {
      const payload = await Promise.all(picked.map(async (f) => ({ path: f.webkitRelativePath || f.name, content: await f.text() })));
      let spaceId = spaceSel.value;
      if (spaceId === NEW) spaceId = await store.createSpace({ name: newName.value.trim() || 'Import', icon: 'folder', description: '', visibility: 'private' });
      const r = await api.post('/admin/import/markdown', { spaceId, files: payload });
      summary.replaceChildren(h('div', { class: 'notice success stack' },
        h('strong', null, 'Import terminé'),
        h('p', null, `${r.pages} page(s) et ${r.folders} dossier(s) créés. Liens internes : ${r.links.resolved} résolus, ${r.links.unresolved} introuvables (laissés en texte).`),
        r.skipped?.length ? h('div', null, h('strong', null, `${r.skipped.length} fichier(s) non importé(s)`), h('ul', { class: 'perm-list' }, r.skipped.slice(0, 50).map((s) => h('li', null, `${s.path} : ${s.reason}`)))) : null,
        r.notes?.length ? h('div', null, h('strong', null, `${r.notes.length} page(s) à vérifier`), h('ul', { class: 'perm-list' }, r.notes.slice(0, 50).map((n) => h('li', null, `${n.path} : ${n.notes.join(' ; ')}`)))) : null,
        h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: () => A.go(`/s/${spaceId}`) }, 'Ouvrir l’espace')));
    } catch (err) {
      summary.replaceChildren(h('div', { class: 'notice warning' }, err.message || 'Import impossible.'));
    } finally {
      go.disabled = false;
    }
  });

  el.replaceChildren(
    card('Importer du Markdown', 'Pour migrer depuis Wiki.js : activez le stockage « Local File System » ou « Git » (Administration > Stockage), lancez une synchronisation, puis sélectionnez ici le dossier obtenu. La hiérarchie, les titres (en-tête YAML), les tableaux, listes, blocs de code, diagrammes Mermaid / PlantUML, encadrés et liens internes sont conservés.', h('div', { class: 'stack' },
      h('label', { class: 'field' }, h('span', null, 'Espace de destination'), spaceSel), newName,
      h('label', { class: 'field' }, h('span', null, 'Dossier (ses sous-dossiers sont lus)'), folder),
      h('label', { class: 'field' }, h('span', null, 'ou fichiers .md individuels'), files),
      go, summary)),
    card('Limites', null, h('ul', { class: 'perm-list' },
      h('li', null, '2000 fichiers, 4 Mo par fichier et 25 Mo au total par import. Un fichier trop gros est écarté et signalé, les autres sont importés.'),
      h('li', null, 'Les images référencées par chemin relatif ne sont pas importées ; seules les images en https ou intégrées (data) le sont.'),
      h('li', null, 'Le HTML est converti en texte simple (titres, paragraphes, listes, code, diagrammes) ; sa mise en forme est perdue. Un import crée toujours de nouvelles pages : il ne remplace rien.'))));
}
