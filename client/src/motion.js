// Animations de l'interface : seul module qui importe GSAP. Les autres fichiers passent par ces fonctions.
// Principes :
// - préférence « réduire les animations » : aucune animation, état final immédiat ;
// - rien n'attend la fin d'une animation : l'élément est utilisable (clic, focus, clavier) dès son insertion ;
// - état final garanti : propriétés en ligne effacées à la fin, à l'interruption, en cas d'erreur et, en dernier recours, par
//   une minuterie (onglet en arrière-plan où requestAnimationFrame est suspendu, par exemple) ;
// - jamais l'éditeur lui-même (frappe, curseur, co-édition) ; listes : seuls les premiers éléments sont échelonnés.
import { gsap } from 'gsap';

const reduceQuery = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

/** Vrai si l'utilisateur a demandé de réduire les animations (relu à chaque appel : le réglage peut changer en cours de route). */
export const reducedMotion = () => !!reduceQuery?.matches;

const EASE_IN = 'power2.out';
const EASE_OUT = 'power1.in';
const CLEARED = 'opacity,transform,visibility';
const STAGGER_MAX = 15;
// Marge de la minuterie de secours au-delà de la durée prévue.
const SAFETY_MS = 500;

/** @param {any} targets @returns {HTMLElement[]} */
function list(targets) {
  if (!targets) return [];
  const arr = targets instanceof Element ? [targets] : Array.from(targets);
  return arr.filter((el) => el instanceof HTMLElement);
}

// Remet les styles en ligne posés par GSAP, même si GSAP lui-même a échoué.
function clear(els) {
  try { gsap.set(els, { clearProps: CLEARED }); } catch { /* repli ci-dessous */ }
  for (const el of els) {
    el.style.removeProperty('opacity');
    el.style.removeProperty('transform');
    el.style.removeProperty('visibility');
  }
}

/**
 * Joue une animation « depuis » un état vers l'état naturel de l'élément (ou vers `to` pour une sortie), puis efface tout.
 * @param {HTMLElement[]} els
 * @param {Record<string, any> | null} from
 * @param {Record<string, any>} to
 * @param {() => void} [done] appelé une seule fois, quoi qu'il arrive
 */
function play(els, from, to, done) {
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    clear(els);
    try { done?.(); } catch (err) { console.error(err); }
  };
  if (!els.length || reducedMotion()) { finish(); return; }
  try {
    gsap.killTweensOf(els);
    const vars = { ...to, overwrite: true, onComplete: finish, onInterrupt: finish };
    const tween = from ? gsap.fromTo(els, from, vars) : gsap.to(els, vars);
    const total = (to.delay ?? 0) + (to.duration ?? 0.2) + (typeof to.stagger === 'object' ? to.stagger.amount ?? 0 : 0);
    setTimeout(() => { if (!finished) { tween.kill(); finish(); } }, total * 1000 + SAFETY_MS);
  } catch (err) {
    console.error(err);
    finish();
  }
}

// Élément en cours de sortie : inerte, masqué aux technologies d'assistance, sans souris, et sans identifiants (une boîte
// rouverte aussitôt ne doit pas trouver de doublon d'id pendant que l'ancienne s'efface).
function retire(el) {
  el.inert = true;
  el.setAttribute('aria-hidden', 'true');
  el.style.pointerEvents = 'none';
  // Après tous les gestionnaires de l'évènement en cours (`close` des appelants, qui peuvent encore lire leurs champs).
  setTimeout(() => { for (const n of [el, ...el.querySelectorAll('[id]')]) n.removeAttribute('id'); }, 0);
}

/** Arrête toute animation en cours sur l'élément et le remet dans son état final. */
export function stop(target) {
  const els = list(target);
  if (!els.length) return;
  try { gsap.killTweensOf(els); } catch { /* sans effet */ }
  clear(els);
}

/** Apparition en fondu, avec un léger glissement vertical (`y` en pixels, 0 pour un fondu seul). */
export function fadeIn(target, { y = 6, duration = 0.22, delay = 0 } = {}) {
  const els = list(target).filter((el) => el.isConnected);
  play(els, { opacity: 0, y }, { opacity: 1, y: 0, duration, delay, ease: EASE_IN });
}

