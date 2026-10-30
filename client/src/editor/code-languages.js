// Langages des blocs de code : nom stocké dans la page (attribut `language`), libellé et chargement à la demande
// (chaque grammaire est un fragment séparé du programme, chargé seulement quand un bloc l'utilise).
import { StreamLanguage } from '@codemirror/language';

const legacy = (load, name) => async () => StreamLanguage.define((await load())[name]);

export const LANGUAGES = [
  { id: '', label: 'Texte brut', load: null },
  { id: 'javascript', label: 'JavaScript', load: async () => (await import('@codemirror/lang-javascript')).javascript({ jsx: true }) },
  { id: 'typescript', label: 'TypeScript', load: async () => (await import('@codemirror/lang-javascript')).javascript({ typescript: true, jsx: true }) },
  { id: 'html', label: 'HTML', load: async () => (await import('@codemirror/lang-html')).html() },
  { id: 'css', label: 'CSS', load: async () => (await import('@codemirror/lang-css')).css() },
  { id: 'json', label: 'JSON', load: async () => (await import('@codemirror/lang-json')).json() },
  { id: 'markdown', label: 'Markdown', load: async () => (await import('@codemirror/lang-markdown')).markdown() },
  { id: 'yaml', label: 'YAML', load: async () => (await import('@codemirror/lang-yaml')).yaml() },
  { id: 'xml', label: 'XML', load: async () => (await import('@codemirror/lang-xml')).xml() },
  { id: 'python', label: 'Python', load: async () => (await import('@codemirror/lang-python')).python() },
  { id: 'sql', label: 'SQL', load: async () => (await import('@codemirror/lang-sql')).sql() },
  { id: 'bash', label: 'Shell (bash)', load: legacy(() => import('@codemirror/legacy-modes/mode/shell'), 'shell') },
  { id: 'powershell', label: 'PowerShell', load: legacy(() => import('@codemirror/legacy-modes/mode/powershell'), 'powerShell') },
  { id: 'dockerfile', label: 'Dockerfile', load: legacy(() => import('@codemirror/legacy-modes/mode/dockerfile'), 'dockerFile') },
  { id: 'nginx', label: 'Nginx', load: legacy(() => import('@codemirror/legacy-modes/mode/nginx'), 'nginx') },
  { id: 'toml', label: 'TOML / INI', load: legacy(() => import('@codemirror/legacy-modes/mode/toml'), 'toml') },
  { id: 'diff', label: 'Diff', load: legacy(() => import('@codemirror/legacy-modes/mode/diff'), 'diff') },
];

// Noms usuels (Markdown, Wiki.js, saisie « ```sh ») ramenés à un identifiant de la liste.
const ALIASES = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', node: 'javascript', ts: 'typescript', tsx: 'typescript',
  htm: 'html', svg: 'xml', yml: 'yaml', md: 'markdown', py: 'python', python3: 'python',
  sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash', ps1: 'powershell', docker: 'dockerfile',
  conf: 'nginx', ini: 'toml', patch: 'diff', jsonc: 'json', postgresql: 'sql', mysql: 'sql', plsql: 'sql',
};

export function normalizeLanguage(name) {
  const key = String(name || '').trim().toLowerCase();
  const id = ALIASES[key] ?? key;
  return LANGUAGES.some((l) => l.id === id) ? id : '';
}

const loaded = new Map();
/** Extension CodeMirror de la grammaire, ou null (texte brut, langage inconnu, échec de chargement). */
export async function languageExtension(name) {
  const entry = LANGUAGES.find((l) => l.id === normalizeLanguage(name));
  if (!entry?.load) return null;
  if (!loaded.has(entry.id)) loaded.set(entry.id, entry.load().catch(() => null));
  return loaded.get(entry.id);
}
