// Bloc de code : un éditeur CodeMirror 6 dans la page (coloration, indentation, fermeture des parenthèses, numéros de ligne).
// Le texte reste dans le document TipTap : chaque frappe est reportée dans la page (donc dans la co-édition Yjs) par un
// remplacement minimal, et les changements venus d'ailleurs sont reportés dans CodeMirror de la même façon.
import CodeBlock from '@tiptap/extension-code-block';
import { Compartment, EditorState, Annotation } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, drawSelection, highlightActiveLine } from '@codemirror/view';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { classHighlighter } from '@lezer/highlight';
import { TextSelection } from '@tiptap/pm/state';
import { h } from '../util.js';
import { LANGUAGES, languageExtension, normalizeLanguage } from './code-languages.js';

const fromPage = Annotation.define(); // changement venu de la page : à ne pas renvoyer à la page

/** Plus petit remplacement qui transforme `a` en `b`. */
function diff(a, b) {
  let start = 0;
  const max = Math.min(a.length, b.length);
  while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) { endA--; endB--; }
  return { from: start, to: endA, insert: b.slice(start, endB) };
}

export const CodeBlockEditor = CodeBlock.extend({
  addAttributes() {
    return { ...this.parent?.(), language: { default: null, parseHTML: (el) => el.querySelector('code')?.className.match(/language-(\S+)/)?.[1] ?? null } };
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      let current = node;
      let updating = false;
      const editable = new Compartment();
      const language = new Compartment();

      const select = h('select', { class: 'code-lang', 'aria-label': 'Langage du bloc de code' },
        LANGUAGES.map((l) => h('option', { value: l.id }, l.label)));
      const label = h('span', { class: 'code-lang-label' });
      const dom = h('div', { class: 'code-block', contenteditable: 'false' }, h('div', { class: 'code-bar' }, select, label));
      const host = h('div', { class: 'code-host' });
      dom.append(host);

      const pos = () => (typeof getPos === 'function' ? getPos() : null);

      // CodeMirror -> page : texte (remplacement minimal) et sélection.
      const forward = (cm) => {
        const p = pos();
        if (p == null) return;
        const start = p + 1;
        const { from: a, to: b, insert } = diff(current.textContent, cm.state.doc.toString());
        const tr = editor.state.tr;
        if (insert) tr.replaceWith(start + a, start + b, editor.schema.text(insert));
        else if (a !== b) tr.delete(start + a, start + b);
        const sel = cm.state.selection.main;
        const next = TextSelection.create(tr.doc, start + sel.from, start + sel.to);
        if (!tr.docChanged && next.eq(editor.state.selection)) return;
        tr.setSelection(next);
        updating = true;
        editor.view.dispatch(tr);
        updating = false;
      };

      // Sortie par les bords (flèches) : la sélection passe dans la page, avant ou après le bloc.
      const leave = (key) => (cm) => {
        const p = pos();
        const sel = cm.state.selection.main;
        if (p == null || !sel.empty) return false;
        const lines = cm.state.doc.lines;
        const line = cm.state.doc.lineAt(sel.head).number;
        const before = key === 'ArrowUp' ? line === 1 : key === 'ArrowLeft' ? sel.head === 0 : false;
        const after = key === 'ArrowDown' ? line === lines : key === 'ArrowRight' ? sel.head === cm.state.doc.length : false;
        if (!before && !after) return false;
        const { doc } = editor.state;
        const target = before ? p : Math.min(p + current.nodeSize, doc.content.size);
        editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(doc.resolve(target), before ? -1 : 1)).scrollIntoView());
        editor.view.focus();
        return true;
      };
      const escape = () => {
        const p = pos();
        if (p == null) return false;
        const after = p + current.nodeSize;
        editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(Math.min(after, editor.state.doc.content.size)), 1)).scrollIntoView());
        editor.view.focus();
        return true;
      };

      const cm = new EditorView({
        parent: host,
        state: EditorState.create({
          doc: node.textContent,
          extensions: [
            lineNumbers(), drawSelection(), highlightActiveLine(), bracketMatching(), closeBrackets(), indentOnInput(),
            syntaxHighlighting(classHighlighter),
            EditorView.contentAttributes.of({ 'aria-label': 'Code. Échap pour quitter le bloc.', spellcheck: 'false' }),
            keymap.of([
              { key: 'Escape', run: escape },
              { key: 'ArrowUp', run: leave('ArrowUp') }, { key: 'ArrowLeft', run: leave('ArrowLeft') },
              { key: 'ArrowDown', run: leave('ArrowDown') }, { key: 'ArrowRight', run: leave('ArrowRight') },
              // L'historique est celui de la page (et de la co-édition), pas celui de CodeMirror.
              { key: 'Mod-z', run: () => editor.commands.undo(), preventDefault: true },
              { key: 'Mod-y', run: () => editor.commands.redo(), preventDefault: true },
              { key: 'Mod-Shift-z', run: () => editor.commands.redo(), preventDefault: true },
              indentWithTab, ...closeBracketsKeymap, ...defaultKeymap,
            ]),
            editable.of([EditorView.editable.of(editor.isEditable), EditorState.readOnly.of(!editor.isEditable)]),
            language.of([]),
            EditorView.updateListener.of((u) => {
              if (updating) return;
              const external = u.transactions.some((t) => t.annotation(fromPage));
              if ((u.docChanged && !external) || (u.selectionSet && u.view.hasFocus)) forward(u.view);
            }),
          ],
        }),
      });

      const paintLanguage = () => {
        const id = normalizeLanguage(current.attrs.language);
        select.value = id;
        label.textContent = LANGUAGES.find((l) => l.id === id)?.label ?? '';
        languageExtension(id).then((ext) => cm.dispatch({ effects: language.reconfigure(ext ?? []) }));
      };
      const paintEditable = () => {
        select.hidden = !editor.isEditable;
        label.hidden = editor.isEditable;
        cm.dispatch({ effects: editable.reconfigure([EditorView.editable.of(editor.isEditable), EditorState.readOnly.of(!editor.isEditable)]) });
      };
      select.addEventListener('change', () => {
        const p = pos();
        if (p != null) editor.view.dispatch(editor.state.tr.setNodeMarkup(p, undefined, { ...current.attrs, language: select.value || null }));
      });

      paintLanguage();
      paintEditable();
      editor.on('update', paintEditable);

      return {
        dom,
        update(updated) {
          if (updated.type !== current.type) return false;
          const languageChanged = updated.attrs.language !== current.attrs.language;
          current = updated;
          if (languageChanged) paintLanguage();
          if (!updating) {
            const change = diff(cm.state.doc.toString(), updated.textContent);
            if (change.from !== change.to || change.insert) cm.dispatch({ changes: change, annotations: fromPage.of(true) });
          }
          return true;
        },
        // CodeMirror gère ses propres événements ; la page ne doit pas les traiter.
        stopEvent: () => true,
        ignoreMutation: () => true,
        selectNode: () => cm.focus(),
        setSelection: (anchor, head) => {
          cm.focus();
          updating = true;
          cm.dispatch({ selection: { anchor, head } });
          updating = false;
        },
        destroy: () => { editor.off('update', paintEditable); cm.destroy(); },
      };
    };
  },
});