/** Panneau qui entre par le côté (`x` positif : depuis la droite). */
export function slideIn(target, { x = 16, duration = 0.25 } = {}) {
  const els = list(target).filter((el) => el.isConnected);
  play(els, { opacity: 0, x }, { opacity: 1, x: 0, duration, ease: EASE_IN });
}

/** Menus, popovers, palette : petit zoom depuis le point d'ancrage. */
export function popIn(target, { y = -4, duration = 0.16 } = {}) {
  const els = list(target).filter((el) => el.isConnected);
  play(els, { opacity: 0, y, scale: 0.98 }, { opacity: 1, y: 0, scale: 1, duration, ease: EASE_IN });
}

/** Changement de vue : le contenu principal apparaît. `y: 0` pour un fondu seul (page avec éditeur). */
export function pageIn(target, { y = 6 } = {}) {
  fadeIn(target, { y, duration: 0.25 });
}

/** Apparition échelonnée des premiers éléments d'une liste ; les suivants restent affichés tels quels. */
export function stagger(targets, { y = 4, duration = 0.18 } = {}) {
  const els = list(targets).filter((el) => el.isConnected).slice(0, STAGGER_MAX);
  if (els.length < 2) { fadeIn(els, { y, duration }); return; }
  play(els, { opacity: 0, y }, { opacity: 1, y: 0, duration, ease: EASE_IN, stagger: { amount: Math.min(0.15, els.length * 0.012) } });
}

/** Toast : entre par le bas. */
export function toastIn(target) {
  const els = list(target).filter((el) => el.isConnected);
  play(els, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.22, ease: EASE_IN });
}

/** Boîte de dialogue modale qui s'ouvre (après showModal). Le fond assombri s'affiche immédiatement. */
export function modalIn(target) {
  const els = list(target).filter((el) => el.isConnected);
  play(els, { opacity: 0, y: 8, scale: 0.98 }, { opacity: 1, y: 0, scale: 1, duration: 0.2, ease: EASE_IN });
}

/**
 * Sortie d'un élément flottant (menu, toast, palette) : il est retiré tout de suite de l'interaction (inerte, masqué aux
 * technologies d'assistance, ne capte plus la souris), puis s'efface et quitte le DOM. Sans animation, il est retiré aussitôt.
 */
export function leave(target, { y = 0, duration = 0.12 } = {}) {
  const el = list(target)[0];
  if (!el) return;
  if (reducedMotion() || !el.isConnected) { stop(el); el.remove(); return; }
  retire(el);
  play([el], null, { opacity: 0, y, duration, ease: EASE_OUT }, () => el.remove());
}

// Position d'une boîte de dialogue juste avant sa fermeture (une fois fermée, elle n'a plus de géométrie).
const dialogRects = new WeakMap();

/** À appeler juste avant `dialog.close()` (ou sur l'évènement `cancel`) pour permettre l'animation de fermeture. */
export function rememberDialog(dlg) {
  if (reducedMotion() || !dlg?.open) return;
  const r = dlg.getBoundingClientRect();
  if (r.width && r.height) dialogRects.set(dlg, r);
}

/**
 * Fermeture d'une modale (sur l'évènement `close`) : la boîte est déjà fermée (fond retiré, focus rendu, page utilisable).
 * Un fantôme inerte à la même place s'efface brièvement, puis l'élément est retiré du DOM.
 */
export function modalOut(dlg) {
  const r = dialogRects.get(dlg);
  dialogRects.delete(dlg);
  stop(dlg);
  if (reducedMotion() || !r || !dlg.isConnected || dlg.open) { dlg.remove(); return; }
  retire(dlg);
  Object.assign(dlg.style, {
    display: 'block', position: 'fixed', margin: '0', inset: 'auto', left: `${r.left}px`, top: `${r.top}px`,
    width: `${r.width}px`, height: `${r.height}px`, maxWidth: 'none', maxHeight: 'none', pointerEvents: 'none', zIndex: '95',
  });
  play([dlg], null, { opacity: 0, y: 4, scale: 0.98, duration: 0.15, ease: EASE_OUT }, () => dlg.remove());
}
