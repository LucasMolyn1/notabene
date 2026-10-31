// Actions sur le texte sélectionné, pour l'écran tactile où la bulle flottante n'existe pas : couleur, fond, alignement,
// commentaire et assistant de rédaction. Même palette fixe que la bulle (le contenu ne garde que le nom de la couleur).
import { h } from '../util.js';
import { openModal, toast } from '../ui.js';
import { COLORS } from './blocks.js';

export function openSelectionSheet(editor, ctx = {}) {
  const { from, to, empty } = editor.state.selection;
  if (empty) { toast('Sélectionnez d’abord du texte.', { kind: 'error' }); return; }
  let m = null;
  // Les commandes s'appliquent à la sélection conservée par l'éditeur ; le focus revient dessus à la fermeture.
  const act = (run) => () => { run(editor.chain().focus()); m.close(); };
  const swatch = (c, kind) => h('button', {
    class: `swatch swatch-${kind}`, type: 'button', 'data-color': c.id,
    'aria-label': `${kind === 'text' ? 'Texte' : 'Fond'} ${c.label}`,
    onClick: act((ch) => (kind === 'text' ? ch.setTextColor(c.id) : ch.setHighlight({ color: c.id })).run()),
  }, kind === 'text' ? 'A' : '');
  const plain = (label, run) => h('button', { class: 'btn btn-ghost', type: 'button', onClick: act(run) }, label);
  const row = (caption, ...items) => h('div', { class: 'sheet-row', role: 'group', 'aria-label': caption }, h('span', { class: 'bubble-cap' }, caption), ...items);

  m = openModal({
    title: 'Texte sélectionné',
    body: h('div', { class: 'stack' },
      row('Texte', ...COLORS.map((c) => swatch(c, 'text')), plain('Par défaut', (ch) => ch.unsetTextColor().run())),
      row('Fond', ...COLORS.map((c) => swatch(c, 'bg')), plain('Sans fond', (ch) => ch.unsetHighlight().run())),
      row('Alignement', plain('Gauche', (ch) => ch.setAlign('left').run()), plain('Centre', (ch) => ch.setAlign('center').run()),
        plain('Droite', (ch) => ch.setAlign('right').run()), plain('Justifié', (ch) => ch.setAlign('justify').run())),
      (ctx.onComment || ctx.onAssist) && row('Aller plus loin',
        ctx.onComment && h('button', {
          class: 'btn btn-ghost', type: 'button',
          onClick: () => {
            const text = editor.state.doc.textBetween(from, to, ' ').trim().slice(0, 200);
            m.close();
            if (text) ctx.onComment({ from, to, text });
          },
        }, 'Commenter'),
        ctx.onAssist && h('button', { class: 'btn btn-ghost', type: 'button', onClick: () => { m.close(); ctx.onAssist({ from, to }); } }, 'Assistant de rédaction'))),
    actions: [{ label: 'Fermer' }],
  });
}
