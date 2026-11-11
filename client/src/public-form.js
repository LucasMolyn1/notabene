// Formulaire public d'une base (/form/<jeton>) : sans compte en mode anonyme, avec la session web en mode « réservé aux comptes ».
// Le serveur ne renvoie que la configuration (titre, textes, questions, options) et valide chaque réponse comme une écriture
// normale ; ici on affiche, on aide à remplir et on envoie. Aucun HTML n'est inséré : les textes sont posés en texte brut.
import { h } from './util.js';
import { icon } from './icons.js';
import { api, queryString } from './api.js';
import { session } from './session.js';
import { beginView, setView } from './views.js';

const BRAND = 'BeNote';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// replaceChildren transforme null, false et les tableaux en texte : on aplatit et on écarte avant.
const put = (el, ...parts) => el.replaceChildren(...parts.flat(Infinity).filter(Boolean));
const LIMITS = { text: 2000, url: 2000, email: 254, phone: 30 };

/** Écran d'état (lien fermé, connexion requise, erreur) : titre focalisé pour être annoncé. */
function stateScreen(main, ico, title, text, ...extra) {
  const head = h('h1', { class: 'pf-state-title', tabindex: '-1' }, title);
  put(main, h('div', { class: 'pf-page' },
    h('header', { class: 'pf-top' }, h('span', { class: 'muted' }, 'Formulaire'), h('span', { class: 'muted' }, BRAND)),
    h('div', { class: 'pf-card pf-state' }, h('div', { class: 'empty-emoji' }, icon(ico, 32)), head, h('p', { class: 'muted' }, text), extra)));
  head.focus();
}

/** Adresse de connexion qui ramène à ce formulaire après coup. */
function loginHref(path) {
  if (session.config?.auth?.oidc) return session.loginUrl(path);
  return `/?login&returnTo=${encodeURIComponent(path)}`;
}

