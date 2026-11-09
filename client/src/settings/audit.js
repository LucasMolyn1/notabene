// Journal d'audit (filtres, pagination par curseur, export CSV ou JSON), envoi au SIEM et durées de conservation.
// Tout le texte venant du serveur passe par h() (nœuds texte) : jamais d'innerHTML.
import { h, timeAgo, fullDate, download } from '../util.js';
import { icon } from '../icons.js';
import { api, getFile, queryString } from '../api.js';
import { toast } from '../ui.js';
import { providerCard } from '../provider-settings.js';
import { REPO_URL } from './account.js';
import { card, copyable, kv, loadingEl, pill } from './ui.js';

export const AUDIT_LABELS = {
  'auth.login': 'Connexion', 'auth.logout': 'Déconnexion', 'auth.local.failed': 'Échec de connexion', 'auth.ldap.failed': 'Échec de connexion LDAP', 'auth.saml.failed': 'Réponse SAML refusée', 'auth.local.setup': 'Installation initiale', 'auth.local.password': 'Mot de passe modifié', 'auth.mfa.enable': 'MFA activée', 'auth.mfa.disable': 'MFA désactivée', 'backup.download': 'Sauvegarde téléchargée', 'import.markdown': 'Import Markdown', 'user.create': 'Compte créé', 'user.update': 'Compte modifié', 'auth.denied': 'Accès refusé', 'auth.sessions.revoke': 'Sessions fermées',
  'auth.local.forgot': 'Réinitialisation demandée', 'auth.local.reset': 'Mot de passe réinitialisé', 'auth.reauth.failed': 'Échec de ressaisie', 'settings.test': 'Test de configuration', 'settings.test.failed': 'Test de configuration échoué', 'settings.reset': 'Retour à l’environnement', 'settings.embed': 'Sites autorisés modifiés', 'settings.embeds': 'Hôtes intégrables modifiés', 'settings.oidc': 'OIDC modifié', 'settings.ldap': 'LDAP modifié', 'settings.saml': 'SAML modifié', 'settings.smtp': 'SMTP modifié', 'settings.smtp.test-mail': 'E-mail de test envoyé', 'settings.siem': 'SIEM modifié',
  'token.create': 'Jeton créé', 'token.revoke': 'Jeton révoqué', 'settings.ai': 'Réglages IA', 'ai.ask': 'Question IA', 'ai.assist': 'Assistant de rédaction', 'ai.chat': 'Chat IA', 'ai.chat.delete': 'Conversation IA supprimée',
  'space.create': 'Espace créé', 'space.delete': 'Espace supprimé', 'space.visibility': 'Visibilité modifiée',
  'page.destroy': 'Page supprimée définitivement', 'trash.empty': 'Corbeille vidée',
  'page.export.zip': 'Page exportée en ZIP', 'space.export.zip': 'Espace exporté en ZIP',
  'user.export': 'Données d’un compte exportées', 'user.erase': 'Compte supprimé',
  'images.migration.dryrun': 'Conversion des images simulée', 'images.migration.start': 'Conversion des images lancée', 'images.migration.revert': 'Conversion des images annulée', 'images.migration.end': 'Conversion des images terminée',
  'audit.export': 'Export du journal', 'audit.siem.disabled': 'Envoi SIEM désactivé après des échecs',
  'scim.user.create': 'SCIM : compte créé', 'scim.user.update': 'SCIM : compte modifié', 'scim.user.deactivate': 'SCIM : compte désactivé', 'scim.user.delete': 'SCIM : compte détaché',
  'scim.group.create': 'SCIM : groupe créé', 'scim.group.update': 'SCIM : groupe modifié', 'scim.group.delete': 'SCIM : groupe supprimé', 'scim.auth.failed': 'SCIM : jeton refusé',
  'scim.settings': 'SCIM modifié', 'scim.token.create': 'Jeton SCIM créé', 'scim.token.revoke': 'Jeton SCIM révoqué',
};

// Familles proposées dans le filtre (le serveur filtre par préfixe quand la valeur finit par un point).
const FAMILIES = [
  ['auth.', 'Authentification'], ['settings.', 'Réglages'], ['user.', 'Comptes'], ['token.', 'Jetons d’API'], ['space.', 'Espaces'],
  ['page.', 'Pages'], ['trash.', 'Corbeille'], ['ai.', 'IA'], ['audit.', 'Journal d’audit'], ['images.', 'Images'], ['import.', 'Import'], ['backup.', 'Sauvegardes'], ['scim.', 'SCIM'],
];

const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;

