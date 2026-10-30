// Photo de profil : affichage (avec les initiales en secours) et choix d'une image (recadrage, réduction, envoi).
import { api } from './api.js';
import { colorFor } from './presence.js';
import { session } from './session.js';
import { toast, openModal } from './ui.js';
import { h, initials } from './util.js';

const SIZE = 256;          // côté de l'image envoyée, en pixels
const VIEW = 240;          // côté de l'aperçu du recadrage
const MAX_SOURCE = 12 * 1024 * 1024;

/**
 * Pastille d'une personne : sa photo si elle en a une, sinon ses initiales sur une couleur stable.
 * @param {{ id: string, name: string }} user
 * @param {{ cls?: string, title?: string }} [opts]
 */
export function avatarEl(user, { cls = '', title } = {}) {
  const el = h('span', { class: `avatar ${cls}`.trim(), style: { '--c': colorFor(user.id) }, title }, initials(user.name));
  const at = session.avatars?.[user.id];
  if (at) {
    const img = h('img', { src: `/api/v3/users/${encodeURIComponent(user.id)}/avatar?v=${at}`, alt: '', decoding: 'async' });
    img.addEventListener('error', () => img.remove()); // photo retirée entre-temps : les initiales restent
    el.append(img);
  }
  return el;
}

// La barre latérale (et ce qui affiche des pastilles) se redessine : main.js écoute cet événement.
const announce = () => window.dispatchEvent(new Event('avatars-changed'));

const toBase64 = (buf) => {
  let s = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

// Cadre carré, déplaçable à la souris ou aux flèches, zoom par curseur ; l'image finale est recompressée (métadonnées retirées).
function cropper(bitmap) {
  const base = Math.max(VIEW / bitmap.width, VIEW / bitmap.height); // plus petit zoom qui remplit le cadre
  let zoom = 1;
  let ox = 0;
  let oy = 0;
  const canvas = h('canvas', { class: 'crop-canvas', width: VIEW, height: VIEW, tabindex: '0', role: 'img', 'aria-label': 'Aperçu de la photo : déplacez-la à la souris ou avec les flèches du clavier' });
  const clamp = () => {
    const w = bitmap.width * base * zoom;
    const hgt = bitmap.height * base * zoom;
    ox = Math.min(Math.max(ox, -(w - VIEW) / 2), (w - VIEW) / 2);
    oy = Math.min(Math.max(oy, -(hgt - VIEW) / 2), (hgt - VIEW) / 2);
  };
  const draw = (target, side) => {
    const c = target.getContext('2d');
    const k = (side / VIEW) * base * zoom;
    const w = bitmap.width * k;
    const hgt = bitmap.height * k;
    c.clearRect(0, 0, side, side);
    c.drawImage(bitmap, (side - w) / 2 + ox * (side / VIEW), (side - hgt) / 2 + oy * (side / VIEW), w, hgt);
  };
  const paint = () => { clamp(); draw(canvas, VIEW); };
  let drag = null;
  canvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, ox, oy }; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', (e) => { if (drag) { ox = drag.ox + e.clientX - drag.x; oy = drag.oy + e.clientY - drag.y; paint(); } });
  canvas.addEventListener('pointerup', () => { drag = null; });
  canvas.addEventListener('keydown', (e) => {
    const step = { ArrowLeft: [-8, 0], ArrowRight: [8, 0], ArrowUp: [0, -8], ArrowDown: [0, 8] }[e.key];
    if (!step) return;
    e.preventDefault();
    ox += step[0]; oy += step[1]; paint();
  });
  const slider = h('input', { type: 'range', min: '1', max: '4', step: '0.05', value: '1', class: 'crop-zoom', 'aria-label': 'Zoom' });
  slider.addEventListener('input', () => { zoom = Number(slider.value); paint(); });
  paint();
  return {
    el: h('div', { class: 'crop' }, canvas, h('label', { class: 'crop-zoom-row' }, h('span', null, 'Zoom'), slider)),
    async encode() {
      const out = h('canvas', { width: SIZE, height: SIZE });
      draw(out, SIZE);
      const blob = await new Promise((resolve) => out.toBlob(resolve, 'image/webp', 0.88));
      const final = blob?.type === 'image/webp' ? blob : await new Promise((resolve) => out.toBlob(resolve, 'image/jpeg', 0.9));
      return toBase64(await final.arrayBuffer());
    },
  };
}

// Ouvre le sélecteur de fichier puis le recadrage ; `onDone` est appelé une fois la photo enregistrée.
export function chooseAvatar(onDone) {
  const input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: true });
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.remove();
    if (!file) return;
    if (file.size > MAX_SOURCE) { toast('Image trop lourde (12 Mo au plus).', { kind: 'error' }); return; }
    let bitmap;
    try { bitmap = await createImageBitmap(file); } catch { toast('Image illisible. Choisissez un PNG, un JPEG ou un WebP.', { kind: 'error' }); return; }
    const crop = cropper(bitmap);
    openModal({
      title: 'Ma photo de profil',
      body: h('div', { class: 'stack' }, crop.el, h('p', { class: 'hint' }, 'L’image est recadrée en carré et réduite dans votre navigateur ; les métadonnées (lieu, appareil) ne sont pas conservées. Les autres personnes de l’instance verront cette photo.')),
      actions: [{ label: 'Annuler' }, {
        label: 'Enregistrer', primary: true,
        onClick: async () => {
          try {
            const r = await api.put('/me/avatar', { image: await crop.encode() });
            session.avatars = { ...session.avatars, [session.user.id]: r.updatedAt };
            toast('Photo de profil enregistrée');
            announce();
            onDone?.();
            return true;
          } catch (err) { toast(err.message || 'Enregistrement impossible', { kind: 'error' }); return false; }
        },
      }],
    });
  });
  document.body.append(input);
  input.click();
}

export async function removeAvatar(onDone) {
  try {
    await api.del('/me/avatar');
    session.avatars = Object.fromEntries(Object.entries(session.avatars || {}).filter(([id]) => id !== session.user.id));
    toast('Photo retirée');
    announce();
    onDone?.();
  } catch (err) { toast(err.message || 'Suppression impossible', { kind: 'error' }); }
}
