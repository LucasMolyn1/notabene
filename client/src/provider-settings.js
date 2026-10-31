// Réglages modifiables à chaud (admin) : fournisseurs d'identité, SMTP, sites autorisés à intégrer le wiki.
// Chaque modification demande la ressaisie du mot de passe ; les fournisseurs se testent avant d'être enregistrés.
import { h } from './util.js';
import { api } from './api.js';
import { session } from './session.js';
import { toast, openModal } from './ui.js';
import { icon } from './icons.js';

const ROLE_OPTIONS = [['none', 'Refuser l’accès'], ['reader', 'Lecteur']];

// Description des champs de chaque section. type : text | url | list | pem | bool | select | number | secret
const FORMS = {
  oidc: {
    title: 'OpenID Connect (Authentik, Keycloak…)',
    desc: 'Connexion unique par un fournisseur d’identité OIDC. Le rôle est recalculé à chaque connexion d’après la claim « groups ».',
    fields: [
      { k: 'issuer', label: 'Émetteur (issuer)', type: 'url', ph: 'https://auth.exemple.fr/application/o/notabene/' },
      { k: 'clientId', label: 'Client ID', type: 'text' },
      { k: 'clientSecret', label: 'Secret client', type: 'secret' },
      { k: 'scopes', label: 'Scopes', type: 'text' },
      { k: 'adminGroups', label: 'Groupes administrateurs', type: 'list' },
      { k: 'editorGroups', label: 'Groupes éditeurs', type: 'list' },
      { k: 'readerGroups', label: 'Groupes lecteurs', type: 'list' },
      { k: 'defaultRole', label: 'Hors groupes', type: 'select', options: ROLE_OPTIONS },
      { k: 'requireMfa', label: 'Exiger une double authentification (claim amr)', type: 'bool' },
    ],
  },
  ldap: {
    title: 'LDAP / Active Directory',
    desc: 'Connexion par identifiant et mot de passe de l’annuaire. Un compte de service recherche l’utilisateur, puis la liaison se fait avec son propre mot de passe.',
    fields: [
      { k: 'url', label: 'Serveur', type: 'url', ph: 'ldaps://ad.exemple.fr:636' },
      { k: 'startTls', label: 'Utiliser STARTTLS (pour ldap://)', type: 'bool' },
      { k: 'tlsCa', label: 'Autorité de certification (PEM, optionnel)', type: 'pem' },
      { k: 'bindDn', label: 'Compte de service (DN)', type: 'text', ph: 'cn=svc-notabene,ou=services,dc=exemple,dc=fr' },
      { k: 'bindPassword', label: 'Mot de passe du compte de service', type: 'secret' },
      { k: 'baseDn', label: 'Racine de recherche (base DN)', type: 'text', ph: 'dc=exemple,dc=fr' },
      { k: 'userFilter', label: 'Filtre utilisateur ({username} obligatoire)', type: 'text' },
      { k: 'groupAttribute', label: 'Attribut des groupes', type: 'text' },
      { k: 'nameAttribute', label: 'Attribut du nom', type: 'text' },
      { k: 'emailAttribute', label: 'Attribut de l’e-mail', type: 'text' },
      { k: 'adminGroups', label: 'Groupes administrateurs', type: 'list' },
      { k: 'editorGroups', label: 'Groupes éditeurs', type: 'list' },
      { k: 'readerGroups', label: 'Groupes lecteurs', type: 'list' },
      { k: 'defaultRole', label: 'Hors groupes', type: 'select', options: ROLE_OPTIONS },
    ],
  },
  saml: {
    title: 'SAML 2.0',
    desc: 'Connexion unique SAML initiée par Notabene. L’assertion doit être signée par le fournisseur d’identité.',
    fields: [
      { k: 'entryPoint', label: 'URL SSO du fournisseur', type: 'url', ph: 'https://idp.exemple.fr/saml/sso' },
      { k: 'idpCert', label: 'Certificat de signature du fournisseur (PEM)', type: 'pem' },
      { k: 'issuer', label: 'Identifiant du service (entityID, optionnel)', type: 'text' },
      { k: 'wantResponseSigned', label: 'Exiger aussi la signature de la réponse', type: 'bool' },
      { k: 'groupsAttribute', label: 'Attribut des groupes', type: 'text' },
      { k: 'emailAttribute', label: 'Attribut de l’e-mail', type: 'text' },
      { k: 'nameAttribute', label: 'Attribut du nom', type: 'text' },
      { k: 'adminGroups', label: 'Groupes administrateurs', type: 'list' },
      { k: 'editorGroups', label: 'Groupes éditeurs', type: 'list' },
      { k: 'readerGroups', label: 'Groupes lecteurs', type: 'list' },
      { k: 'defaultRole', label: 'Hors groupes', type: 'select', options: ROLE_OPTIONS },
    ],
  },
  smtp: {
    title: 'Serveur d’e-mail (SMTP)',
    desc: 'Active « mot de passe oublié », les invitations par e-mail et les alertes de sécurité. Le chiffrement TLS est obligatoire.',
    fields: [
      { k: 'host', label: 'Serveur SMTP', type: 'text', ph: 'smtp.exemple.fr' },
      { k: 'port', label: 'Port', type: 'number' },
      { k: 'mode', label: 'Chiffrement', type: 'select', options: [['starttls', 'STARTTLS (port 587)'], ['tls', 'TLS direct (port 465)']] },
      { k: 'user', label: 'Utilisateur (optionnel)', type: 'text' },
      { k: 'password', label: 'Mot de passe SMTP', type: 'secret' },
      { k: 'from', label: 'Expéditeur', type: 'text', ph: 'Notabene <wiki@exemple.fr>' },
    ],
  },
};