// Erreur de chargement d'une section, avec un bouton pour réessayer.
function failure(el, message, retry) {
  el.replaceChildren(h('div', { class: 'notice warning stack', role: 'alert' },
    h('p', null, message),
    h('div', null, h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: retry }, 'Réessayer'))));
}

// Champ de filtre : libellé relié par for, description éventuelle par aria-describedby.
function filterField(id, label, control) {
  control.id = id;
  return h('div', { class: 'field' }, h('label', { for: id }, label), control);
}

// ---- Journal ----------------------------------------------------------------------------------

export function renderAudit(el) {
  const action = h('select', { class: 'input' },
    h('option', { value: '' }, 'Toutes les actions'),
    h('optgroup', { label: 'Familles' }, FAMILIES.map(([v, l]) => h('option', { value: v }, `${l} (toutes)`))),
    h('optgroup', { label: 'Action précise' }, Object.entries(AUDIT_LABELS).sort((a, b) => a[1].localeCompare(b[1], 'fr')).map(([v, l]) => h('option', { value: v }, l))));
  const outcome = h('select', { class: 'input' }, h('option', { value: '' }, 'Toutes'), h('option', { value: 'success' }, 'Réussites'), h('option', { value: 'failure' }, 'Échecs'));
  const user = h('select', { class: 'input' }, h('option', { value: '' }, 'Toutes les personnes'));
  const target = h('input', { class: 'input', type: 'text', maxlength: '300', autocomplete: 'off', spellcheck: 'false', placeholder: 'Identifiant exact' });
  const from = h('input', { class: 'input', type: 'date' });
  const to = h('input', { class: 'input', type: 'date' });
  const dateErr = h('small', { id: 'audit-f-dates-err', class: 'field-error', hidden: true });
  for (const d of [from, to]) d.setAttribute('aria-describedby', 'audit-f-dates-err');

  // Liste des comptes pour le filtre « Personne » ; en cas d'échec, le filtre reste sur « Toutes les personnes ».
  api.get('/admin/users').then((users) => {
    user.append(...users.slice().sort((a, b) => a.name.localeCompare(b.name, 'fr')).map((u) => h('option', { value: u.id }, u.email ? `${u.name} (${u.email})` : u.name)));
  }).catch(() => {});

  // Filtres saisis, validés ; null si la saisie est incohérente (le message est affiché et le champ reçoit le focus).
  const readFilters = () => {
    const bad = from.value && to.value && from.value > to.value;
    dateErr.textContent = bad ? 'La date de début doit précéder ou égaler la date de fin.' : '';
    dateErr.hidden = !bad;
    for (const d of [from, to]) { if (bad) d.setAttribute('aria-invalid', 'true'); else d.removeAttribute('aria-invalid'); }
    if (bad) { from.focus(); return null; }
    return { action: action.value, outcome: outcome.value, userId: user.value, target: target.value.trim(), from: from.value, to: to.value };
  };

  let applied = {};
  let cursor = null;
  let count = 0;
  let busy = false;
  const statusLine = h('p', { class: 'muted audit-status', role: 'status' });
  const errorBox = h('div', { class: 'notice warning stack', role: 'alert', hidden: true });
  const list = h('ul', { class: 'table audit', 'aria-label': 'Entrées du journal', hidden: true });
  const more = h('button', { class: 'btn btn-ghost btn-sm', type: 'button', hidden: true, onClick: () => load(false) }, 'Voir plus');

  const row = (e) => {
    const at = Date.parse(e.timestamp);
    const meta = e.meta && Object.keys(e.meta).length ? JSON.stringify(e.meta) : '';
    const who = e.actor ? (e.actor.name || e.actor.id) : 'Système';
    return h('li', { class: 'table-row wrap' },
      h('span', { class: 'audit-time', title: fullDate(at) }, h('time', { datetime: e.timestamp }, timeAgo(at))),
      h('span', { class: 'grow' },
        h('strong', null, AUDIT_LABELS[e.action] || e.action),
        h('small', null, [who, e.target && `cible ${e.target}`, e.ip, meta && meta.slice(0, 160)].filter(Boolean).join(' · '))),
      e.outcome === 'failure' && pill('Échec', 'warn'));
  };

  async function load(reset) {
    if (busy) return;
    busy = true;
    if (reset) { list.replaceChildren(); count = 0; cursor = null; }
    more.disabled = true;
    list.setAttribute('aria-busy', 'true');
    statusLine.textContent = 'Chargement…';
    errorBox.hidden = true;
    try {
      const page = await api.get(`/admin/audit/events?${queryString({ ...applied, limit: 50, cursor })}`);
      const rows = page.items.map(row);
      list.append(...rows);
      count += rows.length;
      cursor = page.nextCursor;
      const filtered = Object.values(applied).some(Boolean);
      statusLine.textContent = count
        ? `${plural(count, 'entrée')} affichée${count > 1 ? 's' : ''}${cursor ? ' ; d’autres, plus anciennes, restent à charger' : ''}.`
        : (filtered ? 'Aucune entrée ne correspond à ces filtres.' : 'Aucune entrée.');
      list.hidden = !count;
      more.hidden = !cursor;
      // « Voir plus » : le focus passe à la première entrée chargée, pour reprendre la lecture là où elle s'arrêtait.
      if (!reset && rows[0]) { rows[0].tabIndex = -1; rows[0].focus(); }
    } catch (err) {
      statusLine.textContent = '';
      errorBox.replaceChildren(
        h('p', null, `Impossible de charger le journal : ${err.message}`),
        h('div', null, h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: () => load(reset) }, 'Réessayer')));
      errorBox.hidden = false;
    } finally {
      busy = false;
      more.disabled = false;
      list.removeAttribute('aria-busy');
    }
  }

  const form = h('form', { class: 'audit-filters', 'aria-label': 'Filtres du journal', novalidate: true },
    h('div', { class: 'audit-filter-grid' },
      filterField('audit-f-action', 'Action', action),
      filterField('audit-f-outcome', 'Issue', outcome),
      filterField('audit-f-user', 'Personne', user),
      filterField('audit-f-target', 'Cible', target),
      filterField('audit-f-from', 'Du', from),
      h('div', { class: 'field' }, h('label', { for: 'audit-f-to' }, 'Au (inclus)'), Object.assign(to, { id: 'audit-f-to' }), dateErr)),
    h('div', { class: 'prov-actions' },
      h('button', { class: 'btn btn-primary btn-sm', type: 'submit' }, icon('search', 14), 'Filtrer'),
      h('button', { class: 'btn btn-ghost btn-sm', type: 'reset' }, 'Effacer les filtres')));
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const f = readFilters();
    if (!f) return;
    applied = f;
    load(true);
  });
  form.addEventListener('reset', () => {
    // Après la remise à zéro native des champs.
    setTimeout(() => { dateErr.hidden = true; from.removeAttribute('aria-invalid'); to.removeAttribute('aria-invalid'); applied = {}; load(true); });
  });

  // ---- Export ----
  const truncatedNote = h('div', { class: 'notice warning', role: 'status', hidden: true });
  const exportBtns = [];
  const doExport = async (format, btn) => {
    const f = readFilters();
    if (!f) return;
    for (const b of exportBtns) b.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    truncatedNote.hidden = true;
    try {
      const { blob, name, headers } = await getFile(`/admin/audit/export?${queryString({ ...f, format })}`, `journal-audit.${format}`);
      download(name, blob, format === 'json' ? 'application/json' : 'text/csv');
      const rows = Number(headers.get('x-export-rows')) || 0;
      if (headers.get('x-export-truncated') === 'true') {
        truncatedNote.textContent = `Export tronqué : seules les ${rows.toLocaleString('fr-FR')} entrées les plus récentes y figurent. Resserrez les dates pour exporter le reste.`;
        truncatedNote.hidden = false;
      }
      toast(`Export ${format.toUpperCase()} prêt : ${plural(rows, 'entrée')}`);
    } catch (err) {
      toast(err.status === 429
        ? 'Trop d’exports en peu de temps : 10 au plus par tranche de 10 minutes. Réessayez dans quelques minutes.'
        : `Export impossible : ${err.message}`, { kind: 'error' });
    } finally {
      for (const b of exportBtns) b.disabled = false;
      btn.removeAttribute('aria-busy');
    }
  };
  for (const format of ['csv', 'json']) {
    const b = h('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, icon('download', 14), `Exporter en ${format.toUpperCase()}`);
    b.addEventListener('click', () => doExport(format, b));
    exportBtns.push(b);
  }

  el.replaceChildren(
    card('Journal d’audit', 'Actions sensibles, de la plus récente à la plus ancienne : jamais de contenu de page ni de secret.',
      form, statusLine, errorBox, list, more),
    card('Exporter', 'CSV ou JSON, avec les filtres saisis ci-dessus. 100 000 entrées au plus (les plus récentes) ; 10 exports par tranche de 10 minutes. Chaque export est lui-même journalisé.',
      h('div', { class: 'prov-actions' }, exportBtns), truncatedNote));
  load(true);
}

