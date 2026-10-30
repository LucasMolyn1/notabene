// Paramètres de la recherche IA (fournisseur, modèles, clé).
import { h } from '../util.js';
import { icon } from '../icons.js';
import { api } from '../api.js';
import { session } from '../session.js';
import { toast } from '../ui.js';
import { askReauth } from '../provider-settings.js';
import * as A from '../actions.js';
import { card, kv, loadingEl, status } from './ui.js';

const MODEL_SUGGESTIONS = {
  anthropic: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
  openai: ['gpt-4o-mini', 'mistral-large-latest', 'llama3.1:8b'],
};

export async function renderAi(el) {
  const usage = card('Utilisation', null, h('p', null, 'Ouvrez la recherche avec ', h('kbd', null, '⌘K'), ', puis appuyez sur ', h('kbd', null, 'Tab'),
    ' pour passer à l’onglet « Demander à l’IA ». Les réponses s’appuient uniquement sur les pages que vous pouvez lire et citent leurs sources.'),
  session.can('ai') && h('button', { class: 'btn btn-ghost btn-sm', onClick: () => A.search() }, icon('sparkle', 14), ' Essayer maintenant'));

  if (!session.can('admin')) {
    el.replaceChildren(card('État', null, kv([['Recherche IA', status(session.config.ai, 'Activée', 'Non configurée')]]),
      !session.config.ai && h('p', { class: 'hint' }, 'Un administrateur doit configurer un fournisseur.')), usage);
    return;
  }

  el.replaceChildren(loadingEl());
  const current = await A.attempt(() => api.get('/admin/ai'));
  if (!current) return;
  const enabled = h('input', { type: 'checkbox' });
  enabled.checked = current.enabled;
  const provider = h('select', { class: 'input' },
    h('option', { value: 'anthropic' }, 'Anthropic Claude'),
    h('option', { value: 'openai' }, 'Compatible OpenAI (OpenAI, Mistral, Ollama, LM Studio…)'));
  provider.value = current.provider;
  const baseUrl = h('input', { class: 'input', placeholder: 'https://api.openai.com/v1', value: current.baseUrl || '' });
  const model = h('input', { class: 'input', list: 'ai-models', value: current.model });
  const models = h('datalist', { id: 'ai-models' });
  const apiKey = h('input', {
    class: 'input', type: 'password', autocomplete: 'off',
    placeholder: current.hasKey ? `Clé enregistrée (${current.keyHint}) : laisser vide pour la conserver` : 'Collez la clé d’API',
  });
  const removeKey = h('input', { type: 'checkbox' });
  const result = h('span', { class: 'hint' });
  const baseField = h('label', { class: 'field' }, h('span', null, 'URL de base'), baseUrl,
    h('small', { class: 'hint' }, 'Ollama : http://ollama:11434/v1 · LM Studio : http://hote:1234/v1. Une adresse du réseau interne ou en http exige AI_ALLOW_PRIVATE=true dans l’environnement du serveur.'));

  // Modèles réellement proposés par le fournisseur (chargés à la demande) ; suggestions par défaut sinon.
  let fetched = [];
  const paint = () => {
    baseField.hidden = provider.value !== 'openai';
    models.replaceChildren(...(fetched.length ? fetched : MODEL_SUGGESTIONS[provider.value]).map((m) => h('option', { value: m })));
  };
  provider.addEventListener('change', () => {
    fetched = [];
    modelsHint.textContent = '';
    paint();
    if (!MODEL_SUGGESTIONS[provider.value].includes(model.value)) model.value = MODEL_SUGGESTIONS[provider.value][0];
  });
  const modelsHint = h('small', { class: 'hint' });
  const loadModels = async ({ quiet = false } = {}) => {
    const body = { provider: provider.value };
    if (provider.value === 'openai' && baseUrl.value.trim()) body.baseUrl = baseUrl.value.trim();
    if (apiKey.value.trim()) body.apiKey = apiKey.value.trim();
    modelsHint.textContent = 'Chargement des modèles…';
    try {
      const r = await api.post('/admin/ai/models', body);
      fetched = r.models;
      modelsHint.textContent = fetched.length ? `${fetched.length} modèle${fetched.length > 1 ? 's' : ''} disponible${fetched.length > 1 ? 's' : ''} : cliquez dans le champ pour choisir.` : 'Le fournisseur ne propose aucun modèle.';
    } catch (err) {
      fetched = [];
      modelsHint.textContent = quiet ? 'Liste non chargée : saisissez le nom du modèle, ou utilisez « Charger les modèles ».' : err.message;
    }
    paint();
  };
  paint();

  const save = async () => {
    const payload = { enabled: enabled.checked, provider: provider.value, baseUrl: provider.value === 'openai' ? baseUrl.value.trim() : '', model: model.value.trim() };
    if (removeKey.checked) payload.apiKey = '';
    else if (apiKey.value.trim()) payload.apiKey = apiKey.value.trim();
    const reauth = await askReauth('modifier le fournisseur IA (la clé d’API est un secret)', { strict: true });
    if (!reauth) return false;
    payload.reauth = reauth;
    const saved = await A.attempt(() => api.put('/admin/ai', payload));
    if (!saved) return false;
    await session.load();
    toast('Réglages IA enregistrés');
    renderAi(el);
    return true;
  };

  el.replaceChildren(
    card('Fournisseur', 'Réglage commun à toute l’instance.', h('div', { class: 'stack' },
      h('label', { class: 'check' }, enabled, h('span', null, h('strong', null, 'Activer la recherche IA'), h('small', null, 'Les utilisateurs pourront interroger la documentation qu’ils ont le droit de lire.'))),
      h('label', { class: 'field' }, h('span', null, 'Fournisseur'), provider),
      baseField,
      h('label', { class: 'field' }, h('span', null, 'Modèle'), h('div', { class: 'row' }, model, h('button', { class: 'btn btn-ghost btn-sm', type: 'button', onClick: (e) => { e.preventDefault(); loadModels(); } }, 'Charger les modèles')), models, modelsHint),
      h('label', { class: 'field' }, h('span', null, 'Clé d’API'), apiKey,
        h('small', { class: 'hint' }, 'Chiffrée (AES-256-GCM) côté serveur et jamais renvoyée au navigateur. Optionnelle pour un modèle local.')),
      current.hasKey && h('label', { class: 'check' }, removeKey, h('span', null, 'Supprimer la clé enregistrée')),
      h('div', { class: 'row' },
        h('button', { class: 'btn btn-primary', onClick: save }, 'Enregistrer'),
        h('button', {
          class: 'btn btn-ghost',
          onClick: async () => {
            if (!(await save())) return;
            result.textContent = 'Test en cours…';
            const r = await A.attempt(() => api.post('/admin/ai/test'));
            result.textContent = r?.ok ? `Connexion réussie (« ${r.sample} »)` : r?.message || 'Échec';
          },
        }, 'Enregistrer et tester'),
        result))),
    card('Confidentialité', null, h('div', { class: 'notice info' }, 'Pour chaque question, seuls des extraits des pages pertinentes et lisibles par l’utilisateur sont envoyés au fournisseur, jamais tout le wiki. Avec un modèle local (Ollama), aucune donnée ne quitte votre infrastructure.')),
    usage);
  // Si un fournisseur est déjà configuré, on propose directement ses modèles.
  if (current.hasKey || (current.provider === 'openai' && current.baseUrl)) loadModels({ quiet: true });
}