const field = (label, control, hint) => h('label', { class: 'field' }, h('span', null, label), control, hint && h('small', null, hint));

// Compte fédéré : l'identité se confirme auprès du fournisseur (nouvelle connexion, sans connexion silencieuse) ou par une reconnexion.
function confirmWithProvider(what) {
  const oidc = session.provider === 'oidc';
  return new Promise((resolve) => {
    const m = openModal({
      title: 'Confirmez votre identité',
      body: h('div', { class: 'stack' },
        h('p', null, `Action sensible : ${what}.`),
        h('p', { class: 'muted' }, 'Pour protéger la configuration, votre session doit avoir été ouverte il y a moins de 15 minutes. La vôtre est plus ancienne.'),
        h('p', { class: 'muted' }, oidc
          ? 'Vous allez être renvoyé vers votre fournisseur d’identité pour vous réauthentifier, puis ramené ici.'
          : 'Déconnectez-vous puis reconnectez-vous pour continuer.')),
      actions: [{ label: 'Annuler' }, {
        label: oidc ? 'Confirmer auprès de mon fournisseur' : 'Se déconnecter', primary: true,
        onClick: () => { if (oidc) location.href = `/auth/login?reauth=1&returnTo=${encodeURIComponent(location.pathname)}`; else session.logout(); return undefined; },
      }],
    });
    m.el.addEventListener('close', () => resolve(null));
  });
}

// Encart des réglages sensibles pour un compte fédéré : jusqu'à quand la session est confirmée (null pour un compte local).
export function reauthNotice() {
  if (session.provider === 'local') return null;
  const until = session.reauthUntil;
  if (until > Date.now()) {
    return h('p', { class: 'hint' }, `Session confirmée : ces réglages sont modifiables jusqu’à ${new Date(until).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}.`);
  }
  return h('div', { class: 'notice info stack' },
    h('p', null, 'Ces réglages exigent une session ouverte il y a moins de 15 minutes. La vôtre est plus ancienne : confirmez votre identité avant de saisir quoi que ce soit.'),
    session.provider === 'oidc' && h('div', null, h('a', { class: 'btn btn-primary btn-sm', href: `/auth/login?reauth=1&returnTo=${encodeURIComponent(location.pathname)}` }, icon('shield', 14), 'Confirmer auprès de mon fournisseur')));
}

// Demande la preuve d'identité. Renvoie l'objet `reauth` à joindre à la requête, ou null si annulé.
// Dans la fenêtre de 10 minutes ouverte par une saisie précédente, rien n'est redemandé sauf si `strict`.
export function askReauth(what, { strict = false } = {}) {
  if (session.provider !== 'local') return session.reauthUntil > Date.now() ? Promise.resolve({}) : confirmWithProvider(what);
  if (!strict && session.reauthUntil > Date.now()) return Promise.resolve({});
  return new Promise((resolve) => {
    let value = null;
    const pwd = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', maxlength: '256' });
    const code = h('input', { class: 'input', autocomplete: 'one-time-code', maxlength: '10', placeholder: '123456' });
    const submit = () => { value = { password: pwd.value, code: code.value.trim() || undefined }; };
    const m = openModal({
      title: 'Confirmez votre identité',
      body: h('div', { class: 'stack' },
        h('p', { class: 'muted' }, `Action sensible : ${what}. Saisissez votre mot de passe.`),
        field('Mot de passe', pwd), field('Code de double authentification (si activée)', code)),
      actions: [{ label: 'Annuler' }, { label: 'Confirmer', primary: true, onClick: () => { if (!pwd.value) return false; submit(); return undefined; } }],
    });
    // preventDefault : sinon la touche Entrée réactive le bouton qui reprend le focus à la fermeture.
    pwd.addEventListener('keydown', (e) => { if (e.key === 'Enter' && pwd.value) { e.preventDefault(); submit(); m.close(); } });
    m.el.addEventListener('close', () => resolve(value));
    setTimeout(() => pwd.focus(), 30);
  });
}