// ---- SIEM -------------------------------------------------------------------------------------

const httpStatus = (code) => {
  if (code == null) return '—';
  if (code === 0) return 'collecteur injoignable';
  return code >= 200 && code < 300 ? `accepté (statut ${code})` : `refusé (statut ${code})`;
};
const when = (t) => (t ? `${fullDate(t)} (${timeAgo(t)})` : 'Jamais');

function siemStateCard(s, refresh) {
  const state = !s.configured ? pill('Non configuré', 'off') : s.disabled ? pill('Désactivé après trop d’échecs', 'warn') : pill('Actif', 'ok');
  return card('État de l’envoi', 'Lecture seule. Les évènements partent par lots, dans l’ordre du journal ; en cas d’échec, l’envoi reprend avec un délai croissant.',
    kv([
      ['État', state],
      s.configured && ['Collecteur', s.origin ? h('code', null, s.origin) : '—'],
      s.configured && ['Familles relayées', s.actions.length ? s.actions.join(', ') : 'Toutes les actions'],
      s.configured && ['Dernier envoi réussi', when(s.lastSuccessAt)],
      s.configured && ['Dernière tentative', s.lastAttemptAt ? `${fullDate(s.lastAttemptAt)} : ${httpStatus(s.lastStatus)}` : 'Aucune'],
      s.configured && ['Échecs consécutifs', `${s.failures} sur ${s.maxFailures} avant l’arrêt`],
      s.configured && !s.disabled && s.nextAttemptAt && ['Prochain essai', fullDate(s.nextAttemptAt)],
      s.configured && ['En attente d’envoi', plural(s.pending, 'évènement')],
      ['Sortie standard (JSON)', s.stdout ? 'Activée (AUDIT_STDOUT)' : 'Désactivée'],
    ]),
    s.disabled && h('div', { class: 'notice warning' }, `L’envoi est arrêté après ${s.maxFailures} échecs consécutifs. Les évènements restent dans le journal. Corrigez la configuration ci-dessous, testez-la puis enregistrez-la pour relancer l’envoi.`),
    !s.configured && h('p', { class: 'hint' }, 'Aucun collecteur configuré : le journal reste consultable et exportable depuis la section Journal d’audit.'),
    h('div', null, h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: refresh }, icon('restore', 14), 'Actualiser')));
}

