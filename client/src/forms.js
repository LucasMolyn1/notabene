// Formulaires d'une base : état (instance, espace, espace personnel, restriction), liste, création et modification par
// formulaires à listes fermées, lien public montré une seule fois (création, renouvellement, révocation), compteur de réponses.
// Droits, plafonds et règles sont appliqués par le serveur : ici on affiche et on envoie. Aucun HTML n'est inséré.
import { api } from './api.js';
import { h } from './util.js';
import { icon } from './icons.js';
import { confirmModal, openModal, toast } from './ui.js';

/** Colonnes qu'un formulaire peut remplir (celles d'un modèle de ligne) ; Personne et Page jamais en anonyme. */
const QUESTION_TYPES = new Set(['text', 'number', 'date', 'date_range', 'select', 'multi_select', 'status', 'checkbox', 'person', 'page_link', 'url', 'email', 'phone']);
const ANONYMOUS_FORBIDDEN = new Set(['person', 'page_link']);
const TYPE_NAMES = {
  text: 'texte', number: 'nombre', date: 'date', date_range: 'plage de dates', select: 'sélection', multi_select: 'sélection multiple', status: 'statut',
  checkbox: 'case', person: 'personne', page_link: 'page', url: 'adresse web', email: 'e-mail', phone: 'téléphone',
};
const MODES = { accounts: 'Réservé aux comptes', anonymous: 'Anonyme' };
const DEFAULT_LIMITS = { forms: 10, questions: 30, title: 120, text: 1000, label: 200, responsesPerHour: 100, baseResponsesPerHour: 200 };
const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;
const fmtWhen = (ts) => (ts ? new Date(ts).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
// replaceChildren transforme null, false et les tableaux en texte : on aplatit et on écarte avant.
const put = (el, ...parts) => el.replaceChildren(...parts.flat(Infinity).filter(Boolean));
let seq = 0;

/**
 * Panneau « Formulaires » d'une base (droit d'écriture requis, vérifié par le serveur).
 * @param {{ baseId: string, title: string, properties: any[] }} o
 */
export function openForms({ baseId, title, properties }) {
  const host = h('div', { class: 'au-panel fm-panel' });
  let state = null; // réponse de GET /forms
  let link = null; // { title, url } : adresse à montrer une seule fois
  const toRecreate = new Set(); // formulaires dont le lien a été révoqué par le passage en anonyme
  openModal({ title: `Formulaires de ${title || 'la base'}`, body: host, size: 'medium', actions: [{ label: 'Fermer' }] });
  const limits = () => ({ ...DEFAULT_LIMITS, ...(state?.limits ?? {}) });
  const propById = (pid) => properties.find((p) => p.id === pid);
  const fail = (err) => toast(err?.message || 'Une erreur est survenue', { kind: 'error' });

  async function refresh() {
    try { state = await api.get(`/bases/${baseId}/forms`); } catch (err) {
      put(host, h('p', { class: 'notice error', role: 'alert' }, err?.message || 'Impossible de charger les formulaires.'));
      return false;
    }
    return true;
  }

  /**
   * Appel qui peut demander la confirmation d'une base restreinte (409, reason « restricted ») : on demande, puis on renvoie
   * avec confirmRestricted. Rend null si la personne renonce.
   */
  async function withRestriction(call) {
    try { return await call(false); } catch (err) {
      if (err?.status !== 409 || err.data?.reason !== 'restricted') throw err;
      const ok = await confirmModal({
        title: 'Base à permissions restreintes',
        message: 'Cette base n’est pas lisible par tout l’espace. Un formulaire permet à des personnes qui n’y ont pas accès d’y ajouter des lignes (sans jamais les lire). Si la restriction change ensuite, le formulaire se ferme jusqu’à une nouvelle confirmation.',
        confirm: 'Confirmer',
      });
      if (!ok) return null;
      return call(true);
    }
  }

  // ---- État ----
  function stateNotice() {
    if (!state) return null;
    if (state.personal) return h('p', { class: 'notice info' }, 'Les formulaires ne sont pas disponibles dans un espace personnel.');
    if (!state.instanceEnabled) return h('p', { class: 'notice warning' }, 'Les formulaires sont désactivés sur cette instance. Un administrateur peut les activer (Paramètres, Formulaires), puis dans les paramètres de l’espace.');
    if (!state.spaceEnabled) return h('p', { class: 'notice warning' }, 'Les formulaires sont désactivés dans cet espace. Un administrateur peut les activer dans les paramètres de l’espace.');
    return null;
  }

  // ---- Lien montré une seule fois ----
  function linkNotice(shown) {
    if (!shown) return null;
    const field = h('input', { class: 'input token-value', readonly: true, spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Adresse du formulaire' });
    field.value = shown.url;
    field.addEventListener('focus', () => field.select());
    const copy = h('button', {
      class: 'btn btn-ghost btn-sm', type: 'button',
      onClick: () => navigator.clipboard.writeText(shown.url).then(() => toast('Adresse copiée'), () => toast('Copie impossible : sélectionnez l’adresse', { kind: 'error' })),
    }, icon('copy', 14), 'Copier l’adresse');
    return h('div', { class: 'notice success stack au-secret fm-link' },
      h('strong', null, `Lien du formulaire « ${shown.title} ». Copiez-le maintenant : il ne sera plus affiché.`),
      h('div', { class: 'row wrap' }, field, copy),
      h('small', { class: 'muted' }, 'Toute personne qui a ce lien peut répondre (avec un compte, sauf formulaire anonyme). Renouveler le lien ou le révoquer rend l’ancien inutilisable.'));
  }

  // ---- Liste ----
  async function makeLink(f) {
    if (f.active && !await confirmModal({ title: 'Renouveler le lien', message: 'L’ancien lien cessera aussitôt de fonctionner. Le nouveau ne sera montré qu’une fois.', confirm: 'Renouveler' })) return;
    try {
      const res = await withRestriction((confirmRestricted) => api.post(`/bases/${baseId}/forms/${f.id}/link`, confirmRestricted ? { confirmRestricted: true } : {}));
      if (!res) return;
      link = { title: f.title, url: res.url };
      toRecreate.delete(f.id);
    } catch (err) { fail(err); }
    await refresh();
    showList(`fm-item-${f.id}`);
  }

  async function revoke(f) {
    if (!await confirmModal({ title: 'Révoquer le lien', message: `Le lien de « ${f.title} » cessera aussitôt de fonctionner. Les réponses reçues restent dans la base.`, confirm: 'Révoquer', danger: true })) return;
    try { await api.del(`/bases/${baseId}/forms/${f.id}/link`); toast('Lien révoqué'); } catch (err) { fail(err); }
    await refresh();
    showList(`fm-item-${f.id}`);
  }

  function itemEl(f) {
    const headId = `fm-name-${++seq}`;
    const available = !!state.available;
    const closed = f.active && !f.confirmed;
    const recreate = !f.active && toRecreate.has(f.id);
    const [label, kind] = recreate ? ['Lien à recréer', 'warn'] : !f.active ? ['Sans lien', 'off'] : closed ? ['Fermé : à reconfirmer', 'warn'] : available ? ['Lien actif', 'ok'] : ['Lien suspendu', 'warn'];
    return h('li', { class: 'au-item', 'aria-labelledby': headId },
      h('div', { class: 'au-item-head' },
        h('strong', { id: headId, class: 'au-name' }, f.title),
        h('span', { class: `pill ${f.mode === 'anonymous' ? 'warn' : ''}` }, MODES[f.mode] ?? f.mode),
        h('span', { class: `pill ${kind}` }, label)),
      h('p', { class: 'au-summary' }, `${plural(f.questions.length, 'question', 'questions')} : ${f.questions.map((q) => q.label || propById(q.propertyId)?.name || 'colonne').join(', ')}.`),
      recreate && h('p', { class: 'notice warning' }, 'Le passage en anonyme a révoqué l’ancien lien : créez-en un nouveau pour recevoir des réponses.'),
      closed && h('p', { class: 'notice warning' }, 'Les permissions de la base ont changé depuis la confirmation : le formulaire est fermé. Renouvelez le lien pour confirmer à nouveau.'),
      h('p', { class: 'muted au-meta' }, [
        plural(f.responses, 'réponse', 'réponses'),
        f.lastResponseAt ? `dernière le ${fmtWhen(f.lastResponseAt)}` : null,
        f.active && f.linkCreatedAt ? `lien créé le ${fmtWhen(f.linkCreatedAt)}` : null,
        f.notify ? 'notification à chaque réponse' : null,
      ].filter(Boolean).join(' ; ')),
      h('div', { class: 'row wrap au-item-actions' },
        h('button', {
          class: 'btn btn-ghost btn-sm', type: 'button', disabled: !available, 'data-focus': `fm-item-${f.id}`,
          'aria-label': `${f.active ? 'Renouveler le lien de' : 'Créer le lien de'} ${f.title}`, onClick: () => makeLink(f),
        }, icon('link', 14), f.active ? 'Renouveler le lien' : 'Créer le lien'),
        f.active && h('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'aria-label': `Révoquer le lien de ${f.title}`, onClick: () => revoke(f) }, icon('ban', 14), 'Révoquer le lien'),
        h('button', { class: 'btn btn-ghost btn-sm', type: 'button', disabled: state.personal, 'aria-label': `Modifier ${f.title}`, onClick: () => showEditor(f) }, icon('pencil', 14), 'Modifier'),
        h('button', {
          class: 'btn btn-ghost btn-sm danger', type: 'button', 'aria-label': `Supprimer ${f.title}`,
          onClick: async () => {
            if (!await confirmModal({ title: 'Supprimer le formulaire', message: `« ${f.title} » et son lien seront supprimés. Les réponses déjà reçues restent des lignes de la base.`, confirm: 'Supprimer', danger: true })) return;
            try { await api.del(`/bases/${baseId}/forms/${f.id}`); toast('Formulaire supprimé'); } catch (err) { fail(err); }
            await refresh();
            showList();
          },
        }, icon('trash', 14), 'Supprimer')));
  }

  function showList(focus = null) {
    const items = state.items;
    const full = items.length >= limits().forms;
    // L'adresse n'est montrée qu'à l'affichage qui suit sa création : elle est oubliée aussitôt.
    const shown = link;
    link = null;
    put(host,
      linkNotice(shown),
      stateNotice(),
      state.restricted && !state.personal && h('p', { class: 'notice info' }, 'Base à permissions restreintes : créer un formulaire ou son lien demande une confirmation.'),
      h('p', { class: 'muted' }, `Chaque question remplit une colonne ; chaque réponse devient une ligne de la base. La page du formulaire ne montre jamais les lignes ni le nom de la base. Au plus ${limits().responsesPerHour} réponses par heure et par formulaire, ${limits().baseResponsesPerHour} par base.`),
      items.length ? h('ul', { class: 'au-list', 'aria-label': 'Formulaires' }, items.map(itemEl)) : h('p', { class: 'muted' }, 'Aucun formulaire pour le moment.'),
      h('div', { class: 'row wrap au-foot' },
        h('button', { class: 'btn btn-primary btn-sm', type: 'button', disabled: full || !state.available, 'data-focus': 'fm-new', onClick: () => showEditor(null) }, icon('plus', 14), 'Nouveau formulaire'),
        h('span', { class: 'muted' }, `${items.length} sur ${limits().forms} au plus`)));
    const target = /** @type {HTMLElement | null} */ (shown ? host.querySelector('.fm-link button') : focus && host.querySelector(`[data-focus="${CSS.escape(focus)}"]:not(:disabled)`));
    (target ?? /** @type {HTMLElement | null} */ (host.querySelector('[data-focus="fm-new"]:not(:disabled)')))?.focus();
  }

  // ---- Formulaire de configuration ----
  function showEditor(existing) {
    const L = limits();
    const uid = ++seq;
    const draft = existing
      ? { title: existing.title, description: existing.description, thanks: existing.thanks, mode: existing.mode, notify: existing.notify, questions: existing.questions.map((q) => ({ ...q })) }
      : { title: '', description: '', thanks: '', mode: 'accounts', notify: true, questions: [] };
    let removedNote = '';
    // Passer un formulaire « comptes » qui a un lien en anonyme révoque ce lien (règle du serveur) : on prévient avant.
    const revokesLink = () => !!existing?.active && existing.mode === 'accounts' && draft.mode === 'anonymous';
    const eligible = () => properties.filter((p) => QUESTION_TYPES.has(p.type) && !(draft.mode === 'anonymous' && ANONYMOUS_FORBIDDEN.has(p.type)));
    if (!existing) { const first = eligible()[0]; if (first) draft.questions.push({ propertyId: first.id, label: '', required: false }); }
    const form = h('form', { class: 'stack au-form', novalidate: true, 'aria-labelledby': `fm-form-title-${uid}` });
    const errorEl = h('p', { class: 'notice error', role: 'alert', tabindex: '-1', hidden: true });
    const fid = (k) => `fm-${uid}-${k}`;

    const textField = (k, label, value, max, onInput, { area = false, required = false, hint = '' } = {}) => {
      const el = h(area ? 'textarea' : 'input', { class: 'input', id: fid(k), 'data-k': k, maxlength: String(max), ...(area ? { rows: 3 } : {}), ...(required ? { required: true } : {}), ...(hint ? { 'aria-describedby': fid(`${k}-hint`) } : {}) });
      /** @type {any} */ (el).value = value ?? '';
      el.addEventListener('input', () => onInput(/** @type {any} */ (el).value));
      return h('div', { class: 'field' }, h('label', { for: el.id }, label), el, hint && h('small', { class: 'muted', id: fid(`${k}-hint`) }, hint));
    };

    function questionsEl() {
      const used = new Set(draft.questions.map((q) => q.propertyId));
      const rest = eligible().filter((p) => !used.has(p.id));
      const add = h('select', { class: 'input', id: fid('add'), 'data-k': 'add' }, rest.map((p) => h('option', { value: p.id }, `${p.name} (${TYPE_NAMES[p.type] ?? p.type})`)));
      const n = draft.questions.length;
      return h('fieldset', { class: 'au-fieldset' }, h('legend', null, `Questions (${n} sur ${L.questions})`),
        removedNote && h('p', { class: 'notice warning', role: 'status' }, removedNote),
        n ? null : h('p', { class: 'muted' }, 'Aucune question : ajoutez au moins une colonne.'),
        h('ol', { class: 'fm-questions' }, draft.questions.map((q, i) => {
          const p = propById(q.propertyId);
          const name = p?.name ?? 'Colonne supprimée';
          const k = `q${i}`;
          const req = h('input', { type: 'checkbox', id: fid(`${k}-r`), 'data-k': `${k}-r` });
          req.checked = !!q.required;
          req.addEventListener('change', () => { q.required = req.checked; });
          const move = (d, label, ico, key) => h('button', {
            class: 'icon-btn', type: 'button', 'aria-label': `${label} : ${name}`, title: label, 'data-k': `${k}-${key}`, disabled: i + d < 0 || i + d >= n,
            onClick: () => { const [x] = draft.questions.splice(i, 1); draft.questions.splice(i + d, 0, x); redraw(`q${i + d}-${key}`); },
          }, icon(ico, 14));
          return h('li', null, h('div', { class: 'fm-question', role: 'group', 'aria-label': `Question ${i + 1} : ${name}` },
            h('div', { class: 'fm-q-head' },
              h('strong', { class: 'fm-q-name' }, `${i + 1}. ${name}`), h('span', { class: 'muted' }, p ? TYPE_NAMES[p.type] ?? p.type : ''),
              h('span', { class: 'fm-q-tools' },
                move(-1, 'Monter', 'chevron', 'up'), move(1, 'Descendre', 'chevron', 'down'),
                h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Retirer la question ${name}`, title: 'Retirer', 'data-k': `${k}-x`, onClick: () => { draft.questions.splice(i, 1); redraw('add-btn'); } }, icon('x', 14)))),
            h('div', { class: 'au-row' },
              textField(`${k}-l`, 'Libellé (facultatif)', q.label, L.label, (v) => { q.label = v; }),
              h('label', { class: 'au-check fm-req', for: req.id }, req, 'Obligatoire')),
            p?.type === 'checkbox' && q.required && h('small', { class: 'muted' }, 'Case obligatoire : elle doit être cochée pour envoyer.')));
        })),
        h('div', { class: 'au-row' },
          rest.length > 0 && h('div', { class: 'field' }, h('label', { for: add.id }, 'Colonne à ajouter'), add),
          h('button', {
            class: 'btn btn-ghost btn-sm', type: 'button', 'data-k': 'add-btn', disabled: !rest.length || n >= L.questions,
            onClick: () => { const pid = add.value; if (!pid) return; removedNote = ''; draft.questions.push({ propertyId: pid, label: '', required: false }); redraw(`q${n}-l`); },
          }, icon('plus', 14), 'Ajouter la question')),
        rest.length === 0 && h('p', { class: 'muted' }, 'Toutes les colonnes admises sont déjà posées. Formules, cumuls, relations et ID uniques ne peuvent pas être des questions.'));
    }

    function modeEl() {
      const sel = h('select', { class: 'input', id: fid('mode'), 'data-k': 'mode', 'aria-describedby': fid('mode-hint') },
        h('option', { value: 'accounts' }, 'Réservé aux personnes qui ont un compte'),
        h('option', { value: 'anonymous' }, 'Anonyme : toute personne qui a le lien'));
      sel.value = draft.mode;
      sel.addEventListener('change', () => {
        draft.mode = sel.value;
        removedNote = '';
        if (draft.mode === 'anonymous') {
          const before = draft.questions.length;
          draft.questions = draft.questions.filter((q) => !ANONYMOUS_FORBIDDEN.has(propById(q.propertyId)?.type));
          if (draft.questions.length < before) removedNote = 'Les questions sur des colonnes Personne ou Page ont été retirées : elles ne sont pas permises dans un formulaire anonyme.';
        }
        redraw('mode');
      });
      return h('div', { class: 'field' }, h('label', { for: sel.id }, 'Qui peut répondre'), sel,
        draft.mode === 'anonymous'
          ? h('p', { class: 'notice warning', id: fid('mode-hint') }, 'Anonyme : toute personne qui obtient le lien peut répondre sans compte, y compris hors de votre organisation. Ni nom ni adresse ne sont enregistrés ; les réponses s’ajoutent à la base comme lignes. Les colonnes Personne et Page ne peuvent pas être des questions. Ne partagez le lien qu’avec le public visé.')
          : h('small', { class: 'muted', id: fid('mode-hint') }, 'La personne se connecte pour répondre ; la ligne créée porte son compte.'),
        revokesLink() && h('p', { class: 'notice warning' }, 'Le lien actuel sera révoqué à l’enregistrement : il faudra créer un nouveau lien et le partager à nouveau.'));
    }

    function redraw(focusKey) {
      const active = /** @type {HTMLElement | null} */ (document.activeElement);
      const key = focusKey ?? (active && form.contains(active) ? active.getAttribute('data-k') : null);
      const notify = h('input', { type: 'checkbox', id: fid('notify'), 'data-k': 'notify' });
      notify.checked = !!draft.notify;
      notify.addEventListener('change', () => { draft.notify = notify.checked; });
      put(form,
        h('div', { class: 'row wrap au-head' },
          h('button', { class: 'btn btn-ghost btn-sm', type: 'button', 'data-k': 'back', onClick: () => showList(existing ? `fm-item-${existing.id}` : null) }, 'Retour à la liste'),
          h('h3', { class: 'au-title', id: `fm-form-title-${uid}` }, existing ? `Modifier « ${existing.title} »` : 'Nouveau formulaire')),
        errorEl,
        textField('title', 'Titre', draft.title, L.title, (v) => { draft.title = v; }, { required: true }),
        textField('desc', 'Description (facultative)', draft.description, L.text, (v) => { draft.description = v; }, { area: true, hint: 'Affichée en haut du formulaire, en texte brut.' }),
        modeEl(),
        questionsEl(),
        textField('thanks', 'Message de remerciement (facultatif)', draft.thanks, L.text, (v) => { draft.thanks = v; }, { area: true, hint: 'Affiché après l’envoi. Par défaut : « Votre réponse a été enregistrée. »' }),
        h('label', { class: 'au-check', for: notify.id }, notify, 'Me notifier des nouvelles réponses (regroupées, sans leur contenu)'),
        existing && h('p', { class: 'muted' }, 'En enregistrant, vous devenez l’auteur du formulaire : c’est vous qui recevrez les notifications.'),
        h('div', { class: 'row wrap au-foot' },
          h('button', { class: 'btn btn-primary btn-sm', type: 'submit', 'data-k': 'save' }, existing ? 'Enregistrer' : 'Créer'),
          h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: () => showList(existing ? `fm-item-${existing.id}` : null) }, 'Annuler')));
      const el = key && /** @type {HTMLElement | null} */ (form.querySelector(`[data-k="${CSS.escape(key)}"]`));
      if (el && !(/** @type {any} */ (el).disabled)) el.focus();
      else if (key) /** @type {HTMLElement | null} */ (form.querySelector('[data-k="add"], [data-k="title"]'))?.focus();
    }

    const showError = (msg) => { errorEl.textContent = msg; errorEl.hidden = false; errorEl.focus(); };

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const t = draft.title.trim();
      if (!t) { showError('Donnez un titre au formulaire.'); return; }
      if (!draft.questions.length) { showError('Ajoutez au moins une question.'); return; }
      const body = {
        title: t, description: draft.description.trim(), thanks: draft.thanks.trim(), mode: draft.mode, notify: !!draft.notify,
        questions: draft.questions.map((q) => ({ propertyId: q.propertyId, ...(q.label.trim() ? { label: q.label.trim() } : {}), required: !!q.required })),
      };
      if (revokesLink() && !await confirmModal({ title: 'Passer en anonyme', message: 'Le lien actuel de ce formulaire cessera aussitôt de fonctionner. Il faudra en créer un nouveau, qui ne sera montré qu’une fois.', confirm: 'Passer en anonyme', danger: true })) return;
      const save = /** @type {HTMLButtonElement} */ (form.querySelector('[data-k="save"]'));
      save.disabled = true;
      try {
        const res = await withRestriction((confirmRestricted) => {
          const b = confirmRestricted ? { ...body, confirmRestricted: true } : body;
          return existing ? api.patch(`/bases/${baseId}/forms/${existing.id}`, b) : api.post(`/bases/${baseId}/forms`, b);
        });
        if (!res) { save.disabled = false; return; }
        if (existing?.active && !res.active) toRecreate.add(res.id);
        toast(existing ? (existing.active && !res.active ? 'Formulaire enregistré : lien révoqué, à recréer' : 'Formulaire enregistré') : 'Formulaire créé');
        await refresh();
        showList(`fm-item-${res.id}`);
      } catch (err) {
        save.disabled = false;
        showError(err?.message || 'Une erreur est survenue');
      }
    });
    redraw('title');
    put(host, form);
    /** @type {HTMLElement | null} */ (form.querySelector('[data-k="title"]'))?.focus();
  }

  put(host, h('p', { class: 'muted' }, 'Chargement…'));
  refresh().then((ok) => { if (ok) showList(); });
}
