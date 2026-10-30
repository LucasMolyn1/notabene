// Adresses lisibles : /p/titre-de-la-page-<identifiant>. Seul l'identifiant (12 caractères) compte : le titre n'est qu'un décor.
// Même règle que client/src/urls.js.
export const ID_LENGTH = 12;

export function slugOf(title: string): string {
  return title.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/œ/g, 'oe').replace(/æ/g, 'ae').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 60).replace(/-+$/, '');
}

export function segmentOf(id: string, title: string): string {
  const slug = slugOf(title);
  return slug ? `${slug}-${id}` : id;
}

// Identifiant contenu dans un segment d'adresse (les 12 derniers caractères, précédés d'un tiret ou de rien) ; null si le segment est invalide.
export function idFromSegment(seg: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(seg)) return null;
  return seg.length > ID_LENGTH && /^[a-z0-9-]*-[A-Za-z0-9_-]{12}$/.test(seg) ? seg.slice(-ID_LENGTH) : seg;
}