export async function renderSiem(el) {
  el.replaceChildren(loadingEl());
  const refresh = () => renderSiem(el);
  let state;
  let data;
  try {
    [state, data] = await Promise.all([api.get('/admin/audit/siem'), api.get('/admin/settings')]);
  } catch (err) {
    failure(el, `Impossible de charger l’état du SIEM : ${err.message}`, refresh);
    return;
  }
  el.replaceChildren(
    siemStateCard(state, refresh),
    providerCard('siem', data, { card, copyable, refresh }),
    card('Documentation', null, h('a', { class: 'btn btn-ghost btn-sm', href: `${REPO_URL}/blob/main/docs/AUDIT.md`, target: '_blank', rel: 'noopener' }, 'Format des évènements ↗')));
}

// ---- Conservation -----------------------------------------------------------------------------

export async function renderRetention(el) {
  el.replaceChildren(loadingEl());
  let data;
  try {
    data = await api.get('/admin/retention');
  } catch (err) {
    failure(el, `Impossible de charger les durées de conservation : ${err.message}`, () => renderRetention(el));
    return;
  }
  const value = (main, ...details) => h('div', { class: 'ret-value' }, h('strong', null, main), ...details);
  const items = kv(data.items.map((r) => [r.label, value(
    r.purged ? plural(r.days, 'jour') : 'Pas de purge',
    h('small', null, r.purged ? r.description : 'Conservé sans limite de durée (réglé à 0 jour).'),
    h('small', null, 'Variable : ', h('code', null, r.key)))]));
  const fixed = kv(data.fixed.map((r) => [r.label, value(r.value, h('small', null, r.description))]));
  el.replaceChildren(
    card('Durées de conservation', `Purge automatique toutes les ${plural(data.purgeIntervalMinutes, 'minute')}. Ces durées se règlent par variables d’environnement (0 : pas de purge) ; elles ne se modifient pas ici.`, items),
    card('Autres durées', 'Fixées par l’application ou par la configuration des sessions.', fixed),
    card('Documentation', null, h('a', { class: 'btn btn-ghost btn-sm', href: `${REPO_URL}/blob/main/docs/RGPD.md`, target: '_blank', rel: 'noopener' }, 'Données personnelles et conservation ↗')));
}
