// Icône de page importée : une image raster par page au plus, désignée par `pages.icon = 'img:<identifiant>'`.
// Règles :
//  - formats PNG, JPEG, WebP et GIF seulement, reconnus sur les octets (jamais l'extension ni le type annoncé) ; aucun SVG ;
//  - 512 Ko et 1024 pixels de côté au plus ; GIF et WebP animés : images dans le cadre déclaré, 300 au plus ;
//  - aucune dépendance de réencodage : les métadonnées (EXIF, GPS, XMP, textes) sont retirées bloc par bloc (lib/image-meta.ts),
//    l'image nettoyée est revérifiée, et sa réponse ne peut rien exécuter (type fixe, nosniff, CSP sandbox) ;
//  - plafonds communs avec les pièces jointes (instance et personne) : 413 à l'import, icône vide à la copie ;
//  - identifiant aléatoire de 128 bits, neuf à chaque remplacement (l'ancienne adresse cesse de répondre) ;
//  - une page ne désigne que sa propre image : toute autre valeur `img:` est refusée à l'enregistrement, ignorée à la création ;
//  - copie et duplication : l'image est copiée pour la nouvelle page (jamais partagée entre deux pages).
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { DB } from '../db.js';
import { type AttachmentCloner, reservations, usedBytes, userBytes } from './attachments.js';
import { HttpError } from './http.js';
import { imageInfo, type ImageMime } from './image-info.js';
import { stripImageMetadata } from './image-meta.js';

export const ICON_IMAGE_MAX_BYTES = 512 * 1024;
export const ICON_IMAGE_MAX_SIDE = 1024;
export const ICON_IMAGE_MIN_SIDE = 8;
export const ICON_IMAGE_ID = /^[A-Za-z0-9_-]{22}$/;
const ICON_IMAGE_VALUE = /^img:([A-Za-z0-9_-]{22})$/;
const PREFIX = 'img:';

/** Champ `icon` d'une page : emoji ou nom d'icône (16 caractères au plus, sans le préfixe réservé), ou `img:<identifiant>`. */
export const pageIconSchema = z.string().max(26).refine(
  (v) => ICON_IMAGE_VALUE.test(v) || (v.length <= 16 && !v.startsWith(PREFIX)),
  'icône invalide : 16 caractères au plus, ou img:<identifiant>',
);

/** Identifiant d'image désigné par une icône, ou null (emoji, nom d'icône, vide). */
export const iconImageId = (icon: string | null | undefined): string | null => (icon ? ICON_IMAGE_VALUE.exec(icon)?.[1] ?? null : null);
/** L'icône utilise le préfixe réservé aux images (bien formée ou non). */
export const isImageIcon = (icon: string | null | undefined): boolean => !!icon && icon.startsWith(PREFIX);
/** Icône affichable en texte (export, modèle) : vide pour une image. */
export const textIcon = (icon: string | null | undefined): string => (icon && !isImageIcon(icon) ? icon : '');

export interface IconImageRow { id: string; page_id: string; mime: ImageMime; data: Buffer; size: number; sha256: string; created_at: number }

export const getIconImage = (db: DB, id: string): IconImageRow | undefined =>
  ICON_IMAGE_ID.test(id) ? db.prepare('SELECT id, page_id, mime, data, size, sha256, created_at FROM page_icon_images WHERE id = ?').get(id) as IconImageRow | undefined : undefined;

const INFO_OPTIONS = { gif: true, animated: true } as const;

/**
 * Contrôle des octets reçus : type reconnu sur la signature, poids et dimensions bornés, puis retrait des métadonnées. L'image
 * nettoyée est revérifiée (même type, mêmes dimensions). Renvoie le type et les octets nettoyés, ou lève 400 / 413.
 */
export function checkIconImage(raw: Buffer): { mime: ImageMime; data: Buffer } {
  if (raw.length === 0) throw new HttpError(400, 'Image vide');
  if (raw.length > ICON_IMAGE_MAX_BYTES) throw new HttpError(413, 'Image trop lourde (512 Ko au plus)');
  const info = imageInfo(raw, INFO_OPTIONS);
  if (!info) throw new HttpError(400, 'Format non pris en charge : PNG, JPEG, WebP ou GIF');
  if (info.width < ICON_IMAGE_MIN_SIDE || info.height < ICON_IMAGE_MIN_SIDE || info.width > ICON_IMAGE_MAX_SIDE || info.height > ICON_IMAGE_MAX_SIDE) {
    throw new HttpError(400, `Dimensions attendues : entre ${ICON_IMAGE_MIN_SIDE} et ${ICON_IMAGE_MAX_SIDE} pixels de côté`);
  }
  const data = stripImageMetadata(raw, info.mime);
  const again = data ? imageInfo(data, INFO_OPTIONS) : null;
  if (!data || !again || again.mime !== info.mime || again.width !== info.width || again.height !== info.height) {
    throw new HttpError(400, 'Image incomplète ou mal formée');
  }
  return { mime: info.mime, data };
}

