// Provisionnement SCIM (administrateurs) : adresse du service, activation, rôle attribué, jetons dédiés.
// Le jeton créé n'est affiché qu'une fois : il vit seulement dans ce rendu (aucun stockage, aucun journal).
import { h, timeAgo, fullDate } from '../util.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { toast, confirmModal } from '../ui.js';
import * as A from '../actions.js';
import { reauthCall } from '../provider-settings.js';
import { REPO_URL } from './account.js';
import { card, copyable, kv, loadingEl, pill } from './ui.js';

const MAX_TOKENS = 10;
const ROLES = [['reader', 'Lecteur'], ['editor', 'Rédacteur']];
const EXPIRY = [['30', '30 jours'], ['90', '90 jours'], ['180', '180 jours'], ['365', '1 an'], ['730', '2 ans']];

const plural = (n, word) => `${n} ${word}${n > 1 ? 's' : ''}`;
const tokenState = (t) => (t.revokedAt ? 'revoked' : t.expiresAt <= Date.now() ? 'expired' : 'active');

export async function renderScim(el, created = null) {
  if (!created) el.replaceChildren(loadingEl());
  let data;
  try {
    data = await api.get('/admin/scim');
  } catch (err) {
    el.replaceChildren(h('div', { class: 'notice warning stack', role: 'alert' },
      h('p', null, `Impossible de charger le provisionnement SCIM : ${err.message}`),
      h('div', null, h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: () => renderScim(el) }, 'Réessayer'))));
    return;
  }
  const refresh = (made = null) => renderScim(el, made);
  const active = data.tokens.filter((t) => tokenState(t) === 'active').length;
  el.replaceChildren(...[
    created && createdNotice(created, () => refresh()),
    stateCard(data, refresh),
    tokensCard(data, active, refresh),
    newTokenCard(active, refresh),
    card('Documentation', null, h('a', { class: 'btn btn-ghost btn-sm', href: `${REPO_URL}/blob/main/docs/SCIM.md`, target: '_blank', rel: 'noopener' }, 'Configurer le fournisseur d’identité ↗')),
  ].filter(Boolean));
  if (created) el.querySelector('#scim-new-token-title')?.focus();
}

// Jeton tout juste créé : affiché une seule fois, avec copie. « J'ai copié » l'efface de la page.
function createdNotice(created, dismiss) {
  const copy = () => navigator.clipboard.writeText(created.token).then(() => toast('Jeton copié'), () => toast('Copie impossible : sélectionnez le jeton à la main', { kind: 'error' }));
  return h('div', { class: 'notice success stack', role: 'region', 'aria-labelledby': 'scim-new-token-title' },
    h('strong', { id: 'scim-new-token-title', tabindex: '-1' }, `Jeton « ${created.name} » créé. Copiez-le maintenant : il ne sera plus jamais affiché.`),
    h('p', null, `Saisissez-le dans le fournisseur d’identité (champ Token). Il expire le ${fullDate(created.expiresAt)}. Ne le partagez pas : il permet de créer et de désactiver des comptes.`),
    h('div', { class: 'row wrap' },
      h('code', { class: 'token-value' }, created.token),
      h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: copy }, icon('copy', 14), 'Copier le jeton')),
    h('div', null, h('button', { class: 'btn btn-primary btn-sm', type: 'button', onClick: dismiss }, 'J’ai copié le jeton')));
}

function stateCard(data, refresh) {
  const enabled = h('input', { type: 'checkbox', id: 'scim-enabled' });
  enabled.checked = data.enabled;
  const role = h('select', { class: 'input', id: 'scim-role', 'aria-describedby': 'scim-role-hint' }, ROLES.map(([v, l]) => h('option', { value: v, selected: v === data.defaultRole }, l)));
  const save = h('button', { class: 'btn btn-primary btn-sm', type: 'button', disabled: true }, 'Enregistrer');
  const sync = () => { save.disabled = data.locked || (enabled.checked === data.enabled && role.value === data.defaultRole); };
  enabled.addEventListener('change', sync);
  role.addEventListener('change', sync);
  enabled.disabled = data.locked;
  role.disabled = data.locked;
  save.addEventListener('click', async () => {
    const what = enabled.checked && !data.enabled ? 'activer le provisionnement SCIM' : 'modifier le provisionnement SCIM';
    const r = await reauthCall('put', '/admin/scim/settings', { enabled: enabled.checked, defaultRole: role.value }, what);
    if (!r) return; // annulation ou refus (message affiché, dont CONFIG_LOCKED en 409)
    toast(r.enabled ? 'Provisionnement SCIM activé' : 'Provisionnement SCIM désactivé');
    refresh();
  });

  return card('Provisionnement SCIM 2.0', 'Le fournisseur d’identité (Authentik, Entra ID…) crée, met à jour et désactive les comptes et gère des groupes, sans attendre la première connexion. Les comptes créés par SCIM n’ont jamais de mot de passe ni le rôle administrateur.',
    h('div', { class: 'row wrap' },
      pill(data.enabled ? 'Actif' : 'Inactif', data.enabled ? 'ok' : 'off'),
      pill(data.source === 'db' ? 'Défini dans l’interface' : 'Défini dans l’environnement', data.source === 'db' ? 'accent' : '')),
    data.locked && h('div', { class: 'notice info' }, 'Configuration verrouillée (CONFIG_LOCKED) : l’activation et le rôle se modifient uniquement dans l’environnement du déploiement (SCIM_ENABLED et SCIM_DEFAULT_ROLE). Les jetons restent gérés ici.'),
    kv([
      ['Adresse du service', copyable(data.endpoint)],
      ['Comptes gérés', plural(data.stats.users, 'compte')],
      ['Groupes gérés', plural(data.stats.groups, 'groupe')],
    ]),
    !data.enabled && h('p', { class: 'hint' }, 'Tant que SCIM est inactif, toute adresse sous /scim/v2 répond 404, même avec un jeton valide.'),
    h('div', { class: 'stack' },
      h('label', { class: 'field row', for: 'scim-enabled' }, enabled, h('strong', null, 'Activer le provisionnement SCIM')),
      h('div', { class: 'field' },
        h('label', { for: 'scim-role' }, 'Rôle des comptes créés'),
        role,
        h('small', { id: 'scim-role-hint', class: 'hint' }, 'Rôle donné à chaque compte créé par SCIM. Une connexion OIDC ultérieure le recalcule d’après les groupes du fournisseur.')),
      h('div', { class: 'prov-actions' }, save)));
}

