// Assistant de rédaction : améliorer, raccourcir, corriger, traduire ou suivre une consigne sur le texte sélectionné.
// La réponse s'affiche dans un aperçu (texte brut) ; la page n'est modifiée qu'après « Remplacer » ou « Insérer après ».
import { h } from './util.js';
import { streamAssist } from './api.js';
import { session } from './session.js';
import { TextSelection } from '@tiptap/pm/state';
import { openModal, toast } from './ui.js';

const MAX_SELECTION = 8000;
const LANGUAGES = [['fr', 'Français'], ['en', 'Anglais'], ['es', 'Espagnol'], ['de', 'Allemand'], ['it', 'Italien'], ['pt', 'Portugais'], ['nl', 'Néerlandais']];

// Texte du résultat -> paragraphes. Jamais de HTML : des nœuds `text` décrits en JSON, que TipTap n'interprète pas.
export function textToNodes(text) {
  const paragraphs = text.replace(/\r\n?/g, '\n').split(/\n+/).map((s) => s.trim()).filter(Boolean);
  return paragraphs.map((s) => ({ type: 'paragraph', content: [{ type: 'text', text: s }] }));
}

export function openAssistant(editor, { pageId, selection }) {
  const { from, to } = selection;
  // Sélection de cellules ou de tout le document : l'intervalle couvre plus que le texte choisi, on n'y touche pas.
  if (!(editor.state.selection instanceof TextSelection)) { toast('Sélectionnez du texte dans un seul paragraphe ou bloc de texte.', { kind: 'error' }); return; }
  const original = editor.state.doc.textBetween(from, to, '\n').trim();
  if (!original) { toast('Sélectionnez d’abord du texte.', { kind: 'error' }); return; }
  if (original.length > MAX_SELECTION) { toast(`Sélection trop longue (${MAX_SELECTION} caractères au plus).`, { kind: 'error' }); return; }

  let controller = null;
  let result = '';
  let partial = false; // erreur, refus ou troncature : le texte reçu est incomplet, on ne propose pas de l'écrire
  const status = h('p', { class: 'muted', role: 'status' });
  const preview = h('div', { class: 'assist-preview', 'aria-live': 'polite', tabindex: '0', 'aria-label': 'Texte proposé' });
  preview.hidden = true;
  const language = h('select', { class: 'input', 'aria-label': 'Langue de la traduction' }, LANGUAGES.map(([v, l]) => h('option', { value: v }, l)));
  const instruction = h('input', { class: 'input', 'aria-label': 'Consigne libre', placeholder: 'Ex. : plus formel, en trois puces…', maxlength: '500' });
  const apply = h('button', { class: 'btn btn-primary', type: 'button', disabled: true }, 'Remplacer');
  const after = h('button', { class: 'btn btn-ghost', type: 'button', disabled: true }, 'Insérer après');
  const stop = h('button', { class: 'btn btn-ghost', type: 'button', hidden: true }, 'Arrêter');

  const destination = session.aiProvider;
  const notice = h('div', { class: 'notice info' },
    destination
      ? `Le texte sélectionné (${original.length} caractères) sera envoyé à ${destination}. Rien d’autre : ni le titre, ni le reste de la page.`
      : `Le texte sélectionné (${original.length} caractères) sera envoyé au fournisseur d’IA de l’instance.`,
    ' La page n’est modifiée que si vous cliquez sur « Remplacer » ou « Insérer après ».');

  const setBusy = (busy) => {
    for (const b of actionButtons) b.disabled = busy;
    stop.hidden = !busy;
    apply.disabled = busy || !result || partial;
    after.disabled = busy || !result || partial;
  };

  async function run(body) {
    controller?.abort();
    controller = new AbortController();
    result = '';
    partial = false;
    preview.hidden = false;
    preview.textContent = '';
    status.textContent = 'Rédaction en cours…';
    setBusy(true);
    await streamAssist({ pageId, text: original, ...body }, {
      signal: controller.signal,
      onDelta: (t) => { result += t; preview.textContent = result; }, // textContent : le texte ne devient jamais du HTML
      onNotice: (message) => { partial = true; status.textContent = `${message} Le texte est incomplet : relancez ou reformulez.`; },
      onError: (message) => { partial = true; status.textContent = ''; toast(message, { kind: 'error' }); },
      onDone: () => { if (!partial) status.textContent = result.trim() ? 'Relisez le texte proposé, puis choisissez.' : 'Aucune proposition.'; },
    });
    if (controller.signal.aborted) { partial = true; status.textContent = result.trim() ? 'Interrompu : texte partiel, rien ne sera écrit.' : ''; }
    result = result.trim();
    setBusy(false);
  }

  // La sélection d'origine doit toujours être là, identique : sinon (modification ou co-édition entre-temps) on n'écrit rien.
  const stillThere = () => {
    const size = editor.state.doc.content.size;
    return to <= size && editor.state.doc.textBetween(from, to, '\n').trim() === original;
  };
  const write = (at) => {
    if (!stillThere()) { toast('Le texte a changé depuis la sélection : rien n’a été modifié.', { kind: 'error' }); return false; }
    const nodes = textToNodes(result);
    if (!nodes.length) return false;
    if (at === 'replace') {
      // Une seule ligne : texte en place dans le paragraphe ; sinon des paragraphes.
      editor.chain().focus().insertContentAt({ from, to }, nodes.length === 1 ? nodes[0].content : nodes).run();
    } else {
      const $to = editor.state.doc.resolve(to);
      editor.chain().focus().insertContentAt($to.depth ? $to.after() : editor.state.doc.content.size, nodes).run();
    }
    return true;
  };

  const choice = (label, body) => h('button', { class: 'btn btn-ghost', type: 'button', onClick: () => run(body) }, label);
  const translate = h('button', { class: 'btn btn-ghost', type: 'button', onClick: () => run({ action: 'translate', language: language.value }) }, 'Traduire');
  const custom = h('button', { class: 'btn btn-ghost', type: 'button', onClick: () => { if (instruction.value.trim().length >= 3) run({ action: 'custom', instruction: instruction.value.trim() }); else instruction.focus(); } }, 'Appliquer');
  const actionButtons = [
    choice('Améliorer', { action: 'improve' }), choice('Raccourcir', { action: 'shorten' }), choice('Corriger', { action: 'fix' }), translate, custom,
  ];
  instruction.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); custom.click(); } });
  stop.addEventListener('click', () => controller?.abort());

  const m = openModal({
    title: 'Assistant de rédaction',
    size: 'wide',
    body: h('div', { class: 'stack' },
      notice,
      h('blockquote', { class: 'assist-source', 'aria-label': 'Texte sélectionné' }, original.length > 400 ? `${original.slice(0, 400)}…` : original),
      h('div', { class: 'assist-actions', role: 'group', 'aria-label': 'Que faire de ce texte ?' },
        actionButtons.slice(0, 3), h('span', { class: 'assist-inline' }, translate, language)),
      h('div', { class: 'assist-inline' }, instruction, custom),
      status, preview,
      h('div', { class: 'assist-actions' }, apply, after, stop),
      h('p', { class: 'hint' }, 'Le texte inséré est du texte simple : la mise en forme de la sélection (gras, liens…) n’est pas conservée. Relisez toujours : l’IA peut se tromper.')),
    actions: [{ label: 'Fermer' }],
  });
  apply.addEventListener('click', () => { if (write('replace')) m.close(); });
  after.addEventListener('click', () => { if (write('after')) m.close(); });
  m.el.addEventListener('close', () => controller?.abort());
}
