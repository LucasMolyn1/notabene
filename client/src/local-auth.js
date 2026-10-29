// Interface des comptes locaux : connexion / installation, mot de passe et double authentification.
import { h } from './util.js';
import { icon } from './icons.js';
import { request } from './api.js';
import { qrSvg } from './qr.js';
import { toast } from './ui.js';

const field = (label, input) => h('label', { class: 'field' }, h('span', null, label), input);
const input = (props) => h('input', { class: 'input', ...props });

async function submit(button, errorBox, fn) {
  errorBox.textContent = '';
  button.disabled = true;
  try {
    await fn();
  } catch (err) {
    errorBox.textContent = err.message;
    errorBox.hidden = false;
    return err;
  } finally {
    button.disabled = false;
  }
  return null;
}

export function localLoginForm(setupRequired) {
  const error = h('div', { class: 'notice warning', hidden: true });
  const mail = input({ type: 'email', autocomplete: 'username', required: true, maxlength: '200' });
  const pass = input({ type: 'password', autocomplete: setupRequired ? 'new-password' : 'current-password', required: true, maxlength: '256' });
  const code = input({ inputmode: 'text', autocomplete: 'one-time-code', maxlength: '32', placeholder: '123456 ou code de secours' });
  const codeField = field('Code de vérification', code);
  codeField.hidden = true;
  const name = input({ autocomplete: 'name', maxlength: '120' });
  const setup = input({ autocomplete: 'off', maxlength: '64', placeholder: 'Affiché dans les journaux du serveur' });
  const button = h('button', { class: 'btn btn-primary btn-lg', type: 'submit' }, setupRequired ? 'Créer le compte administrateur' : 'Se connecter');

  const form = h('form', { class: 'stack login-form', onSubmit: async (e) => {
    e.preventDefault();
    const err = await submit(button, error, async () => {
      const body = setupRequired
        ? { code: setup.value.trim(), email: mail.value, name: name.value, password: pass.value }
        : { email: mail.value, password: pass.value, code: code.value.trim() || undefined };
      const { redirect } = await request('POST', setupRequired ? '/auth/local/setup' : '/auth/local/login', body);
      location.href = redirect || '/';
    });
    if (err?.data?.mfaRequired) {
      codeField.hidden = false;
      error.hidden = true;
      code.focus();
    }
  } },
  setupRequired && h('p', { class: 'hint' }, 'Première utilisation : saisissez le code d’installation affiché dans les journaux du serveur, puis créez le compte administrateur (mot de passe de 12 caractères minimum).'),
  setupRequired && field('Code d’installation', setup),
  setupRequired && field('Nom', name),
  field('Adresse e-mail', mail),
  field('Mot de passe', pass),
  codeField,
  error,
  button);
  return form;
}

