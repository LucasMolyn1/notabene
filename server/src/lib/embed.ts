// Contenus intégrés (iframe) : seuls des hôtes choisis par un administrateur peuvent s'afficher.
// Deux protections se superposent : l'en-tête CSP `frame-src` (le navigateur refuse tout autre hôte, quoi que contienne une page)
// et la forme de l'adresse enregistrée dans la page (https, sans identifiants, sans port, nom de domaine).
const LABEL = /^[a-z0-9-]{1,63}$/;
const TLD = /^[a-z]{2,63}$/;

// Nom de domaine ASCII d'au moins deux étiquettes, dernière étiquette alphabétique (donc jamais une adresse IP).
function isDomain(host: string): boolean {
  if (host.length < 4 || host.length > 253) return false;
  const labels = host.split('.');
  return labels.length >= 2 && TLD.test(labels.at(-1)!) && labels.every((l) => LABEL.test(l) && !l.startsWith('-') && !l.endsWith('-'));
}

/** Nom d'hôte d'une liste d'autorisation : domaine ASCII exact, jamais une adresse IP, un joker, un port ni un chemin. */
export function normalizeEmbedHost(raw: string): string | null {
  const host = raw.trim().toLowerCase();
  return isDomain(host) ? host : null;
}

/** Adresse d'un contenu intégré : https, nom de domaine, sans identifiants ni port ; renvoie l'adresse normalisée ou null. */
export function embedUrl(raw: unknown): string | null {
  // eslint-disable-next-line no-control-regex -- on refuse justement les caractères de contrôle et les espaces
  if (typeof raw !== 'string' || raw.length > 2048 || /[\u0000-\u001f\u007f\s]/.test(raw)) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !normalizeEmbedHost(url.hostname)) return null;
  return url.href.length <= 2048 ? url.href : null;
}

export const embedHostOf = (url: string): string | null => { try { return new URL(url).hostname; } catch { return null; } };

/** Hôte de l'application : il ne peut pas figurer dans la liste (une page de Notabene intégrée dans Notabene n'est pas isolée). */
export const selfHost = (publicUrl: string): string => new URL(publicUrl).hostname.toLowerCase();