export async function showPublicForm(token) {
  beginView();
  document.body.classList.add('share', 'no-sidebar');
  const main = document.getElementById('main');
  // Le jeton est dans l'adresse : aucune requête ne doit le transmettre en référent ; jamais indexé.
  const metas = [h('meta', { name: 'referrer', content: 'no-referrer' }), h('meta', { name: 'robots', content: 'noindex, nofollow' })];
  document.head.append(...metas);
  let alive = true;
  setView({ kind: 'form', destroy: () => { alive = false; for (const m of metas) m.remove(); } });
  document.title = `Formulaire · ${BRAND}`;
  const path = `/form/${token}`;

  async function load() {
    put(main, h('p', { class: 'muted share-wait' }, 'Chargement…'));
    let data;
    try {
      data = await api.get(`/public/forms/${token}`);
    } catch (err) {
      if (err?.status === 401 && err.data?.reason === 'login_required') {
        document.title = `Connexion requise · ${BRAND}`;
        stateScreen(main, 'lock', 'Connexion requise', 'Ce formulaire est réservé aux personnes qui ont un compte sur ce wiki. Connectez-vous pour répondre : vous reviendrez ensuite sur ce formulaire.',
          h('a', { class: 'btn btn-primary', href: loginHref(path) }, 'Se connecter'));
      } else if (err?.status === 404) {
        document.title = `Formulaire fermé · ${BRAND}`;
        stateScreen(main, 'ban', 'Formulaire introuvable ou fermé', 'Ce formulaire n’accepte plus de réponses, ou l’adresse est incorrecte. Demandez un nouveau lien à la personne qui vous l’a envoyé.');
      } else {
        stateScreen(main, 'alert', 'Formulaire indisponible', err?.status === 429 ? 'Trop de demandes depuis votre connexion : réessayez dans une minute.' : 'Impossible de charger le formulaire pour le moment. Réessayez dans un instant.',
          h('button', { class: 'btn btn-ghost', type: 'button', onClick: () => load() }, 'Réessayer'));
      }
      return;
    }
    if (alive) render(data);
  }

  /** @param {{ form: any, ticket: string, minDelayMs: number, ticketTtlMs: number }} data */
  function render(data) {
    const { form } = data;
    document.title = `${form.title || 'Formulaire'} · ${BRAND}`;
    let ticket = data.ticket;
    let issuedAt = Date.now();
    const minDelay = Math.max(0, Number(data.minDelayMs) || 0);
    const ttl = Math.max(60_000, Number(data.ticketTtlMs) || 7_200_000);
    const fields = new Map(); // identifiant de question -> { read, focus, setError }
    const formEl = h('form', { class: 'pf-form stack', novalidate: true, 'aria-labelledby': 'pf-title' });
    const globalErr = h('div', { class: 'notice error', role: 'alert', tabindex: '-1', hidden: true });
    const status = h('p', { class: 'muted pf-status', role: 'status', 'aria-live': 'polite' });
    const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Envoyer');

    // Champ piège : invisible, hors du parcours clavier et des lecteurs d'écran ; une personne le laisse vide.
    const trap = h('input', { type: 'text', name: 'website', id: 'pf-website', tabindex: '-1', autocomplete: 'off', spellcheck: 'false' });
    const trapBox = h('div', { class: 'pf-trap', 'aria-hidden': 'true' }, h('label', { for: 'pf-website' }, 'Site web (laisser vide)'), trap);

    /** Une question : libellé, contrôle adapté au type, message d'erreur lié par aria-describedby. */
    function question(q, i) {
      const base = `pf-q${i}`;
      const errId = `${base}-err`;
      const err = h('p', { class: 'field-error pf-error', id: errId, hidden: true });
      const req = q.required ? h('span', { class: 'pf-req' }, ' (obligatoire)') : null;
      /** @type {HTMLElement[]} */
      let described = []; // éléments qui portent aria-describedby / aria-invalid
      let focusEl = null;
      /** @type {HTMLElement | null} */
      let groupEl = null;
      let read = () => null;
      let body;
      const control = (el) => { el.id = base; if (q.required) el.setAttribute('aria-required', 'true'); described = [el]; focusEl = el; return el; };
      const labelled = (el) => h('div', { class: 'field pf-field' }, h('label', { for: base }, q.label, req), control(el), err);
      const group = (legend, ...children) => {
        // Groupe : l'erreur est liée au groupe (aria-invalid et aria-required ne valent pas pour un fieldset).
        const fs = h('fieldset', { class: 'pf-fieldset' }, h('legend', null, legend, req), ...children, err);
        described = [];
        groupEl = fs;
        return fs;
      };
      switch (q.type) {
        case 'text': {
          const el = h('textarea', { class: 'input', rows: 3, maxlength: String(LIMITS.text) });
          read = () => (el.value.trim() ? el.value : null);
          body = labelled(el);
          break;
        }
        case 'number': {
          const el = h('input', { class: 'input', type: 'text', inputmode: 'decimal', autocomplete: 'off' });
          read = () => {
            const t = el.value.trim().replace(/\s/g, '').replace(',', '.');
            if (!t) return null;
            const n = Number(t);
            if (!Number.isFinite(n)) throw new Error('Saisissez un nombre.');
            return n;
          };
          body = labelled(el);
          break;
        }
        case 'date': {
          const el = h('input', { class: 'input', type: 'date' });
          read = () => el.value || null;
          body = labelled(el);
          break;
        }
        case 'date_range': {
          const start = h('input', { class: 'input', type: 'date', id: `${base}-s` });
          const end = h('input', { class: 'input', type: 'date', id: `${base}-e` });
          read = () => {
            if (!start.value && !end.value) return null;
            if (!start.value) throw new Error('Indiquez la date de début.');
            if (end.value && end.value < start.value) throw new Error('La fin ne peut pas précéder le début.');
            return { start: start.value, end: end.value || null };
          };
          body = group(q.label, h('div', { class: 'pf-inline' },
            h('div', { class: 'field' }, h('label', { for: start.id }, 'Début'), start),
            h('div', { class: 'field' }, h('label', { for: end.id }, 'Fin (facultative)'), end)));
          focusEl = start;
          break;
        }
        case 'select': case 'status': {
          const el = h('select', { class: 'input' }, h('option', { value: '' }, 'Choisir…'), (q.options ?? []).map((o) => h('option', { value: o.id }, o.name)));
          read = () => el.value || null;
          body = labelled(el);
          break;
        }
        case 'multi_select': {
          const boxes = (q.options ?? []).map((o, j) => {
            const cb = h('input', { type: 'checkbox', id: `${base}-${j}`, value: o.id });
            return { cb, node: h('label', { class: 'pf-check', for: cb.id }, cb, h('span', null, o.name)) };
          });
          read = () => { const v = boxes.filter((b) => b.cb.checked).map((b) => b.cb.value); return v.length ? v : null; };
          body = group(q.label, boxes.length ? h('div', { class: 'pf-choices' }, boxes.map((b) => b.node)) : h('p', { class: 'muted' }, 'Aucun choix proposé.'));
          focusEl = boxes[0]?.cb ?? null;
          break;
        }
        case 'checkbox': {
          const cb = control(h('input', { type: 'checkbox' }));
          read = () => (cb.checked ? true : null);
          body = h('div', { class: 'field pf-field' }, h('label', { class: 'pf-check', for: base }, cb, h('span', null, q.label, req)), err);
          break;
        }
        case 'person': {
          // Mode comptes seulement : la seule réponse admise est la personne qui répond.
          const me = session.user;
          const cb = control(h('input', { type: 'checkbox', disabled: !me }));
          read = () => (cb.checked && me ? me.id : null);
          body = h('div', { class: 'field pf-field' },
            h('span', { class: 'pf-label' }, q.label, req),
            h('label', { class: 'pf-check', for: base }, cb, h('span', null, me ? `Me désigner (${me.name})` : 'Me désigner')), err);
          break;
        }
        case 'page_link': {
          // Mode comptes seulement : recherche parmi les pages que la personne peut lire.
          let chosen = null;
          const q$ = h('input', { class: 'input', type: 'search', maxlength: '60', autocomplete: 'off', placeholder: 'Rechercher une page' });
          const results = h('ul', { class: 'pf-results', 'aria-label': `Pages trouvées : ${q.label}` });
          const chosenEl = h('p', { class: 'pf-chosen', 'aria-live': 'polite' });
          const paintChosen = () => put(chosenEl, chosen ? [h('span', null, `Page choisie : ${chosen.title}`), h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: () => { chosen = null; paintChosen(); q$.focus(); } }, 'Retirer')] : null);
          let timer = 0;
          q$.addEventListener('input', () => {
            clearTimeout(timer);
            timer = window.setTimeout(async () => {
              const text = q$.value.trim();
              if (!text) { put(results); return; }
              try {
                const found = (await api.get(`/search?${queryString({ q: text, limit: 8 })}`)).items ?? [];
                put(results, found.length ? found.map((x) => h('li', null, h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: () => { chosen = { id: x.id, title: x.title || 'Sans titre' }; put(results); q$.value = ''; paintChosen(); } }, x.title || 'Sans titre'))) : h('li', { class: 'muted' }, 'Aucun résultat.'));
              } catch { put(results, h('li', { class: 'muted' }, 'Recherche impossible.')); }
            }, 250);
          });
          read = () => chosen?.id ?? null;
          body = labelled(q$);
          body.insertBefore(h('div', { class: 'pf-picker' }, results, chosenEl), err);
          break;
        }
        default: {
          const type = q.type === 'url' ? 'url' : q.type === 'email' ? 'email' : q.type === 'phone' ? 'tel' : 'text';
          const auto = q.type === 'email' ? 'email' : q.type === 'phone' ? 'tel' : q.type === 'url' ? 'url' : 'off';
          const el = h('input', { class: 'input', type, maxlength: String(LIMITS[q.type] ?? 2000), autocomplete: auto, spellcheck: q.type === 'text' ? null : 'false', inputmode: q.type === 'url' ? 'url' : q.type === 'email' ? 'email' : q.type === 'phone' ? 'tel' : null, placeholder: q.type === 'url' ? 'https://…' : null });
          read = () => (el.value.trim() ? el.value.trim() : null);
          body = labelled(el);
        }
      }
      const setError = (msg) => {
        err.textContent = msg || '';
        err.hidden = !msg;
        for (const el of described) {
          if (msg) { el.setAttribute('aria-invalid', 'true'); el.setAttribute('aria-describedby', errId); } else { el.removeAttribute('aria-invalid'); el.removeAttribute('aria-describedby'); }
        }
        if (groupEl) { if (msg) groupEl.setAttribute('aria-describedby', errId); else groupEl.removeAttribute('aria-describedby'); }
      };
      fields.set(q.id, { q, read: () => read(), focus: () => focusEl?.focus(), setError });
      return body;
    }

    const showGlobal = (msg) => { globalErr.textContent = msg; globalErr.hidden = !msg; if (msg) globalErr.focus(); };

    /** Réponses lues dans le formulaire ; erreurs locales (champ obligatoire vide, nombre illisible) signalées par question. */
    function collect() {
      const answers = {};
      let first = null;
      for (const [id, f] of fields) {
        let v = null;
        let msg = '';
        try { v = f.read(); } catch (e) { msg = e.message; }
        if (!msg && f.q.required && (v === null || v === false)) msg = f.q.type === 'checkbox' ? 'Cochez cette case pour continuer.' : 'Cette question est obligatoire.';
        f.setError(msg);
        if (msg && !first) first = f;
        if (!msg && v !== null) answers[id] = v;
      }
      return { answers, first };
    }

    async function freshTicket() {
      const again = await api.get(`/public/forms/${token}`);
      ticket = again.ticket;
      issuedAt = Date.now();
    }

    // Le délai minimal ne bloque pas la saisie : on attend seulement, au besoin, le reste du délai avant l'envoi.
    async function send(answers, attempt = 0) {
      if (Date.now() - issuedAt > ttl - 60_000) await freshTicket();
      const wait = minDelay - (Date.now() - issuedAt);
      if (wait > 0) { status.textContent = 'Envoi dans un instant…'; await sleep(wait + 100); }
      status.textContent = 'Envoi en cours…';
      try {
        return await api.post(`/public/forms/${token}`, { answers, ticket, website: trap.value });
      } catch (err) {
        const reason = err?.data?.reason;
        if (attempt < 2 && reason === 'too_fast') { await sleep(Number(err.data?.minDelayMs) || minDelay || 3000); return send(answers, attempt + 1); }
        if (attempt < 1 && reason === 'ticket') { await freshTicket(); return send(answers, attempt + 1); }
        throw err;
      }
    }

    formEl.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (submit.disabled) return;
      showGlobal('');
      const { answers, first } = collect();
      if (first) { status.textContent = 'Le formulaire contient des erreurs.'; first.focus(); return; }
      submit.disabled = true;
      try {
        const res = await send(answers);
        if (alive) thanks(res?.thanks ?? '');
      } catch (err) {
        submit.disabled = false;
        status.textContent = '';
        const reason = err?.data?.reason;
        const target = err?.data?.questionId && fields.get(err.data.questionId);
        if (target && ['invalid', 'required', 'too_large'].includes(reason)) {
          target.setError(reason === 'required' ? 'Cette question est obligatoire.' : reason === 'too_large' ? 'Réponse trop longue.' : 'Réponse invalide : vérifiez le format.');
          target.focus();
        } else if (err?.status === 404) {
          stateScreen(main, 'ban', 'Formulaire introuvable ou fermé', 'Ce formulaire vient d’être fermé : votre réponse n’a pas été enregistrée.');
        } else if (err?.status === 401) {
          stateScreen(main, 'lock', 'Connexion requise', 'Votre session a expiré. Connectez-vous pour répondre : vous reviendrez ensuite sur ce formulaire.', h('a', { class: 'btn btn-primary', href: loginHref(path) }, 'Se connecter'));
        } else if (reason === 'unknown_question' || reason === 'ticket') {
          showGlobal('Le formulaire a changé ou a expiré : rechargez la page pour répondre.');
        } else if (reason === 'full') {
          showGlobal('Ce formulaire n’accepte plus de réponses pour le moment.');
        } else if (err?.status === 429) {
          showGlobal(reason === 'quota' ? 'Ce formulaire a reçu beaucoup de réponses : réessayez plus tard.' : 'Trop d’envois depuis votre connexion : réessayez dans une minute.');
        } else {
          showGlobal(err?.message || 'Envoi impossible. Réessayez dans un instant.');
        }
      }
    });

    function thanks(text) {
      const head = h('h1', { class: 'pf-state-title', tabindex: '-1' }, 'Merci');
      put(main, h('div', { class: 'pf-page' },
        h('header', { class: 'pf-top' }, h('span', { class: 'muted' }, 'Formulaire'), h('span', { class: 'muted' }, BRAND)),
        h('div', { class: 'pf-card pf-state' },
          h('div', { class: 'empty-emoji' }, icon('check', 32)), head,
          h('p', { class: 'pf-text' }, text || 'Votre réponse a été enregistrée.'),
          h('button', { class: 'btn btn-ghost', type: 'button', onClick: () => load() }, 'Envoyer une autre réponse'))));
      head.focus();
    }

    const hasRequired = form.questions.some((q) => q.required);
    put(formEl,
      globalErr,
      form.questions.map(question),
      trapBox,
      h('div', { class: 'row wrap pf-foot' }, submit, status));
    put(main, h('div', { class: 'pf-page' },
      h('header', { class: 'pf-top' }, h('span', { class: 'muted' }, 'Formulaire'), h('span', { class: 'muted' }, BRAND)),
      h('div', { class: 'pf-card' },
        h('h1', { id: 'pf-title', class: 'pf-title' }, form.title || 'Formulaire'),
        form.description && h('p', { class: 'pf-text' }, form.description),
        h('p', { class: 'muted pf-who' }, form.mode === 'anonymous'
          ? 'Réponse anonyme : ni compte ni nom ne sont enregistrés avec votre réponse.'
          : `Vous répondez avec votre compte${session.user ? ` (${session.user.name})` : ''}.`),
        hasRequired && h('p', { class: 'muted pf-who' }, 'Les questions marquées « obligatoire » doivent recevoir une réponse.'),
        formEl)));
  }

  await load();
}
