// Exécuté avant tout module (fichier externe : compatible CSP sans 'unsafe-inline').
// Polices Excalidraw servies localement : à définir avant l'évaluation de son module.
window.EXCALIDRAW_ASSET_PATH = location.origin + '/excalidraw-assets/';

// Applique le thème avant le premier rendu.
try {
  var p = JSON.parse(localStorage.getItem('notabene:prefs') || '{}');
  document.documentElement.dataset.theme = p.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
} catch (e) {
  document.documentElement.dataset.theme = 'light';
}