function tokensCard(data, active, refresh) {
  const rows = data.tokens.map((t) => {
    const state = tokenState(t);
    const label = state === 'revoked' ? `révoqué ${timeAgo(t.revokedAt)}` : state === 'expired' ? `expiré le ${fullDate(t.expiresAt)}` : `expire le ${fullDate(t.expiresAt)}`;
    // État porté par une pastille (pas d'opacité réduite : le contraste du texte doit rester suffisant).
    return h('div', { class: 'table-row' },
      h('span', { class: 'space-ico' }, icon('key', 18)),
      h('span', { class: 'grow' },
        h('strong', null, t.name),
        h('small', null, `${t.prefix}… · ${label} · ${t.lastUsedAt ? `utilisé ${timeAgo(t.lastUsedAt)}` : 'jamais utilisé'}`)),
      pill(state === 'revoked' ? 'Révoqué' : state === 'expired' ? 'Expiré' : 'Actif', state === 'active' ? 'ok' : 'off'),
      state === 'active' && h('button', {
        class: 'btn btn-ghost btn-sm danger-text', type: 'button', 'aria-label': `Révoquer le jeton ${t.name}`,
        onClick: async () => {
          if (!(await confirmModal({ title: 'Révoquer ce jeton ?', message: `« ${t.name} » cessera immédiatement de fonctionner : le fournisseur d’identité qui l’utilise ne pourra plus provisionner de comptes.`, confirm: 'Révoquer', danger: true }))) return;
          if (await A.attempt(() => api.del(`/admin/scim/tokens/${t.id}`).then(() => true))) toast('Jeton révoqué');
          refresh();
        },
      }, 'Révoquer'));
  });
  return card('Jetons SCIM', `Jetons propres à SCIM (nbscim_…) : ils n’ouvrent aucune autre partie de BeNote. ${active} actif${active > 1 ? 's' : ''} sur ${MAX_TOKENS} au plus. Pour changer de jeton sans coupure : créez le nouveau, saisissez-le chez le fournisseur, puis révoquez l’ancien.`,
    rows.length ? h('div', { class: 'table', role: 'list', 'aria-label': 'Jetons SCIM' }, rows.map((r) => { r.setAttribute('role', 'listitem'); return r; }))
      : h('p', { class: 'muted' }, 'Aucun jeton pour le moment.'));
}

function newTokenCard(active, refresh) {
  const name = h('input', { class: 'input', id: 'scim-token-name', maxlength: '80', autocomplete: 'off', placeholder: 'Ex. Authentik', 'aria-describedby': 'scim-token-name-err' });
  const err = h('small', { id: 'scim-token-name-err', class: 'field-error', hidden: true });
  const expiry = h('select', { class: 'input', id: 'scim-token-expiry' }, EXPIRY.map(([v, l]) => h('option', { value: v }, l)));
  expiry.value = '365';
  const full = active >= MAX_TOKENS;
  const create = h('button', { class: 'btn btn-primary btn-sm', type: 'button', disabled: full }, icon('plus', 15), 'Créer le jeton');
  const fail = (msg) => { err.textContent = msg; err.hidden = false; name.setAttribute('aria-invalid', 'true'); name.focus(); };
  name.addEventListener('input', () => { err.hidden = true; name.removeAttribute('aria-invalid'); });
  create.addEventListener('click', async () => {
    const value = name.value.trim();
    if (!value) { fail('Donnez un nom au jeton.'); return; }
    if ([...value].some((c) => c.charCodeAt(0) < 32)) { fail('Caractères interdits dans le nom.'); return; }
    const made = await reauthCall('post', '/admin/scim/tokens', { name: value, expiresInDays: Number(expiry.value) }, 'créer un jeton SCIM');
    if (made) refresh(made);
  });
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); create.click(); } });
  return card('Nouveau jeton', 'La création demande la ressaisie de votre mot de passe. Le jeton n’est affiché qu’une fois ; seule son empreinte est conservée.',
    full && h('div', { class: 'notice info' }, `${MAX_TOKENS} jetons actifs au plus : révoquez-en un avant d’en créer un autre.`),
    h('div', { class: 'stack' },
      h('div', { class: 'field' }, h('label', { for: 'scim-token-name' }, 'Nom du jeton'), name, err),
      h('div', { class: 'row wrap' },
        h('div', { class: 'field grow' }, h('label', { for: 'scim-token-expiry' }, 'Expiration'), expiry),
        create)));
}