// Carte « Sécurité » du profil : mot de passe et double authentification (TOTP).
export async function securityCard(card, { onEnabled } = {}) {
  const status = await request('GET', '/auth/local/me').catch(() => null);
  if (!status?.local) return null;
  const body = h('div', { class: 'stack' });

  const passwordForm = () => {
    const err = h('div', { class: 'notice warning', hidden: true });
    const cur = input({ type: 'password', autocomplete: 'current-password', maxlength: '256' });
    const next = input({ type: 'password', autocomplete: 'new-password', maxlength: '256' });
    const btn = h('button', { class: 'btn btn-primary btn-sm', type: 'submit' }, 'Changer le mot de passe');
    return h('form', { class: 'stack', onSubmit: async (e) => {
      e.preventDefault();
      const failed = await submit(btn, err, async () => {
        const r = await request('POST', '/auth/local/password', { current: cur.value, next: next.value });
        cur.value = ''; next.value = '';
        toast(r.closedSessions ? `Mot de passe modifié, ${r.closedSessions} autre(s) session(s) fermée(s)` : 'Mot de passe modifié');
      });
      if (failed) err.hidden = false;
    } },
    h('h4', null, 'Mot de passe'),
    field('Mot de passe actuel', cur), field('Nouveau mot de passe (12 caractères minimum)', next), err, btn);
  };

  const showCodes = (codes) => body.replaceChildren(
    h('div', { class: 'notice success stack' },
      h('strong', null, 'Double authentification activée. Conservez ces codes de secours : chacun ne sert qu’une fois et ils ne seront plus affichés.'),
      h('pre', { class: 'code-sample' }, codes.join('\n')),
      h('div', { class: 'row' },
        h('button', { class: 'btn btn-ghost btn-sm', onClick: () => navigator.clipboard.writeText(codes.join('\n')).then(() => toast('Codes copiés')) }, icon('copy', 14), 'Copier'),
        h('button', { class: 'btn btn-primary btn-sm', onClick: () => (onEnabled ? onEnabled() : render()) }, 'J’ai enregistré ces codes'))));

  const mfaSetup = async () => {
    const { secret, uri } = await request('POST', '/auth/mfa/setup');
    const err = h('div', { class: 'notice warning', hidden: true });
    const code = input({ inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', placeholder: '123456' });
    const btn = h('button', { class: 'btn btn-primary btn-sm', type: 'submit' }, 'Activer');
    body.replaceChildren(h('form', { class: 'stack', onSubmit: async (e) => {
      e.preventDefault();
      let codes;
      const failed = await submit(btn, err, async () => { codes = (await request('POST', '/auth/mfa/enable', { code: code.value })).recoveryCodes; });
      if (!failed) showCodes(codes);
    } },
    h('p', { class: 'muted' }, 'Scannez ce QR code avec votre application d’authentification (FreeOTP, Aegis, Google Authenticator…), puis saisissez le code à 6 chiffres.'),
    qrSvg(uri, 200),
    h('p', { class: 'hint' }, 'Saisie manuelle : ', h('code', null, secret)),
    field('Code de vérification', code), err, btn));
  };

  const mfaDisable = () => {
    const err = h('div', { class: 'notice warning', hidden: true });
    const pass = input({ type: 'password', autocomplete: 'current-password', maxlength: '256' });
    const code = input({ autocomplete: 'one-time-code', maxlength: '32', placeholder: '123456 ou code de secours' });
    const btn = h('button', { class: 'btn btn-ghost btn-sm danger-text', type: 'submit' }, 'Désactiver la double authentification');
    return h('form', { class: 'stack', onSubmit: async (e) => {
      e.preventDefault();
      const failed = await submit(btn, err, () => request('POST', '/auth/mfa/disable', { password: pass.value, code: code.value }));
      if (!failed) { toast('Double authentification désactivée'); render(); }
    } }, field('Mot de passe', pass), field('Code de vérification', code), err, btn);
  };

  async function render() {
    const s = await request('GET', '/auth/local/me');
    body.replaceChildren(
      passwordForm(),
      h('h4', null, 'Double authentification (TOTP)'),
      s.mfa
        ? h('div', { class: 'stack' }, h('p', { class: 'muted' }, `Active. Codes de secours restants : ${s.recoveryLeft}.`), mfaDisable())
        : h('div', { class: 'stack' }, h('p', { class: 'muted' }, 'Ajoute un second facteur à la connexion par mot de passe.'),
          h('div', null, h('button', { class: 'btn btn-primary btn-sm', onClick: () => mfaSetup().catch((e) => toast(e.message, { kind: 'error' })) }, icon('shield', 14), 'Activer'))));
  }
  await render();
  return card('Sécurité du compte', 'Mot de passe haché (scrypt) et second facteur TOTP.', body);
}

// Écran affiché tant qu'un compte local n'a pas activé la double authentification (LOCAL_REQUIRE_MFA).
export async function showMfaSetup(main, logout) {
  const card = (title, desc, body) => h('section', { class: 'set-card' }, h('header', { class: 'set-card-head' }, h('h3', null, title), h('p', { class: 'muted' }, desc)), body);
  const sec = await securityCard(card, { onEnabled: () => location.reload() });
  main.replaceChildren(h('div', { class: 'login' }, h('div', { class: 'settings set-main', style: { width: 'min(520px, 100%)', textAlign: 'left' } },
    h('div', { class: 'notice warning' }, 'Votre administrateur exige la double authentification. Activez-la pour accéder au wiki.'),
    sec,
    h('div', null, h('button', { class: 'btn btn-ghost btn-sm', onClick: logout }, 'Se déconnecter')))));
}