// Appel API protégé par la ressaisie : une erreur d'identité rouvre la boîte de dialogue.
async function call(method, path, body, what) {
  const reauth = await askReauth(what);
  if (!reauth) return undefined;
  try {
    const result = await api[method](path, { ...body, reauth });
    if (reauth.password) session.reauthUntil = Date.now() + 10 * 60_000;
    return result;
  } catch (err) {
    session.reauthUntil = 0;
    toast(err.message, { kind: 'error' });
    return undefined;
  }
}

const listToText = (v) => (Array.isArray(v) ? v.join('\n') : '');
const textToList = (t) => t.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);

// Formulaire générique d'une section. `onChange` est appelé après un enregistrement ou un retour à l'environnement.
function sectionForm(name, view, { onChange, extra = [] }) {
  const spec = FORMS[name];
  const disabled = view.locked;
  const inputs = {};
  const rows = spec.fields.map((f) => {
    const value = view.values[f.k];
    let control;
    if (f.type === 'bool') {
      control = h('input', { type: 'checkbox' });
      control.checked = !!value;
      inputs[f.k] = { get: () => control.checked };
      return h('label', { class: 'field row' }, control, h('span', null, f.label));
    }
    if (f.type === 'select') {
      control = h('select', { class: 'input' }, f.options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
      inputs[f.k] = { get: () => control.value };
    } else if (f.type === 'list' || f.type === 'pem') {
      control = h('textarea', { class: 'input', rows: f.type === 'pem' ? 5 : 3, spellcheck: 'false', placeholder: f.type === 'list' ? 'un groupe par ligne' : '-----BEGIN CERTIFICATE-----' });
      control.value = f.type === 'list' ? listToText(value) : (value ?? '');
      inputs[f.k] = { get: () => (f.type === 'list' ? textToList(control.value) : control.value.trim()) };
    } else if (f.type === 'secret') {
      const s = view.secrets[f.k];
      control = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', maxlength: '4000', placeholder: s?.set ? `Enregistré ${s.hint || ''} : laisser vide pour conserver` : '' });
      inputs[f.k] = { secret: true, get: () => control.value };
    } else {
      control = h('input', { class: 'input', type: f.type === 'number' ? 'number' : 'text', autocomplete: 'off', spellcheck: 'false', placeholder: f.ph || '' });
      control.value = value ?? '';
      inputs[f.k] = { get: () => (f.type === 'number' ? Number(control.value) : control.value.trim()) };
    }
    control.disabled = disabled;
    return field(f.label, control);
  });

  const enabled = h('input', { type: 'checkbox' });
  enabled.checked = view.enabled;
  enabled.disabled = disabled;
  const result = h('div', { class: 'notice prov-result', hidden: true });
  const show = (ok, text) => { result.className = `notice prov-result ${ok ? 'success' : 'warning'}`; result.textContent = text; result.hidden = false; };

  const payload = () => {
    const config = { enabled: enabled.checked };
    const secrets = {};
    for (const [k, i] of Object.entries(inputs)) {
      if (i.secret) { if (i.get()) secrets[k] = i.get(); } else config[k] = i.get();
    }
    return { config, secrets };
  };

  let testId = null;
  const save = h('button', { class: 'btn btn-primary btn-sm', disabled: true }, 'Enregistrer');
  const test = h('button', { class: 'btn btn-ghost btn-sm', disabled }, 'Tester la connexion');
  const needsTest = () => name !== 'embed';
  const sync = () => { save.disabled = disabled || (needsTest() && !testId); };
  const dirty = () => { testId = null; result.hidden = true; sync(); };
  const form = h('div', { class: 'prov-form' },
    h('label', { class: 'field row' }, enabled, h('strong', null, 'Activé')),
    h('div', { class: 'field-grid' }, rows));
  form.addEventListener('input', dirty);
  form.addEventListener('change', dirty);
  enabled.addEventListener('change', dirty);

  test.addEventListener('click', async () => {
    const r = await call('post', `/admin/settings/${name}/test`, payload(), `tester la configuration ${spec.title}`);
    if (!r) return;
    show(r.ok, r.message);
    testId = r.ok ? r.testId : null;
    sync();
  });
  save.addEventListener('click', async () => {
    const r = await call('put', `/admin/settings/${name}`, { ...payload(), testId }, `enregistrer ${spec.title}`);
    if (!r) return;
    toast('Configuration enregistrée');
    onChange();
  });
  const reset = view.source === 'db' && !disabled && h('button', {
    class: 'btn btn-ghost btn-sm',
    onClick: async () => { if (await call('post', `/admin/settings/${name}/reset`, {}, 'revenir aux valeurs de l’environnement')) { toast('Retour à l’environnement'); onChange(); } },
  }, 'Revenir au .env');
  sync();
  if (!needsTest()) test.hidden = true;

  return { form, actions: h('div', { class: 'prov-actions' }, needsTest() && test, save, ...extra, reset), result };
}

const sourcePill = (view) => h('span', { class: `pill ${view.source === 'db' ? 'accent' : ''}` }, view.source === 'db' ? 'Défini dans l’interface' : 'Défini dans l’environnement');
const statePill = (view) => h('span', { class: `pill ${view.enabled ? 'ok' : 'off'}` }, view.enabled ? 'Actif' : 'Inactif');

// Carte d'un fournisseur ou du SMTP.
export function providerCard(name, data, { card, copyable, refresh, kvRows = [] }) {
  const view = data.sections[name];
  const extra = [];
  if (name === 'smtp' && view.enabled) {
    extra.push(h('button', {
      class: 'btn btn-ghost btn-sm',
      onClick: async () => { if (await call('post', '/admin/settings/smtp/send-test', {}, 'envoyer un e-mail de test')) toast('E-mail de test envoyé'); },
    }, 'Envoyer un e-mail de test'));
  }
  const { form, actions, result } = sectionForm(name, view, { onChange: refresh, extra });
  const info = kvRows.length && h('div', { class: 'stack' }, kvRows.map(([label, value]) => h('div', { class: 'row wrap' }, h('small', { class: 'muted' }, `${label} : `), copyable(value))));
  return card(FORMS[name].title, FORMS[name].desc,
    h('div', { class: 'row wrap' }, statePill(view), sourcePill(view)),
    view.locked && h('div', { class: 'notice info' }, 'Configuration verrouillée (CONFIG_LOCKED) : modifiable uniquement dans l’environnement du déploiement.'),
    info, form, result, actions);
}

// Sites autorisés à intégrer le wiki (CSP frame-ancestors), sans test de connexion.
// Hôtes dont le contenu peut être intégré dans une page (iframe). Liste vide : fonction inactive.
export function embedHostsCard(data, { card, refresh }) {
  const view = data.sections.embeds;
  const area = h('textarea', { class: 'input', rows: 5, spellcheck: 'false', placeholder: 'www.youtube-nocookie.com\nplayer.vimeo.com', 'aria-label': 'Hôtes autorisés' });
  area.value = listToText(view.values.hosts);
  area.disabled = view.locked;
  const save = h('button', { class: 'btn btn-primary btn-sm', disabled: view.locked }, 'Enregistrer');
  save.addEventListener('click', async () => {
    const hosts = textToList(area.value);
    if (await call('put', '/admin/settings/embeds', { config: { enabled: true, hosts } }, 'modifier les hôtes intégrables')) { toast('Hôtes intégrables mis à jour'); refresh(); }
  });
  return card('Hôtes autorisés', 'Un nom de domaine par ligne, exact (pas de joker, de chemin ni de port). Appliqué immédiatement, sans redémarrage (en-tête CSP frame-src).',
    h('div', { class: 'row wrap' }, sourcePill(view)),
    view.locked && h('div', { class: 'notice info' }, 'Configuration verrouillée (CONFIG_LOCKED) : modifiable uniquement dans l’environnement du déploiement (CONTENT_EMBED_HOSTS).'),
    !view.values.hosts.length && h('div', { class: 'notice warning' }, 'Aucun hôte autorisé : aucun contenu externe ne peut être intégré.'),
    area, h('div', { class: 'prov-actions' }, save));
}

export function embedOriginsCard(data, { card, refresh }) {
  const view = data.sections.embed;
  const area = h('textarea', { class: 'input', rows: 4, spellcheck: 'false', placeholder: 'https://portfolio.exemple.fr' });
  area.value = listToText(view.values.origins);
  area.disabled = view.locked;
  const save = h('button', { class: 'btn btn-primary btn-sm', disabled: view.locked }, 'Enregistrer');
  save.addEventListener('click', async () => {
    const origins = textToList(area.value);
    if (await call('put', '/admin/settings/embed', { config: { enabled: true, origins } }, 'modifier les sites autorisés')) { toast('Sites autorisés mis à jour'); refresh(); }
  });
  return card('2. Sites autorisés', 'Origines autorisées à afficher Notabene en iframe (en-tête CSP frame-ancestors). Appliqué immédiatement, sans redémarrage. Format : https://domaine, sans chemin ni joker.',
    h('div', { class: 'row wrap' }, sourcePill(view)),
    view.locked && h('div', { class: 'notice info' }, 'Configuration verrouillée (CONFIG_LOCKED) : modifiable uniquement dans l’environnement du déploiement.'),
    !view.values.origins.length && h('div', { class: 'notice warning' }, 'Aucune origine autorisée : l’intégration est inactive.'),
    area, h('div', { class: 'prov-actions' }, save));
}
