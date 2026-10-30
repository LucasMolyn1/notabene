// Modèles de pages : choix d'un modèle pour une nouvelle page, enregistrement d'une page comme modèle.
// Les noms et descriptions viennent du serveur et ne sont affichés que comme texte.
import { api } from './api.js';
import { icon } from './icons.js';
import { session } from './session.js';
import { store } from './store.js';
import { confirmModal, openModal, pageIcon, toast } from './ui.js';
import { h } from './util.js';

const manageable = (t) => !t.builtin && !!session.user && (t.createdBy === session.user.id || session.can('admin'));

/**
 * Ouvre la liste des modèles ; `onPick` reçoit { name, icon, content } du modèle choisi.
 * @param {(template: { name: string, icon: string, content: object }) => Promise<void> | void} onPick
 * @param {{ spaceId?: string | null }} [options] limite la liste aux modèles fournis et à ceux de cet espace
 */
export async function openTemplatePicker(onPick, { spaceId = null } = {}) {
  const body = h('div', { class: 'tpl-list' }, h('p', { class: 'muted' }, 'Chargement…'));
  const dialog = openModal({ title: 'Nouvelle page depuis un modèle', body, size: 'tpl-modal', actions: [{ label: 'Annuler' }] });

  async function load() {
    let items;
    try {
      items = (await api.get(`/templates${spaceId ? `?spaceId=${encodeURIComponent(spaceId)}` : ''}`)).items;
    } catch (err) {
      body.replaceChildren(h('p', { class: 'muted' }, err?.message || 'Impossible de charger les modèles.'));
      return;
    }
    const group = (title, list) => list.length > 0 && h('section', { class: 'tpl-group' },
      h('h3', { class: 'tpl-title' }, title),
      list.map((t) => h('div', { class: 'tpl-row' },
        h('button', { class: 'tpl-item', type: 'button', onClick: () => pick(t) },
          h('span', { class: 'tpl-ico' }, pageIcon(t.icon, 18)),
          h('span', { class: 'tpl-text' }, h('strong', null, t.name), t.description && h('small', null, t.description), !t.builtin && t.author && h('small', null, `par ${t.author}`))),
        manageable(t) && h('button', { class: 'icon-btn danger', type: 'button', 'aria-label': `Supprimer le modèle ${t.name}`, onClick: () => remove(t) }, icon('trash', 16)))));
    body.replaceChildren(...[
      group('Fournis', items.filter((t) => t.builtin)),
      group('Modèles de l’équipe', items.filter((t) => !t.builtin)),
      !items.some((t) => !t.builtin) && h('p', { class: 'muted tpl-hint' }, 'Pour créer un modèle : ouvrez une page, menu « … », « Enregistrer comme modèle ».'),
    ].filter(Boolean));
  }

  async function pick(t) {
    try {
      const full = await api.get(`/templates/${encodeURIComponent(t.id)}`);
      dialog.close();
      await onPick({ name: full.name, icon: full.icon || '', content: full.content });
    } catch (err) {
      toast(err?.message || 'Impossible de charger ce modèle.', { kind: 'error' });
    }
  }

  async function remove(t) {
    if (!(await confirmModal({ title: 'Supprimer le modèle', message: `« ${t.name} » sera supprimé pour toute l’équipe. Les pages déjà créées avec ce modèle ne changent pas.`, confirm: 'Supprimer', danger: true }))) return;
    try { await api.del(`/templates/${encodeURIComponent(t.id)}`); } catch (err) { toast(err?.message || 'Suppression impossible.', { kind: 'error' }); }
    load();
  }

  load();
}

/** Demande un nom puis enregistre la page comme modèle de son espace. */
export function saveAsTemplate(pageId) {
  const page = store.page(pageId);
  const name = h('input', { class: 'input', 'aria-label': 'Nom du modèle', maxlength: '80', placeholder: 'Ex. Fiche projet' });
  name.value = (page?.title || '').slice(0, 80);
  const submit = async () => {
    try {
      await api.post('/templates', { pageId, name: name.value.trim() || undefined });
      toast('Modèle enregistré : il est proposé à toute l’équipe dans cet espace.');
      return undefined;
    } catch (err) {
      toast(err?.message || 'Enregistrement impossible.', { kind: 'error' });
      return false;
    }
  };
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.closest('dialog')?.querySelector('.btn-primary')?.click(); } });
  openModal({
    title: 'Enregistrer comme modèle',
    body: h('div', { class: 'stack' },
      h('p', { class: 'muted' }, 'Le contenu actuel de la page sera copié et proposé à toute l’équipe de l’espace. Une page à permissions restreintes ne peut pas devenir un modèle.'),
      h('label', { class: 'field' }, h('span', null, 'Nom du modèle'), name)),
    actions: [{ label: 'Annuler' }, { label: 'Enregistrer', primary: true, onClick: submit }],
  });
  setTimeout(() => name.focus(), 30);
}
