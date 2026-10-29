// Préférences d'interface, propres à ce navigateur (distinctes des données du wiki).
const KEY = 'notabene:prefs';
const DEFAULTS = { theme: null, sidebar: true, expanded: {}, lastPage: null, space: null, readOnly: false };

export const prefs = (() => {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; }
  catch { return { ...DEFAULTS }; }
})();

export function savePrefs() {
  try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* navigation privée */ }
}

export const currentTheme = () => document.documentElement.dataset.theme || 'light';

// theme : 'light', 'dark' ou null (suit le système).
export function setTheme(theme) {
  prefs.theme = theme;
  document.documentElement.dataset.theme = theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  savePrefs();
}

export const app = {
  embed: new URLSearchParams(location.search).has('embed'),
};