/** Plafonds communs avec les pièces jointes, en octets. */
export interface IconLimits { totalBytes: number; userBytes: number }

function insertIconImage(db: DB, pageId: string, data: Buffer, mime: ImageMime, userId: string | null): string {
  const id = randomBytes(16).toString('base64url');
  db.prepare('INSERT INTO page_icon_images (id, page_id, mime, data, size, sha256, uploader_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, pageId, mime, data, data.length, createHash('sha256').update(data).digest('hex'), userId, Date.now());
  return `${PREFIX}${id}`;
}

/**
 * Enregistre l'image d'une page (déjà contrôlée par checkIconImage) et retire la précédente. Renvoie la valeur d'icône à écrire.
 * Plafonds de l'instance et de la personne (pièces jointes et icônes, envois en cours compris) : 413 s'ils seraient dépassés.
 * À appeler dans la transaction qui écrit `pages.icon` (un refus l'annule, l'ancienne image revient).
 */
export function storeIconImage(db: DB, pageId: string, data: Buffer, mime: ImageMime, userId: string | null, limits: IconLimits): string {
  // L'ancienne image est retirée d'abord : elle ne compte pas contre son remplacement.
  db.prepare('DELETE FROM page_icon_images WHERE page_id = ?').run(pageId);
  const held = reservations(db);
  if (usedBytes(db) + held.total + data.length > limits.totalBytes) throw new HttpError(413, 'Espace de stockage des pièces jointes plein');
  if (userId && userBytes(db, userId) + (held.byUser.get(userId)?.bytes ?? 0) + data.length > limits.userBytes) {
    throw new HttpError(413, `Quota personnel de pièces jointes atteint (${Math.round(limits.userBytes / 1024 / 1024)} Mo)`);
  }
  return insertIconImage(db, pageId, data, mime, userId);
}

/** Une icône `img:` n'est acceptée que si elle désigne l'image de cette page. 400 sinon (sans dire à qui elle appartient). */
export function assertIconForPage(db: DB, pageId: string, icon: string): void {
  if (!isImageIcon(icon)) return;
  const id = iconImageId(icon);
  const row = id ? db.prepare('SELECT 1 FROM page_icon_images WHERE id = ? AND page_id = ?').get(id, pageId) : undefined;
  if (!row) throw new HttpError(400, 'Icône image inconnue pour cette page : importez-la d’abord');
}

/** L'icône de la page a changé : l'image qu'elle ne désigne plus est retirée (une seule image courante par page). */
export function dropStaleIconImage(db: DB, pageId: string, icon: string): void {
  db.prepare('DELETE FROM page_icon_images WHERE page_id = ? AND id IS NOT ?').run(pageId, iconImageId(icon));
}

/**
 * Copie de page : si la source a une icône image, elle est copiée pour la destination (nouvel identifiant) et l'icône de la
 * destination la désigne. Image disparue, plafond dépassé (`cloner` : opération, instance, personne) ou copie sans copieur :
 * la destination garde l'icône par défaut (vide), sans faire échouer la copie. À appeler dans la transaction qui crée la
 * destination ; l'appelant a vérifié que la source est lisible.
 */
export function copyIconImage(db: DB, sourcePageId: string, sourceIcon: string, targetPageId: string, userId: string | null, cloner?: AttachmentCloner): string {
  const id = iconImageId(sourceIcon);
  if (!id) return textIcon(sourceIcon);
  const src = db.prepare('SELECT mime, data FROM page_icon_images WHERE id = ? AND page_id = ?').get(id, sourcePageId) as { mime: ImageMime; data: Buffer } | undefined;
  const icon = src && cloner?.allowExtra(src.data.length) ? insertIconImage(db, targetPageId, src.data, src.mime, userId) : '';
  db.prepare('UPDATE pages SET icon = ? WHERE id = ?').run(icon, targetPageId);
  return icon;
}
