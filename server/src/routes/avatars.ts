// Photo de profil : une image raster par personne (PNG, JPEG ou WebP), rangée dans la base, jamais servie comme page.
// Le navigateur la recadre et la réduit avant l'envoi ; le serveur ne lui fait pas confiance pour autant : type vérifié sur
// les octets, poids et dimensions bornés, aucun SVG, et réponse servie sans pouvoir exécuter quoi que ce soit.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { guard, requireAuth } from '../auth/context.js';
import { audit } from '../lib/audit.js';
import { HttpError, idParams } from '../lib/http.js';
import { imageInfo } from '../lib/image-info.js';

const AVATAR_MAX_BYTES = 256 * 1024;
const AVATAR_MAX_SIDE = 1024;
const AVATAR_MIN_SIDE = 32;

export default async function avatarRoutes(app: FastifyInstance) {
  const { db } = app;
  const tags = ['users'];

  // Qui a une photo, et depuis quand : l'interface n'interroge l'image que pour ces personnes.
  app.get('/users/avatars', { preHandler: guard('read'), schema: { tags, summary: 'Personnes ayant une photo de profil (identifiant → date de mise à jour)', hide: true } }, async () =>
    Object.fromEntries((db.prepare('SELECT user_id, updated_at FROM user_avatars').all() as { user_id: string; updated_at: number }[]).map((r) => [r.user_id, r.updated_at])));

  app.get('/users/:id/avatar', { preHandler: guard('read'), schema: { tags, summary: 'Photo de profil', hide: true, params: idParams } }, async (req, reply) => {
    const row = db.prepare('SELECT mime, data, updated_at FROM user_avatars WHERE user_id = ?').get((req.params as { id: string }).id) as { mime: string; data: Buffer; updated_at: number } | undefined;
    if (!row) throw new HttpError(404, 'Aucune photo');
    const etag = `"${row.updated_at}"`;
    reply.header('etag', etag).header('cache-control', 'private, no-cache').header('content-security-policy', "default-src 'none'; sandbox");
    if (req.headers['if-none-match'] === etag) return reply.status(304).send();
    return reply.header('content-type', row.mime).header('content-disposition', 'inline').send(row.data);
  });

  app.put('/me/avatar', {
    config: { rateLimit: { max: 20, timeWindow: '1 hour' } },
    schema: { tags, summary: 'Définir ma photo de profil', hide: true, body: z.object({ image: z.string().max(Math.ceil(AVATAR_MAX_BYTES * 4 / 3) + 8).regex(/^[A-Za-z0-9+/]+={0,2}$/, 'image en base64 attendue') }) },
  }, async (req) => {
    const auth = requireAuth(req);
    if (auth.via !== 'session') throw new HttpError(403, 'La photo se règle depuis l’interface web');
    const data = Buffer.from((req.body as { image: string }).image, 'base64');
    if (data.length > AVATAR_MAX_BYTES) throw new HttpError(413, 'Image trop lourde (256 Ko au plus)');
    const info = imageInfo(data);
    if (!info) throw new HttpError(400, 'Format non pris en charge : PNG, JPEG ou WebP');
    if (info.width < AVATAR_MIN_SIDE || info.height < AVATAR_MIN_SIDE || info.width > AVATAR_MAX_SIDE || info.height > AVATAR_MAX_SIDE) {
      throw new HttpError(400, `Dimensions attendues : entre ${AVATAR_MIN_SIDE} et ${AVATAR_MAX_SIDE} pixels de côté`);
    }
    const at = Date.now();
    db.prepare('INSERT INTO user_avatars (user_id, mime, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET mime = excluded.mime, data = excluded.data, updated_at = excluded.updated_at')
      .run(auth.user.id, info.mime, data, at);
    audit(db, req, 'profile.avatar.set', auth.user.id);
    return { updatedAt: at };
  });

  app.delete('/me/avatar', { schema: { tags, summary: 'Retirer ma photo de profil', hide: true } }, async (req, reply) => {
    const auth = requireAuth(req);
    if (auth.via !== 'session') throw new HttpError(403, 'La photo se règle depuis l’interface web');
    db.prepare('DELETE FROM user_avatars WHERE user_id = ?').run(auth.user.id);
    audit(db, req, 'profile.avatar.remove', auth.user.id);
    return reply.status(204).send();
  });

  // Modération : un administrateur peut retirer la photo de quelqu'un d'autre (jamais la remplacer).
  app.delete('/admin/users/:id/avatar', { preHandler: guard('admin'), schema: { tags: ['admin'], summary: 'Retirer la photo d’un compte', hide: true, params: idParams } }, async (req, reply) => {
    const { id } = req.params as { id: string };
    db.prepare('DELETE FROM user_avatars WHERE user_id = ?').run(id);
    audit(db, req, 'profile.avatar.remove', id, { by: 'admin' });
    return reply.status(204).send();
  });
}
